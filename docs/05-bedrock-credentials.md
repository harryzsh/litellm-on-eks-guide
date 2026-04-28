# Bedrock 凭证配置

LiteLLM 使用 AWS Access Key（AKSK）调用 Bedrock，凭证通过 Secrets Manager + CSI Driver 注入，不存在代码或配置文件中。

- **IAM User：** `litellm-bedrock-user`（ARN: `arn:aws:iam::<ACCOUNT_ID>:user/litellm-bedrock-user`）

- **权限：** `LiteLLMBedrockInvokePolicy`（只允许 `bedrock:InvokeModel` 和 `bedrock:InvokeModelWithResponseStream`）

- **Secret：** `litellm/bedrock-aksk`（ARN: `arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:litellm/bedrock-aksk-xxxxx`）

```
# Step 1: 创建最小权限 IAM Policy
aws iam create-policy \
  --policy-name LiteLLMBedrockInvokePolicy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "*"
    }]
  }' \
  --region us-east-1

# Step 2: 创建 IAM User
aws iam create-user --user-name litellm-bedrock-user

# Step 3: 附加 Policy
aws iam attach-user-policy \
  --user-name litellm-bedrock-user \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/LiteLLMBedrockInvokePolicy

# Step 4: 生成 Access Key
aws iam create-access-key --user-name litellm-bedrock-user
# 记录 AccessKeyId 和 SecretAccessKey

# Step 5: 存入 Secrets Manager
aws secretsmanager create-secret \
  --name "litellm/bedrock-aksk" \
  --description "LiteLLM Bedrock AKSK" \
  --secret-string '{"AWS_ACCESS_KEY_ID":"<YOUR_AWS_ACCESS_KEY_ID>","AWS_SECRET_ACCESS_KEY":"your-secret"}' \
  --region us-east-1
```

### 附：备选方案 — 用 AKSK 替代 IRSA（适用于非 EKS 环境或客户有 AKSK 需求）

如果客户环境无法使用 IRSA（如非 EKS 部署，或客户只提供 AKSK），可改用 AWS Access Key 方式。

**Step 1：创建最小权限 IAM User / Role**

```
aws iam create-policy \
  --policy-name LiteLLMBedrockInvokePolicy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "*"
    }]
  }' \
  --region us-east-1

aws iam create-user --user-name litellm-bedrock-user
aws iam attach-user-policy \
  --user-name litellm-bedrock-user \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/LiteLLMBedrockInvokePolicy
aws iam create-access-key --user-name litellm-bedrock-user
```

**Step 2：把 AKSK 存入 Secrets Manager**

```
aws secretsmanager create-secret \
  --name "litellm/bedrock-aksk" \
  --description "LiteLLM Bedrock Access Key" \
  --secret-string '{
    "AWS_ACCESS_KEY_ID": "<YOUR_AWS_ACCESS_KEY_ID>",
    "AWS_SECRET_ACCESS_KEY": "your-secret"
  }' \
  --region us-east-1
```

**Step 3：更新 SecretProviderClass，纳入 AKSK**

```
- objectName: "litellm/bedrock-aksk"
  objectType: "secretsmanager"
  jmesPath:
    - path: AWS_ACCESS_KEY_ID
      objectAlias: aws_access_key_id
    - path: AWS_SECRET_ACCESS_KEY
      objectAlias: aws_secret_access_key
```

在 secretObjects 里加：

```
- secretName: litellm-bedrock-aksk
  type: Opaque
  data:
    - objectName: aws_access_key_id
      key: AWS_ACCESS_KEY_ID
    - objectName: aws_secret_access_key
      key: AWS_SECRET_ACCESS_KEY
```

**Step 4：values.yaml 注入 AKSK + model_list 引用**

```
environmentSecrets:
  - litellm-db-secret
  - litellm-salt-key
  - litellm-bedrock-aksk   # 新增

proxy_config:
  model_list:
    - model_name: "claude-sonnet-4-6"
      litellm_params:
        model: "bedrock/us.anthropic.claude-sonnet-4-6"
        aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID
        aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY
        aws_region_name: "us-east-1"
        rpm: 100
        tpm: 400000
```

