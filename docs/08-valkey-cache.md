# Valkey 缓存层

### 8.1 获取基础信息

```
VPC_ID=$(aws eks describe-cluster --name <EKS_CLUSTER_NAME> --region us-east-1 \
  --query 'cluster.resourcesVpcConfig.vpcId' --output text)

NODE_SG=$(aws ec2 describe-instances --region us-east-1 \
  --filters "Name=tag:eks:cluster-name,Values=<EKS_CLUSTER_NAME>" \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)
```

### 8.2 创建 Valkey Security Group

```
REDIS_SG=$(aws ec2 create-security-group \
  --group-name litellm-valkey-sg \
  --description "LiteLLM Valkey Security Group" \
  --vpc-id ${VPC_ID} \
  --region us-east-1 \
  --query GroupId --output text)

aws ec2 authorize-security-group-ingress \
  --group-id ${REDIS_SG} \
  --protocol tcp \
  --port 6379 \
  --source-group ${NODE_SG} \
  --region us-east-1
```

### 8.3 配置 RDS Security Group（允许 EKS 节点访问）

```
RDS_SG=$(aws rds describe-db-instances \
  --db-instance-identifier <RDS_INSTANCE_NAME> \
  --region us-east-1 \
  --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id ${RDS_SG} \
  --protocol tcp \
  --port 5432 \
  --source-group ${NODE_SG} \
  --region us-east-1
```

### 8.4 创建 ElastiCache Serverless

```
SUBNET_IDS=$(aws eks describe-cluster --name <EKS_CLUSTER_NAME> --region us-east-1 \
  --query 'cluster.resourcesVpcConfig.subnetIds' --output json | \
  python3 -c "import sys,json; subnets=json.load(sys.stdin); print(','.join(subnets[:2]))")

aws elasticache create-serverless-cache \
  --serverless-cache-name litellm-valkey \
  --engine valkey \
  --subnet-ids $(echo $SUBNET_IDS | tr ',' ' ') \
  --security-group-ids ${REDIS_SG} \
  --region us-east-1

# 等待创建完成（约5分钟）
aws elasticache describe-serverless-caches \
  --serverless-cache-name litellm-valkey \
  --region us-east-1 \
  --query 'ServerlessCaches[0].{Status:Status,Endpoint:Endpoint}'
```

> 注意：ElastiCache Serverless 强制开启 in-transit TLS，连接必须设置 ssl: true。
