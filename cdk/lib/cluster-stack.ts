import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { KubectlV33Layer } from '@aws-cdk/lambda-layer-kubectl-v33';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface ClusterStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly sharedNodeSecurityGroup: ec2.ISecurityGroup;
  readonly litellmSecret: secretsmanager.ISecret;
  readonly rdsSecret: secretsmanager.ISecret;
  readonly redisHost: string;
  readonly databaseName: string;
  readonly clusterName: string;
  readonly projectName: string;
  readonly litellmImage: string;
}

/**
 * EKS cluster + IAM (Karpenter / aws-lbc / external-secrets IRSA)
 *   + Helm charts (external-secrets / aws-lbc / Karpenter)
 *   + k8s manifests (litellm namespace, configmap, deploy, svc, ing,
 *     hpa, pdb, ESO ClusterSecretStore + ExternalSecret, EC2NodeClass,
 *     NodePool).
 *
 * Replicates source terraform/{eks,karpenter,secrets-manager}.tf
 * and k8s/{00-05,20-21}.yaml, minus all kiro resources and the
 * `kiro-gateway-secrets` envFrom on the litellm Deployment.
 *
 * Deploy order (CDK dependencies handle this):
 *   1. EKS cluster + OIDC provider
 *   2. MNG (system nodes, t3.medium x2 + CriticalAddonsOnly taint)
 *   3. AwsCustomResource: tag MNG ASG with auto-delete=no propagated
 *      (EKS does not propagate nodegroup-level tags to ASG/EC2)
 *   4. AwsCustomResource: tag cluster SG with karpenter.sh/discovery
 *      (cluster SG is EKS-managed, not CDK-owned)
 *   5. IRSA roles + Karpenter node role + access entry
 *   6. Helm: external-secrets, aws-lbc, karpenter (parallel-ish; CDK
 *      sequences via dependencies)
 *   7. Manifests: namespace, ESO store, configmap, deploy, svc, ing,
 *      hpa, pdb, EC2NodeClass, NodePool — each with addDependency on
 *      the controller that owns its CRDs
 */
