# Secrets Store CSI Driver

使用 CSI Driver 从 AWS Secrets Manager 自动挂载密钥，避免明文存储在 etcd。

```
helm repo add secrets-store-csi-driver https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts
helm install csi-secrets-store secrets-store-csi-driver/secrets-store-csi-driver \
  --namespace kube-system \
  --set syncSecret.enabled=true

# 安装 AWS Provider
kubectl apply -f https://raw.githubusercontent.com/aws/secrets-store-csi-driver-provider-aws/main/deployment/aws-provider-installer.yaml
```

### 7.0 创建 Secrets Manager secrets

在 apply SecretProviderClass 之前，需要先在 AWS Secrets Manager 里创建对应的 secrets：

```
# 1. DB 连接串（替换为实际 RDS 连接信息）
aws secretsmanager create-secret \
  --name "litellm/db" \
  --description "LiteLLM PostgreSQL connection string" \
  --secret-string '{"database_url":"postgresql://litellm_user:your_password@your-rds-endpoint:5432/litellm"}' \
  --region us-east-1

# 2. Master Key（自定义，建议 sk- 开头 + 随机字符串）
aws secretsmanager create-secret \
  --name "litellm/master-key" \
  --description "LiteLLM Master Key" \
  --secret-string '{"LITELLM_MASTER_KEY":"<YOUR_MASTER_KEY>"}' \
  --region us-east-1

# 3. Salt Key（⚠️ 部署后永不可改！用于加密 Virtual Keys，丢失则所有 Virtual Key 失效）
SALT_KEY="sk-$(openssl rand -hex 32)"
aws secretsmanager create-secret \
  --name "litellm/salt-key" \
  --description "LiteLLM Salt Key - 永不可改" \
  --secret-string "{\"LITELLM_SALT_KEY\":\"${SALT_KEY}\"}" \
  --region us-east-1
echo "Salt Key: $SALT_KEY"  # 请务必备份到安全的地方！
```

**Secret 格式说明：**

- `litellm/db` → JSON key: `database_url` — PostgreSQL 连接串

- `litellm/master-key` → JSON key: `LITELLM_MASTER_KEY` — LiteLLM API 鉴权 key，建议 sk- 开头

> ⚠️ JSON key 名称必须与 SecretProviderClass 里的 jmesPath.path 完全一致，否则 CSI Driver 无法正确解析。
