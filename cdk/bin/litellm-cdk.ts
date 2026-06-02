#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ClusterStack } from '../lib/cluster-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const clusterName = (app.node.tryGetContext('clusterName') as string) || 'litellm-cluster';
const projectName = (app.node.tryGetContext('projectName') as string) || 'litellm';
const litellmImage =
  (app.node.tryGetContext('litellmImage') as string) ||
  'docker.litellm.ai/berriai/litellm:v1.83.14-stable.patch.3';

const network = new NetworkStack(app, `${projectName}-Network`, {
  env,
  clusterName,
  description: 'VPC, subnets, NAT, IGW for LiteLLM cluster',
});

const data = new DataStack(app, `${projectName}-Data`, {
  env,
  vpc: network.vpc,
  sharedNodeSecurityGroup: network.sharedNodeSecurityGroup,
  projectName,
  description: 'RDS Postgres, ElastiCache Redis, S3 logs, Secrets Manager',
});
data.addDependency(network);

const cluster = new ClusterStack(app, `${projectName}-Cluster`, {
  env,
  vpc: network.vpc,
  sharedNodeSecurityGroup: network.sharedNodeSecurityGroup,
  litellmSecret: data.litellmSecret,
  rdsSecret: data.rdsSecret,
  rdsSecurityGroup: data.rdsSecurityGroup,
  redisSecurityGroup: data.redisSecurityGroup,
  redisHost: data.redisHost,
  databaseName: data.databaseName,
  clusterName,
  projectName,
  litellmImage,
  description: 'EKS cluster, IAM, Karpenter, Helm charts, k8s manifests',
});
cluster.addDependency(data);

cdk.Tags.of(app).add('Project', projectName);
cdk.Tags.of(app).add('ManagedBy', 'cdk');
cdk.Tags.of(app).add('auto-delete', 'no');

app.synth();
