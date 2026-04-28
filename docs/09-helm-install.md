# Helm 部署 LiteLLM

### 9.1 拉取官方 Helm Chart

```
helm pull oci://docker.litellm.ai/berriai/litellm-helm
tar -zxvf litellm-helm-*.tgz

helm show values ./litellm-helm | head -30
```

### 9.2 values.yaml

> ⚠️ 版本说明：image.tag: "v1.83.3-stable" 是当前已验证的版本。新环境部署时建议先确认最新 stable tag。

> ⚠️ **Router 连 Valkey 必须用 ****`redis_url: rediss://...`****（注意两个 s = TLS），不要用 ****`redis_host`**** + ****`redis_port`****。** ElastiCache Serverless 强制 in-transit TLS，router 层如果用 `redis_host/redis_port` 会走明文 TCP，Serverless 直接 reset connection，表现是 Pod 启动报 `ConnectionResetError`、跨 Pod rate limit/cooldown 同步失效。`litellm_settings.cache_params` 可以继续用 `host + port + ssl: true`（Response Cache 路径是独立实现），但 router 路径**必须**用 `redis_url` + `rediss://` schema。验证方式：`kubectl logs -n litellm <pod> | grep -iE "redis|valkey"`，看到 `Connected to redis` 日志（LiteLLM 客户端日志用的是 Python redis-py 库，字符串是 "redis"）且无 `ConnectionResetError` / `SSL` 报错即 OK。

```
# LiteLLM Helm values — <EKS_CLUSTER_NAME> us-east-1
replicaCount: 2

image:
  repository: docker.litellm.ai/berriai/litellm
  tag: "v1.83.3-stable"
  pullPolicy: IfNotPresent

nameOverride: "litellm"
fullnameOverride: ""

serviceAccount:
  create: false
  name: "litellm"

# Master Key 通过 Secret 传入
masterkeySecretName: "litellm-master-key"
masterkeySecretKey: "LITELLM_MASTER_KEY"

environmentSecrets:
  - litellm-db-secret
  - litellm-salt-key
  - litellm-bedrock-aksk

db:
  deployStandalone: false

postgresql:
  enabled: false

redis:
  enabled: false

extraEnv:
  - name: LITELLM_LOG
    value: "ERROR"
  - name: LITELLM_LOCAL_MODEL_COST_MAP
    value: "True"
  - name: SEPARATE_HEALTH_APP
    value: "1"
  - name: MAX_REQUESTS_BEFORE_RESTART
    value: "10000"

proxy_config:
  general_settings:
    master_key: os.environ/PROXY_MASTER_KEY
    database_url: os.environ/DATABASE_URL
    store_model_in_db: true
    proxy_batch_write_at: 60
    database_connection_pool_limit: 10
    database_connection_timeout: 60
    disable_error_logs: true
    allow_requests_on_db_unavailable: true

  model_list:
    - model_name: "claude-sonnet-4-6"
      litellm_params:
        model: "bedrock/us.anthropic.claude-sonnet-4-6"
        aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID
        aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY
        aws_region_name: "us-east-1"
        rpm: 100
        tpm: 400000
        max_parallel_requests: 20

    - model_name: "claude-opus-4-6"
      litellm_params:
        model: "bedrock/us.anthropic.claude-opus-4-6-v1"
        aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID
        aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY
        aws_region_name: "us-east-1"
        rpm: 50
        tpm: 200000
        max_parallel_requests: 10

    - model_name: "claude-haiku-3-5"
      litellm_params:
        model: "bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0"
        aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID
        aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY
        aws_region_name: "us-east-1"
        rpm: 200
        tpm: 800000
        max_parallel_requests: 50

  router_settings:
    routing_strategy: simple-shuffle
    # ⚠️ ElastiCache Serverless 强制 TLS，必须用 rediss:// (两个 s) 而不是 redis_host/redis_port
    # 用 redis_host + redis_port 会走明文 TCP → Serverless 直接 reset connection
    redis_url: "rediss://<VALKEY_ENDPOINT>:6379"
    num_retries: 3
    timeout: 600
    enable_pre_call_checks: true
    allowed_fails: 3
    cooldown_time: 30

  litellm_settings:
    drop_params: true
    additional_drop_params:
      - vector_store_ids
      - vector_store_id
    set_verbose: false
    num_retries: 3
    request_timeout: 600
    json_logs: true
    fallbacks:
      - {"claude-sonnet-4-6": ["claude-haiku-3-5"]}
    cache: true
    cache_params:
      type: "redis"
      host: "<VALKEY_ENDPOINT>"
      port: 6379
      ssl: true
      ssl_cert_reqs: null
      ssl_check_hostname: false
      supported_call_types: []
    success_callback: ["s3"]
    s3_callback_params:
      s3_bucket_name: "litellm-logs-<ACCOUNT_ID>"
      s3_region_name: "us-east-1"
      s3_path: "litellm-logs/"
      s3_use_team_prefix: true
      s3_use_key_prefix: true

service:
  type: ClusterIP
  port: 4000

ingress:
  enabled: true
  className: "alb"
  annotations:
    alb.ingress.kubernetes.io/scheme: internal
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/healthcheck-path: /health/liveliness
  hosts:
    - host: ""
      paths:
        - path: /
          pathType: Prefix
  tls: []

resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "2000m"
    memory: "2Gi"

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

podDisruptionBudget:
  enabled: true
  minAvailable: 1

volumes:
  - name: secrets-store
    csi:
      driver: secrets-store.csi.k8s.io
      readOnly: true
      volumeAttributes:
        secretProviderClass: litellm-secrets

volumeMounts:
  - name: secrets-store
    mountPath: /mnt/secrets
    readOnly: true
```

