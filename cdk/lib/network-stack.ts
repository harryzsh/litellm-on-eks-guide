import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  readonly clusterName: string;
}

/**
 * VPC + subnets + IGW + NAT (×1) + route tables.
 *
 * Subnet layout (matches source terraform/vpc.tf):
 *   public  10.0.0.0/24  (1a)  →  IGW
 *   public  10.0.1.0/24  (1b)  →  IGW
 *   private 10.0.10.0/24 (1a)  →  NAT (in 1a)
 *   private 10.0.11.0/24 (1b)  →  NAT (in 1a, cross-AZ egress)
 *
 * Discovery tags applied so EKS, AWS Load Balancer Controller,
 * and Karpenter can find subnets without manual configuration.
 *
 * `sharedNodeSecurityGroup` is created here (not in ClusterStack)
 * so that DataStack (RDS / Redis SGs) can reference it without a
 * cross-stack cycle. The EKS cluster attaches it as an additional SG.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly sharedNodeSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
          mapPublicIpOnLaunch: true,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    cdk.Tags.of(vpc).add('Name', `${props.clusterName}-vpc`);

    const clusterDiscoveryKey = `kubernetes.io/cluster/${props.clusterName}`;

    for (const subnet of vpc.publicSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/elb', '1');
      cdk.Tags.of(subnet).add(clusterDiscoveryKey, 'shared');
      cdk.Tags.of(subnet).add('Tier', 'public');
    }

    for (const subnet of vpc.privateSubnets) {
      cdk.Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
      cdk.Tags.of(subnet).add(clusterDiscoveryKey, 'shared');
      cdk.Tags.of(subnet).add('karpenter.sh/discovery', props.clusterName);
      cdk.Tags.of(subnet).add('Tier', 'private');
    }

    // Shared SG attached to EKS as additional cluster SG. RDS / Redis
    // SGs in DataStack accept ingress from this SG, avoiding a circular
    // dependency on ClusterStack.
    this.sharedNodeSecurityGroup = new ec2.SecurityGroup(this, 'SharedNodeSG', {
      vpc,
      description: 'Attached to EKS cluster; trusted by RDS / Redis',
      allowAllOutbound: true,
    });
    cdk.Tags.of(this.sharedNodeSecurityGroup).add('Name', `${props.clusterName}-shared-node`);

    this.vpc = vpc;

    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: vpc.privateSubnets.map((s) => s.subnetId).join(','),
    });
    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(','),
    });
  }
}
