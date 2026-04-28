# SecretProviderClass 与 Secrets 创建

```
# litellm-secretproviderclass.yaml
# 统一管理所有 LiteLLM secrets — 2026-03-19 更新
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: litellm-secrets
  namespace: litellm
spec:
  provider: aws
  parameters:
    objects: |
      - objectName: "litellm/db"
        objectType: "secretsmanager"
        jmesPath:
          - path: database_url
            objectAlias: database_url
      - objectName: "litellm/master-key"
        objectType: "secretsmanager"
        jmesPath:
          - path: LITELLM_MASTER_KEY
            objectAlias: litellm_master_key
      - objectName: "litellm/salt-key"
        objectType: "secretsmanager"
        jmesPath:
          - path: LITELLM_SALT_KEY
            objectAlias: litellm_salt_key
      - objectName: "litellm/bedrock-aksk"
        objectType: "secretsmanager"
        jmesPath:
          - path: AWS_ACCESS_KEY_ID
            objectAlias: aws_access_key_id
          - path: AWS_SECRET_ACCESS_KEY
            objectAlias: aws_secret_access_key
  secretObjects:
    - secretName: litellm-db-secret
      type: Opaque
      data:
        - objectName: database_url
          key: DATABASE_URL
    - secretName: litellm-master-key
      type: Opaque
      data:
        - objectName: litellm_master_key
          key: LITELLM_MASTER_KEY
    - secretName: litellm-salt-key
      type: Opaque
      data:
        - objectName: litellm_salt_key
          key: LITELLM_SALT_KEY
    - secretName: litellm-bedrock-aksk
      type: Opaque
      data:
        - objectName: aws_access_key_id
          key: AWS_ACCESS_KEY_ID
        - objectName: aws_secret_access_key
          key: AWS_SECRET_ACCESS_KEY
```

```
kubectl apply -f litellm-secretproviderclass.yaml
```

**Secrets Manager 统一管理的 secrets（完整列表）：**

- `litellm/db` → database_url — PostgreSQL 连接串（可更新，重启 Pod 生效）

- `litellm/master-key` → LITELLM_MASTER_KEY — LiteLLM API 鉴权 key（可更新，重启生效）

- `litellm/salt-key` → LITELLM_SALT_KEY — Virtual Key 加密盐（⚠️ 永不可改，丢失则所有 Virtual Key 失效）

> IRSA 权限说明：IRSA Role litellm-bedrock-role 已配置 inline policy SecretsManagerReadLitellm，允许读取 `arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:litellm/*` 下所有 secrets，无需单独授权。