### 9.2.1 扩展：多账号 / 多 Region 配置

当需要接入多个 AWS 账号或多个 Region 时，只需在 model_list 里加同名 deployment，router_settings 不需要改动。Router 会自动在所有同名 deployment 之间按 rpm 权重随机选一个。

**操作步骤：**

1. 在新账号建 IAM User + 最小权限 Policy，生成 AKSK（参考五节）

1. 存入 Secrets Manager（如 litellm/bedrock-aksk-acct-b）

1. 更新 SecretProviderClass，注入新的 env var

1. 在 values.yaml 的 environmentSecrets 加入新 k8s secret

1. 在 model_list 里加同名 deployment，引用新 env var

**model_list 示例（双账号 + 双 Region）：**

```
model_list:
  # Account A - us-east-1（当前配置，保持不变）
  - model_name: "claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6"
      aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID
      aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY
      aws_region_name: "us-east-1"
      rpm: 100
      tpm: 400000
      max_parallel_requests: 20

  # Account B - us-east-1（新增：不同账号，相同 Region）
  - model_name: "claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6"
      aws_access_key_id: os.environ/ACCT_B_ACCESS_KEY_ID
      aws_secret_access_key: os.environ/ACCT_B_SECRET_ACCESS_KEY
      aws_region_name: "us-east-1"
      rpm: 100
      tpm: 400000
      max_parallel_requests: 20

  # Account A - us-west-2（新增：相同账号，跨 Region）
  - model_name: "claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6"
      aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID
      aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY
      aws_region_name: "us-west-2"
      rpm: 100
      tpm: 400000
      max_parallel_requests: 20
```

**Router 行为：** 收到一个 claude-sonnet-4-6 请求时，Router 从这 3 个 deployment 中按 rpm 权重随机选一个。某个 deployment 连续失败 3 次后自动冷却 30s，流量自动切到其他 deployment。

**为什么多账号？** 每个 AWS 账号有独立的 Bedrock Service Quota。多账号 = quota 叠加，高并发场景下不会因单账号 quota 耗尽而报错。

### 9.3 安装

```
helm install litellm ./litellm-helm \
  --namespace litellm \
  --create-namespace \
  -f values.yaml

kubectl rollout status deployment/litellm -n litellm

# 获取 ALB DNS
kubectl get ingress litellm -n litellm

# 验证 CSI 挂载成功
POD=$(kubectl get pods -n litellm -l app.kubernetes.io/name=litellm -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n litellm $POD -- ls /mnt/secrets/
```

### 9.4 升级

```
helm upgrade litellm ./litellm-helm \
  --namespace litellm \
  -f values.yaml
```

### 9.5 回滚

```
helm rollback litellm -n litellm
```