**IRSA vs AKSK 对比：**

- **IRSA（推荐）：** 无长期凭证，自动轮换。适用 EKS 部署，团队内部环境

- **AKSK：** 需要定期手动轮换。适用非 EKS 环境，客户指定提供 AKSK

> ⚠️ 使用 AKSK 时：Key 必须存入 Secrets Manager（不能明文写进 values.yaml），且建议设置 Key 轮换策略。

### 5.1 添加 Secrets Manager 读取权限（inline policy）

CSI Driver 需要从 Secrets Manager 拉取 secrets，需要给 EKS Node Role（或 Pod 绑定的 ServiceAccount）添加 Secrets Manager 读取权限。

```
# 获取 IRSA Role 名称
ROLE_NAME=$(kubectl get serviceaccount litellm -n litellm \
  -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}' | awk -F/ '{print $NF}')
echo "IRSA Role: $ROLE_NAME"

# 添加 inline policy
aws iam put-role-policy \
  --role-name $ROLE_NAME \
  --policy-name SecretsManagerReadLitellm \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "arn:aws:secretsmanager:<region>:<ACCOUNT_ID>:secret:litellm/*"
    }]
  }' \
  --region us-east-1
```

替换 `<region>` 和 `<ACCOUNT_ID>` 为实际值。

### 5.2 Master Key 注入链路说明

```
Secrets Manager (litellm/master-key → LITELLM_MASTER_KEY)
  ↓ CSI Driver 同步
k8s secret litellm-master-key.LITELLM_MASTER_KEY
  ↓ Helm chart deployment.yaml（chart 自带，不需要改）
    - name: PROXY_MASTER_KEY
      valueFrom:
        secretKeyRef:
          name: litellm-master-key    ← masterkeySecretName
          key: LITELLM_MASTER_KEY     ← masterkeySecretKey
env var: PROXY_MASTER_KEY = "<YOUR_MASTER_KEY>"   ← 注入到 Pod
  ↓
values.yaml proxy_config 里必须写：
  master_key: os.environ/PROXY_MASTER_KEY
  ↓ chart 渲染成 ConfigMap → /etc/litellm/config.yaml
LiteLLM 读取 PROXY_MASTER_KEY 环境变量作为鉴权 master key
```

**三段缺一不可：**

- `masterkeySecretName/masterkeySecretKey`：告诉 chart 去哪个 k8s secret 取值

- `PROXY_MASTER_KEY` env var：chart 硬编码，注入到 Pod，名字不可改

- `master_key: os.environ/PROXY_MASTER_KEY`：告诉 LiteLLM 去读这个 env var 作为鉴权 key

**你只需要维护两个文件：**

- `values.yaml` — 配置 masterkeySecretName/Key、proxy_config.master_key

- `litellm-secretproviderclass.yaml` — 告诉 CSI Driver 去 Secrets Manager 取什么

- `deployment.yaml`（chart 自带）— 不需要改

- `/etc/litellm/config.yaml`（自动生成）— 不需要改

### 5.3 IRSA Role 权限清单

**Policy 1：AmazonBedrockFullAccess（Managed Policy）**

- bedrock:* / * — 调用所有 Bedrock API

- bedrock-mantle:* — Bedrock 内部服务

- kms:DescribeKey — KMS key 查询

- iam:ListRoles, ec2:Describe* — 网络/角色信息查询

- sagemaker:Create/Delete/Update/Invoke Endpoint — SageMaker 集成（可选）

- aws-marketplace:Subscribe/View/Unsubscribe — Marketplace 模型订阅

**Policy 2：SecretsManagerReadLitellm（Inline Policy）**

- secretsmanager:GetSecretValue — `arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:litellm/*`

- secretsmanager:DescribeSecret — 同上

> ⚠️ AmazonBedrockFullAccess 权限较宽泛（含 SageMaker 集成）。如需收紧，可自建 custom policy 只保留 bedrock:InvokeModel、bedrock:InvokeModelWithResponseStream。
