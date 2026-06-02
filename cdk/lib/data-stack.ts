import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly sharedNodeSecurityGroup: ec2.ISecurityGroup;
  readonly projectName: string;
}

/**
 * RDS Postgres + ElastiCache Redis + S3 logs + Secrets Manager.
 *
 * Replicates source terraform/{rds,redis,s3,secrets-manager}.tf,
 * minus all kiro resources.
 *
 * Two Secrets Manager secrets are created:
 *   1. {projectName}/rds-master   — RDS-managed; holds host, port,
 *      dbname, username, password. Rotated by RDS, never edited.
 *   2. {projectName}/config       — manual; holds LITELLM_MASTER_KEY
 *      (auto-gen), Redis endpoint, and AKSK_{1,2} placeholders.
 *
 * The ExternalSecret in ClusterStack pulls from both and uses ESO
 * templating to build DATABASE_URL at sync time. This avoids leaking
 * the RDS password into CloudFormation state or the litellm config
 * secret directly.
 *
 * Deployer must `aws secretsmanager update-secret` to fill the AKSK
 * placeholders before LiteLLM pods can reach Bedrock.
 */
export class DataStack extends cdk.Stack {
  public readonly litellmSecret: secretsmanager.ISecret;
  public readonly rdsSecret: secretsmanager.ISecret;
  public readonly logsBucket: s3.IBucket;
  public readonly redisHost: string;
  public readonly databaseName: string;
  public readonly rdsSecurityGroup: ec2.ISecurityGroup;
  public readonly redisSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.databaseName = props.projectName;

    // ------------------------------------------------------------
    // RDS Postgres — Multi-AZ, daily backup + PITR (30 days)
    // ------------------------------------------------------------
    const rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: props.vpc,
      description: 'Allow PostgreSQL from EKS shared node SG',
      allowAllOutbound: true,
    });
    rdsSg.addIngressRule(
      props.sharedNodeSecurityGroup,
      ec2.Port.tcp(5432),
      'Postgres from EKS nodes',
    );

    const rdsInstance = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_8,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.M6G,
        ec2.InstanceSize.LARGE,
      ),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      databaseName: props.projectName,
      credentials: rds.Credentials.fromGeneratedSecret(props.projectName, {
        secretName: `${this.region}-${props.projectName}/rds-master`,
      }),
      multiAz: true,
      allocatedStorage: 100,
      maxAllocatedStorage: 500,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(30),
      preferredBackupWindow: '03:00-04:00',
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
      copyTagsToSnapshot: true,
      deletionProtection: true,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      monitoringInterval: cdk.Duration.seconds(60),
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
      autoMinorVersionUpgrade: true,
      securityGroups: [rdsSg],
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    this.rdsSecret = rdsInstance.secret!;

    // ------------------------------------------------------------
    // ElastiCache Redis 7.1 — Multi-AZ, encryption at rest
    // ------------------------------------------------------------
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: props.vpc,
      description: 'Allow Redis from EKS shared node SG',
      allowAllOutbound: true,
    });
    redisSg.addIngressRule(
      props.sharedNodeSecurityGroup,
      ec2.Port.tcp(6379),
      'Redis from EKS nodes',
    );

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: `${props.projectName} redis subnet group`,
      subnetIds: props.vpc.privateSubnets.map((s) => s.subnetId),
      cacheSubnetGroupName: `${this.region}-${props.projectName}-redis`,
    });

    const redis = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupId: `${this.region}-${props.projectName}-redis-prod`,
      replicationGroupDescription: 'LiteLLM Redis for rate limiting and routing state',
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t3.medium',
      numCacheClusters: 2,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      port: 6379,
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: false,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      securityGroupIds: [redisSg.securityGroupId],
      snapshotRetentionLimit: 3,
      snapshotWindow: '02:00-03:00',
      preferredMaintenanceWindow: 'sun:03:00-sun:04:00',
    });
    redis.addDependency(redisSubnetGroup);

    this.redisHost = redis.attrPrimaryEndPointAddress;

    // ------------------------------------------------------------
    // S3 logs bucket — lifecycle 30d→IA, 90d→Glacier, 365d→delete
    // ------------------------------------------------------------
    this.logsBucket = new s3.Bucket(this, 'LogsBucket', {
      bucketName: `${props.projectName}-logs-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'expire-old-logs',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          expiration: cdk.Duration.days(365),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------
    // Secrets Manager — litellm config secret (separate from RDS).
    //   LITELLM_MASTER_KEY:  auto-generated, never replaced.
    //   REDIS_HOST/PORT/PASSWORD:  resolved at deploy time.
    //   AKSK_{1,2}:  placeholders; deployer fills via update-secret.
    //
    // DATABASE_URL is NOT in this secret — it's built at k8s side
    // by the ExternalSecret template using both this secret and
    // the RDS-managed secret.
    // ------------------------------------------------------------
    this.litellmSecret = new secretsmanager.Secret(this, 'LitellmConfig', {
      secretName: `${this.region}-${props.projectName}/config`,
      description: 'LiteLLM proxy secrets (master key, Redis, AKSK)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          REDIS_HOST: this.redisHost,
          REDIS_PORT: '6379',
          REDIS_PASSWORD: '',
          AWS_ACCESS_KEY_ID_1: 'CHANGE_ME',
          AWS_SECRET_ACCESS_KEY_1: 'CHANGE_ME',
        }),
        generateStringKey: 'LITELLM_MASTER_KEY',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    this.rdsSecurityGroup = rdsSg;
    this.redisSecurityGroup = redisSg;

    new cdk.CfnOutput(this, 'LitellmSecretArn', { value: this.litellmSecret.secretArn });
    new cdk.CfnOutput(this, 'LitellmSecretName', { value: this.litellmSecret.secretName });
    new cdk.CfnOutput(this, 'RdsSecretArn', { value: this.rdsSecret.secretArn });
    new cdk.CfnOutput(this, 'RdsEndpoint', { value: rdsInstance.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: this.redisHost });
    new cdk.CfnOutput(this, 'LogsBucketName', { value: this.logsBucket.bucketName });
  }
}
