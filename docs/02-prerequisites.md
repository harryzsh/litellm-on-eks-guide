# 前置条件

- AWS CLI 已配置（us-east-1 权限：EKS、ECR、ALB、CloudFront、ElastiCache、RDS、Bedrock、IAM）

- kubectl 已安装

- eksctl 已安装

- helm v3.8.0+ 已安装

- 已有 EKS cluster（<EKS_CLUSTER_NAME>）

- 已有 RDS PostgreSQL（<RDS_INSTANCE_NAME>，database: litellm）

推荐配置：

- EKS 节点：按实际负载选择实例规格（生产环境建议至少 2 节点以配合 HA）

- RDS PostgreSQL：按业务负载选择实例规格，生产环境建议启用 Multi-AZ

- 生产环境建议 `replicaCount: 2` + PDB `minAvailable: 1`