export class ClusterStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);

    // ============================================================
    // 1. EKS cluster
    // ============================================================
    const cluster = new eks.Cluster(this, 'Cluster', {
      version: eks.KubernetesVersion.V1_33,
      kubectlLayer: new KubectlV33Layer(this, 'KubectlLayer'),
      clusterName: props.clusterName,
      vpc: props.vpc,
      vpcSubnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PUBLIC },
      ],
      defaultCapacity: 0,
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
      securityGroup: props.sharedNodeSecurityGroup as ec2.SecurityGroup,
    });
    this.cluster = cluster;

    // ============================================================
    // 2. EKS Managed Nodegroup — system nodes
    //    t3.medium × 2, CriticalAddonsOnly taint.
    //    Business workloads must NOT schedule here.
    // ============================================================
    const nodegroupName = `${props.projectName}-nodes`;
    const mng = cluster.addNodegroupCapacity('SystemNodegroup', {
      nodegroupName: nodegroupName,
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM)],
      minSize: 2,
      maxSize: 2,
      desiredSize: 2,
      diskSize: 20,
      capacityType: eks.CapacityType.ON_DEMAND,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      taints: [
        {
          key: 'CriticalAddonsOnly',
          value: 'true',
          effect: eks.TaintEffect.NO_SCHEDULE,
        },
      ],
      tags: {
        'auto-delete': 'no',
        Project: props.projectName,
        Name: `${props.projectName}-nodes`,
      },
    });

    // ============================================================
    // 3. AwsCustomResource: propagate auto-delete=no to MNG ASG.
    //    EKS does NOT push nodegroup tags down to the ASG, so SpringClean
    //    (or any tag-driven cleanup) won't see the protection unless we
    //    set it directly on the ASG with PropagateAtLaunch=true.
    //    See incident 2026-05-14: ASG tag missing -> nodes stopped.
    // ============================================================
    const tagAsg = new AwsCustomResource(this, 'TagSystemAsg', {
      onCreate: {
        service: 'EKS',
        action: 'describeNodegroup',
        parameters: {
          clusterName: props.clusterName,
          nodegroupName: nodegroupName,
        },
        physicalResourceId: PhysicalResourceId.of(`tag-${nodegroupName}-asg`),
      },
      onUpdate: {
        service: 'EKS',
        action: 'describeNodegroup',
        parameters: {
          clusterName: props.clusterName,
          nodegroupName: nodegroupName,
        },
        physicalResourceId: PhysicalResourceId.of(`tag-${nodegroupName}-asg`),
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['eks:DescribeNodegroup', 'autoscaling:CreateOrUpdateTags'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    tagAsg.node.addDependency(mng);

    // The describe returns ASG name; chain a second AwsCustomResource that
    // takes that ARN and writes the propagated tag. We can't fully chain
    // outputs here without a Lambda, so use the response token approach:
    // describeNodegroup result has resources.autoScalingGroups[0].name.
    const asgName = tagAsg.getResponseField('nodegroup.resources.autoScalingGroups.0.name');

    const writeAsgTag = new AwsCustomResource(this, 'WriteAsgPropagatedTag', {
      onCreate: {
        service: 'AutoScaling',
        action: 'createOrUpdateTags',
        parameters: {
          Tags: [
            {
              Key: 'auto-delete',
              Value: 'no',
              PropagateAtLaunch: true,
              ResourceId: asgName,
              ResourceType: 'auto-scaling-group',
            },
          ],
        },
        physicalResourceId: PhysicalResourceId.of(`asg-tag-${nodegroupName}`),
      },
      onUpdate: {
        service: 'AutoScaling',
        action: 'createOrUpdateTags',
        parameters: {
          Tags: [
            {
              Key: 'auto-delete',
              Value: 'no',
              PropagateAtLaunch: true,
              ResourceId: asgName,
              ResourceType: 'auto-scaling-group',
            },
          ],
        },
        physicalResourceId: PhysicalResourceId.of(`asg-tag-${nodegroupName}`),
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['autoscaling:CreateOrUpdateTags'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    writeAsgTag.node.addDependency(tagAsg);

    // ============================================================
    // 3.5. metrics-server EKS Addon
    //      Required for HPA (metrics.k8s.io API) and `kubectl top`.
    //      EKS does NOT preinstall this. HPA targets memory/cpu
    //      utilization will show <unknown> without it.
    //      Pinned version compatible with K8s 1.33/1.34.
    // ============================================================
    const metricsServerAddon = new eks.Addon(this, 'MetricsServerAddon', {
      cluster,
      addonName: 'metrics-server',
      addonVersion: 'v0.8.1-eksbuild.6',
    });
    metricsServerAddon.node.addDependency(mng);

    // ============================================================
    // 4. Tag cluster SG with karpenter.sh/discovery so EC2NodeClass
    //    securityGroupSelectorTerms can find it. The cluster SG is
    //    created by EKS, not CDK, so we use a custom resource to tag.
    // ============================================================
    const tagClusterSg = new AwsCustomResource(this, 'TagClusterSgForKarpenter', {
      onCreate: {
        service: 'EC2',
        action: 'createTags',
        parameters: {
          Resources: [cluster.clusterSecurityGroupId],
          Tags: [
            { Key: 'karpenter.sh/discovery', Value: props.clusterName },
          ],
        },
        physicalResourceId: PhysicalResourceId.of(`tag-cluster-sg-${cluster.clusterName}`),
      },
      onUpdate: {
        service: 'EC2',
        action: 'createTags',
        parameters: {
          Resources: [cluster.clusterSecurityGroupId],
          Tags: [
            { Key: 'karpenter.sh/discovery', Value: props.clusterName },
          ],
        },
        physicalResourceId: PhysicalResourceId.of(`tag-cluster-sg-${cluster.clusterName}`),
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['ec2:CreateTags'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    // ============================================================
    // 5. IAM roles
    // ============================================================

    // 5a. Karpenter node role (attached to EC2 instances Karpenter creates)
    const karpenterNodeRole = new iam.Role(this, 'KarpenterNodeRole', {
      roleName: `${props.projectName}-karpenter-node`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    new iam.CfnInstanceProfile(this, 'KarpenterNodeInstanceProfile', {
      instanceProfileName: `${props.projectName}-karpenter-node`,
      roles: [karpenterNodeRole.roleName],
    });

    // EKS access entry so Karpenter-launched nodes can register
    new eks.AccessEntry(this, 'KarpenterNodeAccessEntry', {
      cluster,
      principal: karpenterNodeRole.roleArn,
      accessEntryType: eks.AccessEntryType.EC2_LINUX,
      accessPolicies: [],
    });

    // 5b. Karpenter controller IRSA
    const karpenterPolicyTemplate = fs.readFileSync(
      path.join(__dirname, 'policies', 'karpenter-controller-policy.json'),
      'utf8',
    );
    const karpenterPolicyJson = karpenterPolicyTemplate
      .replace(/\$\{REGION\}/g, this.region)
      .replace(/\$\{CLUSTER_NAME\}/g, props.clusterName)
      .replace(/\$\{NODE_ROLE_ARN\}/g, karpenterNodeRole.roleArn)
      .replace(
        /\$\{CLUSTER_ARN\}/g,
        `arn:aws:eks:${this.region}:${this.account}:cluster/${props.clusterName}`,
      );
    const karpenterPolicyDoc = iam.PolicyDocument.fromJson(JSON.parse(karpenterPolicyJson));

    // Pre-create namespaces for SAs (helm chart createNamespace would happen
     // too late — IRSA SA creation runs before helm install in CDK).
    const karpenterNs = cluster.addManifest('KarpenterNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'karpenter' },
    });
    const esoNs = cluster.addManifest('ExternalSecretsNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'external-secrets' },
    });

    const karpenterControllerSa = cluster.addServiceAccount('KarpenterControllerSa', {
      name: 'karpenter',
      namespace: 'karpenter',
    });
    karpenterControllerSa.node.addDependency(karpenterNs);
    new iam.Policy(this, 'KarpenterControllerPolicy', {
      policyName: `${props.projectName}-karpenter-controller`,
      document: karpenterPolicyDoc,
      roles: [karpenterControllerSa.role],
    });

    // 5c. AWS Load Balancer Controller IRSA
    const albPolicyJson = fs.readFileSync(
      path.join(__dirname, 'policies', 'alb-controller-policy.json'),
      'utf8',
    );
    const albPolicyDoc = iam.PolicyDocument.fromJson(JSON.parse(albPolicyJson));

    const albControllerSa = cluster.addServiceAccount('AlbControllerSa', {
      name: 'aws-load-balancer-controller',
      namespace: 'kube-system',
    });
    new iam.Policy(this, 'AlbControllerPolicy', {
      policyName: `${props.projectName}-lb-controller`,
      document: albPolicyDoc,
      roles: [albControllerSa.role],
    });

    // 5d. External Secrets IRSA
    const esoSa = cluster.addServiceAccount('ExternalSecretsSa', {
      name: 'external-secrets',
      namespace: 'external-secrets',
    });
    esoSa.node.addDependency(esoNs);
    props.litellmSecret.grantRead(esoSa);
    props.rdsSecret.grantRead(esoSa);

    // ============================================================
    // 6. Helm charts
    //    Order: external-secrets first (other manifests depend on it),
    //    then aws-lbc (ingress depends on it),
    //    then karpenter (nodepool/nodeclass depend on it).
    // ============================================================
    const externalSecretsChart = cluster.addHelmChart('ExternalSecrets', {
      chart: 'external-secrets',
      repository: 'https://charts.external-secrets.io',
      release: 'external-secrets',
      version: '0.10.7', // helm chart version (app version is v0.10.x)
      namespace: 'external-secrets',
      createNamespace: false,
      wait: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        installCRDs: true,
        replicaCount: 1,
        serviceAccount: {
          create: false,
          name: 'external-secrets',
        },
        // Tolerate CriticalAddonsOnly taint so pods can schedule on system MNG.
        tolerations: [
          {
            key: 'CriticalAddonsOnly',
            operator: 'Exists',
          },
        ],
        webhook: {
          replicaCount: 1,
          tolerations: [
            {
              key: 'CriticalAddonsOnly',
              operator: 'Exists',
            },
          ],
        },
        certController: {
          replicaCount: 1,
          tolerations: [
            {
              key: 'CriticalAddonsOnly',
              operator: 'Exists',
            },
          ],
        },
      },
    });
    // Helm install must wait until SA exists, otherwise it would create one.
    externalSecretsChart.node.addDependency(esoSa);

    const albControllerChart = cluster.addHelmChart('AwsLoadBalancerController', {
      chart: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      release: 'aws-load-balancer-controller',
      version: '1.13.0', // matches app v3.3.0 controller image
      namespace: 'kube-system',
      wait: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        clusterName: props.clusterName,
        // AL2023 lowers the IMDS hop limit to 1 by default which blocks ALB
        // controller's IMDS-based VPC discovery. Pass vpcId + region explicitly
        // so the controller never falls back to IMDS.
        vpcId: props.vpc.vpcId,
        region: cdk.Stack.of(this).region,
        serviceAccount: {
          create: false,
          name: 'aws-load-balancer-controller',
        },
        // Avoid noisy default webhook on managed nodes during early cluster init.
        enableServiceMutatorWebhook: false,
        // Single replica reduces resource pressure on the 2x t3.medium system MNG.
        replicaCount: 1,
        // System nodes are tainted CriticalAddonsOnly; ALB controller must tolerate
        // it to schedule, otherwise webhook has no endpoints and ingress creation
        // fails before karpenter has a chance to provision worker nodes.
        tolerations: [
          {
            key: 'CriticalAddonsOnly',
            operator: 'Exists',
          },
        ],
      },
    });
    albControllerChart.node.addDependency(albControllerSa);
    albControllerChart.node.addDependency(mng);

    const karpenterChart = cluster.addHelmChart('Karpenter', {
      chart: 'karpenter',
      // OCI registry: repository must include the namespace; full ref becomes
      // public.ecr.aws/karpenter/karpenter:1.5.0
      repository: 'oci://public.ecr.aws/karpenter/karpenter',
      release: 'karpenter',
      version: '1.5.0',
      namespace: 'karpenter',
      createNamespace: false,
      values: {
        settings: {
          clusterName: props.clusterName,
          clusterEndpoint: cluster.clusterEndpoint,
          // No SQS interruption queue — matches source environment.
          interruptionQueue: '',
        },
        serviceAccount: {
          create: false,
          name: 'karpenter',
        },
        controller: {
          resources: {
            requests: { cpu: '200m', memory: '512Mi' },
            limits: { cpu: '1', memory: '1Gi' },
          },
        },
        // Karpenter pods must not run on Karpenter-provisioned nodes
        // (anti-self-eviction); managed nodegroup taint must be tolerated.
        tolerations: [
          {
            key: 'CriticalAddonsOnly',
            operator: 'Exists',
          },
        ],
      },
    });
    karpenterChart.node.addDependency(karpenterControllerSa);
    karpenterChart.node.addDependency(mng);
    karpenterChart.node.addDependency(tagClusterSg);

    // ============================================================
    // 7. k8s manifests (namespace, ESO, configmap, app, ingress,
    //    hpa, pdb, Karpenter EC2NodeClass + NodePool).
    // ============================================================
    addLitellmManifests(this, cluster, {
      ...props,
      externalSecretsChart,
      albControllerChart,
      karpenterChart,
      karpenterNodeRoleName: karpenterNodeRole.roleName,
      esoServiceAccountName: 'external-secrets',
    });

    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ClusterEndpoint', { value: cluster.clusterEndpoint });
    new cdk.CfnOutput(this, 'UpdateKubeconfigCommand', {
      value: `aws eks update-kubeconfig --name ${cluster.clusterName} --region ${this.region}`,
    });
  }
}

// ============================================================
// Manifest helper — separated for readability
// ============================================================
interface ManifestProps extends ClusterStackProps {
  externalSecretsChart: eks.HelmChart;
  albControllerChart: eks.HelmChart;
  karpenterChart: eks.HelmChart;
  karpenterNodeRoleName: string;
  esoServiceAccountName: string;
}

function addLitellmManifests(scope: Construct, cluster: eks.Cluster, props: ManifestProps) {
  const ns = 'litellm';

  // 1. namespace
  const namespace = cluster.addManifest('LitellmNamespace', {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: ns },
  });

  // 2. ClusterSecretStore (uses ESO IRSA SA via JWT auth)
  const clusterSecretStore = cluster.addManifest('AwsSecretsManagerStore', {
    apiVersion: 'external-secrets.io/v1beta1',
    kind: 'ClusterSecretStore',
    metadata: { name: 'aws-secrets-manager' },
    spec: {
      provider: {
        aws: {
          service: 'SecretsManager',
          region: cdk.Stack.of(scope).region,
          auth: {
            jwt: {
              serviceAccountRef: {
                name: props.esoServiceAccountName,
                namespace: 'external-secrets',
              },
            },
          },
        },
      },
    },
  });
  clusterSecretStore.node.addDependency(props.externalSecretsChart);

  // 3. ExternalSecret — pulls litellm/config + rds-master secrets and
  //    builds DATABASE_URL via templating.
  const externalSecret = cluster.addManifest('LitellmExternalSecret', {
    apiVersion: 'external-secrets.io/v1beta1',
    kind: 'ExternalSecret',
    metadata: { name: 'litellm-secrets', namespace: ns },
    spec: {
      refreshInterval: '1h',
      secretStoreRef: { name: 'aws-secrets-manager', kind: 'ClusterSecretStore' },
      target: {
        name: 'litellm-secrets',
        creationPolicy: 'Owner',
        template: {
          engineVersion: 'v2',
          data: {
            LITELLM_MASTER_KEY: '{{ .config.LITELLM_MASTER_KEY }}',
            REDIS_HOST: '{{ .config.REDIS_HOST }}',
            REDIS_PORT: '{{ .config.REDIS_PORT }}',
            REDIS_PASSWORD: '{{ .config.REDIS_PASSWORD }}',
            AWS_ACCESS_KEY_ID_1: '{{ .config.AWS_ACCESS_KEY_ID_1 }}',
            AWS_SECRET_ACCESS_KEY_1: '{{ .config.AWS_SECRET_ACCESS_KEY_1 }}',
            AWS_ACCESS_KEY_ID_2: '{{ .config.AWS_ACCESS_KEY_ID_2 }}',
            AWS_SECRET_ACCESS_KEY_2: '{{ .config.AWS_SECRET_ACCESS_KEY_2 }}',
            // Built from RDS-managed secret. host/port/username/password
            // are RDS managed; database name is templated in.
            DATABASE_URL: `postgresql://{{ .rds.username }}:{{ .rds.password }}@{{ .rds.host }}:{{ .rds.port }}/${props.databaseName}`,
          },
        },
      },
      dataFrom: [
        {
          extract: {
            key: props.litellmSecret.secretName,
          },
          rewrite: [{ regexp: { source: '(.*)', target: 'config.$1' } }],
        },
        {
          extract: {
            key: props.rdsSecret.secretName,
          },
          rewrite: [{ regexp: { source: '(.*)', target: 'rds.$1' } }],
        },
      ],
    },
  });
  externalSecret.node.addDependency(clusterSecretStore);
  externalSecret.node.addDependency(namespace);

  // 4. ConfigMap (litellm config.yaml)
  const litellmConfigYaml = fs.readFileSync(
    path.join(__dirname, 'manifests', 'litellm-config.yaml'),
    'utf8',
  );
  const configMap = cluster.addManifest('LitellmConfigMap', {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'litellm-config', namespace: ns },
    data: { 'config.yaml': litellmConfigYaml },
  });
  configMap.node.addDependency(namespace);

  // 5. Service
  const service = cluster.addManifest('LitellmService', {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'litellm', namespace: ns },
    spec: {
      type: 'ClusterIP',
      selector: { app: 'litellm' },
      ports: [{ name: 'http', port: 4000, targetPort: 4000, protocol: 'TCP' }],
    },
  });
  service.node.addDependency(namespace);

  // 6. Deployment (kiro envFrom removed; image from context)
  const deployment = cluster.addManifest('LitellmDeployment', {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'litellm', namespace: ns },
    spec: {
      replicas: 2,
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
      },
      selector: { matchLabels: { app: 'litellm' } },
      template: {
        metadata: {
          labels: { app: 'litellm' },
          annotations: {
            'instrumentation.opentelemetry.io/inject-python': 'false',
            'instrumentation.opentelemetry.io/inject-java': 'false',
            'instrumentation.opentelemetry.io/inject-nodejs': 'false',
            'instrumentation.opentelemetry.io/inject-dotnet': 'false',
          },
        },
        spec: {
          terminationGracePeriodSeconds: 60,
          nodeSelector: { 'provisioned-by': 'karpenter' },
          topologySpreadConstraints: [
            {
              maxSkew: 1,
              topologyKey: 'topology.kubernetes.io/zone',
              whenUnsatisfiable: 'DoNotSchedule',
              labelSelector: { matchLabels: { app: 'litellm' } },
            },
            {
              maxSkew: 1,
              topologyKey: 'kubernetes.io/hostname',
              whenUnsatisfiable: 'DoNotSchedule',
              labelSelector: { matchLabels: { app: 'litellm' } },
            },
          ],
          containers: [
            {
              name: 'litellm',
              image: props.litellmImage,
              imagePullPolicy: 'IfNotPresent',
              args: [
                '--config',
                '/app/config.yaml',
                '--port',
                '4000',
                '--num_workers',
                '4',
                '--run_gunicorn',
              ],
              ports: [
                { name: 'http', containerPort: 4000 },
                { name: 'health', containerPort: 8001 },
              ],
              envFrom: [{ secretRef: { name: 'litellm-secrets' } }],
              env: [
                { name: 'LITELLM_LOG', value: 'ERROR' },
                { name: 'LITELLM_LOCAL_MODEL_COST_MAP', value: 'True' },
                { name: 'MAX_REQUESTS_BEFORE_RESTART', value: '10000' },
              ],
              resources: {
                requests: { cpu: '200m', memory: '5Gi' },
                limits: { cpu: '1500m', memory: '6Gi' },
              },
              livenessProbe: {
                httpGet: { path: '/health/liveliness', port: 4000 },
                initialDelaySeconds: 60,
                periodSeconds: 15,
                timeoutSeconds: 5,
                failureThreshold: 3,
              },
              startupProbe: {
                httpGet: { path: '/health/readiness', port: 4000 },
                periodSeconds: 10,
                timeoutSeconds: 5,
                failureThreshold: 30, // 30 × 10s = 5 min startup window
              },
              readinessProbe: {
                httpGet: { path: '/health/readiness', port: 4000 },
                initialDelaySeconds: 0,
                periodSeconds: 5,
                timeoutSeconds: 5,
                failureThreshold: 3,
              },
              volumeMounts: [
                {
                  name: 'config',
                  mountPath: '/app/config.yaml',
                  subPath: 'config.yaml',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [{ name: 'config', configMap: { name: 'litellm-config' } }],
        },
      },
    },
  });
  deployment.node.addDependency(configMap);
  deployment.node.addDependency(externalSecret);

  // 7. Ingress (internal ALB)
  const ingress = cluster.addManifest('LitellmIngress', {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: 'litellm',
      namespace: ns,
      annotations: {
        'kubernetes.io/ingress.class': 'alb',
        'alb.ingress.kubernetes.io/scheme': 'internal',
        'alb.ingress.kubernetes.io/target-type': 'ip',
        'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP": 80}]',
        'alb.ingress.kubernetes.io/healthcheck-path': '/health/readiness',
        'alb.ingress.kubernetes.io/healthcheck-port': '4000',
        'alb.ingress.kubernetes.io/healthy-threshold-count': '2',
        'alb.ingress.kubernetes.io/unhealthy-threshold-count': '3',
        'alb.ingress.kubernetes.io/tags': `auto-delete=no,Project=${props.projectName},ManagedBy=cdk`,
      },
    },
    spec: {
      rules: [
        {
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: 'litellm', port: { number: 4000 } } },
              },
            ],
          },
        },
      ],
    },
  });
  ingress.node.addDependency(props.albControllerChart);
  ingress.node.addDependency(service);

  // 8. HPA + PDB
  const hpa = cluster.addManifest('LitellmHpa', {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name: 'litellm', namespace: ns },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'litellm' },
      minReplicas: 2,
      maxReplicas: 10,
      metrics: [
        // litellm is a streaming LLM proxy: memory grows with active SSE
        // connections (10-100MB/stream) and concurrent request buffers,
        // while CPU stays low during async I/O wait.
        // Keep BOTH signals — HPA scales on whichever fires first (max).
        //
        // Memory request is sized at 5Gi (well above ~2.5Gi baseline) so
        // idle utilization sits at ~50%, leaving real headroom for
        // load-driven memory growth to actually move the HPA metric.
        // Without that headroom, baseline alone saturates the target and
        // HPA never fires (observed empirically with 3.2Gi request).
        //
        // CPU target lowered to 60% (vs default 70%) so HPA reacts before
        // pods are CPU-throttled during the 30-60s pod startup window.
        { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 60 } } },
        { type: 'Resource', resource: { name: 'memory', target: { type: 'Utilization', averageUtilization: 80 } } },
      ],
      behavior: {
        scaleUp: {
          stabilizationWindowSeconds: 30,
          policies: [
            { type: 'Percent', value: 100, periodSeconds: 30 },
            { type: 'Pods', value: 4, periodSeconds: 30 },
          ],
          selectPolicy: 'Max',
        },
        scaleDown: {
          stabilizationWindowSeconds: 300,
          policies: [{ type: 'Percent', value: 50, periodSeconds: 60 }],
        },
      },
    },
  });
  hpa.node.addDependency(deployment);

  const pdb = cluster.addManifest('LitellmPdb', {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: 'litellm', namespace: ns },
    spec: { minAvailable: 1, selector: { matchLabels: { app: 'litellm' } } },
  });
  pdb.node.addDependency(deployment);

  // 9. Karpenter EC2NodeClass + NodePool — must wait until Karpenter
  //    helm install completes (CRDs registered).
  const ec2NodeClass = cluster.addManifest('Ec2NodeClass', {
    apiVersion: 'karpenter.k8s.aws/v1',
    kind: 'EC2NodeClass',
    metadata: { name: 'default' },
    spec: {
      amiFamily: 'AL2023',
      amiSelectorTerms: [{ alias: 'al2023@latest' }],
      role: props.karpenterNodeRoleName,
      subnetSelectorTerms: [{ tags: { 'karpenter.sh/discovery': props.clusterName } }],
      securityGroupSelectorTerms: [{ tags: { 'karpenter.sh/discovery': props.clusterName } }],
      tags: {
        'karpenter.sh/discovery': props.clusterName,
        'auto-delete': 'no',
      },
    },
  });
  ec2NodeClass.node.addDependency(props.karpenterChart);

  const nodePool = cluster.addManifest('NodePool', {
    apiVersion: 'karpenter.sh/v1',
    kind: 'NodePool',
    metadata: { name: 'default' },
    spec: {
      template: {
        metadata: { labels: { 'provisioned-by': 'karpenter' } },
        spec: {
          nodeClassRef: {
            group: 'karpenter.k8s.aws',
            kind: 'EC2NodeClass',
            name: 'default',
          },
          requirements: [
            { key: 'kubernetes.io/arch', operator: 'In', values: ['amd64'] },
            { key: 'kubernetes.io/os', operator: 'In', values: ['linux'] },
            { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] },
            { key: 'karpenter.k8s.aws/instance-family', operator: 'In', values: ['m6i', 'c6i'] },
            { key: 'karpenter.k8s.aws/instance-size', operator: 'In', values: ['large', 'xlarge', '2xlarge'] },
          ],
          expireAfter: '720h',
        },
      },
      limits: { cpu: 32, memory: '128Gi' },
      disruption: {
        consolidationPolicy: 'WhenEmptyOrUnderutilized',
        consolidateAfter: '30m',
      },
    },
  });
  nodePool.node.addDependency(ec2NodeClass);

  // Suppress unused-import warning
  void yaml;
}
