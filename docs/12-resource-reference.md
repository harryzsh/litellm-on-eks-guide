# 关键资源速查

- **访问地址：** `https://<YOUR_CLOUDFRONT_DOMAIN>`

- **Dashboard：** `https://<YOUR_CLOUDFRONT_DOMAIN>/ui`

- **Master Key：** `<YOUR_MASTER_KEY>`（存于 Secrets Manager）

- **CloudFront ID：** `<CLOUDFRONT_DISTRIBUTION_ID>`

- **VPC Origin ID：** `<VPC_ORIGIN_ID>`

- **EKS Cluster：** <EKS_CLUSTER_NAME>，us-east-1

- **Namespace：** litellm

- **Replicas：** 2（HPA: 2-10）

- **Helm Chart：** oci://docker.litellm.ai/berriai/litellm-helm

- **Valkey Endpoint：** `<VALKEY_ENDPOINT>:6379`

- **RDS Endpoint：** `<RDS_ENDPOINT>:5432/litellm`

- **DB Secret ARN：** `arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:litellm/db-xxxxx`

- **Master Key Secret ARN：** `arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:litellm/master-key-xxxxx`

- **Salt Key Secret ARN ⚠️ 永不可改：** `arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:litellm/salt-key-xxxxx`
