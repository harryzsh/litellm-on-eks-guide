# 创建 Namespace 与 RDS 初始化

> 注意：先建 Namespace，后续 IRSA 和所有资源都依赖它。

```
kubectl create namespace litellm
```

### 4.1 初始化 RDS 数据库

LiteLLM 需要 PostgreSQL 上有独立的 litellm database。连接到 RDS 后执行：

```
-- 连接到 RDS（替换为实际连接信息）
-- psql -h your-rds-endpoint -U admin -d postgres

CREATE DATABASE litellm;
CREATE USER litellm_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE litellm TO litellm_user;
```

LiteLLM 启动时会自动执行 migrations，无需手动建表。只需要空库 + 有权限的用户即可。

### 4.2 启用 EKS OIDC Provider

IRSA 依赖 OIDC Provider，全新集群必须先启用，否则 eksctl create iamserviceaccount 会报错：

```
# 检查是否已启用（有输出则已启用）
aws eks describe-cluster --name <EKS_CLUSTER_NAME> --region us-east-1 \
  --query 'cluster.identity.oidc.issuer' --output text

# 未启用则执行以下命令
eksctl utils associate-iam-oidc-provider \
  --cluster <EKS_CLUSTER_NAME> \
  --region us-east-1 \
  --approve
```

### 4.3 为私有子网添加 Internal ALB 标签

Internal ALB 要求私有子网必须有 `kubernetes.io/role/internal-elb: 1` 标签，否则 ALB Controller 无法找到子网，Ingress 会一直处于 pending 状态：

```
# 获取集群使用的子网 ID
SUBNET_IDS=$(aws eks describe-cluster --name <EKS_CLUSTER_NAME> --region us-east-1 \
  --query 'cluster.resourcesVpcConfig.subnetIds' --output json | jq -r '.[]')

# 为每个私有子网打标签（只需打给私有子网，公有子网跳过）
for SUBNET_ID in $SUBNET_IDS; do
  IS_PRIVATE=$(aws ec2 describe-subnets --subnet-ids $SUBNET_ID \
    --query 'Subnets[0].MapPublicIpOnLaunch' --output text)
  if [ "$IS_PRIVATE" == "False" ]; then
    aws ec2 create-tags --resources $SUBNET_ID \
      --tags Key=kubernetes.io/role/internal-elb,Value=1 \
             Key=kubernetes.io/cluster/<EKS_CLUSTER_NAME>,Value=shared
    echo "Tagged private subnet: $SUBNET_ID"
  fi
done
```

> ⚠️ 如果用 eksctl 建的集群，子网 tag 通常已自动打好。全新手动创建的 VPC/子网则必须手动打。
