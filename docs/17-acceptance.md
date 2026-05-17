# 完整验收流程

目标：kubectl 能连通、节点 Ready、OIDC Provider 已启用、ALB Controller 正常。

```cpp
# 1. kubectl 能连通
kubectl cluster-info
# 期望：Kubernetes control plane is running at https://...eks.amazonaws.com

# 2. 节点 Ready（数量 ≥ 2）
kubectl get nodes -o wide
# 期望：所有节点 STATUS=Ready

# 3. OIDC Provider 已启用
aws eks describe-cluster --name <EKS_CLUSTER_NAME> --region us-east-1 \
  --query 'cluster.identity.oidc.issuer' --output text
# 期望：https://oidc.eks.us-east-1.amazonaws.com/id/XXXXX（不为 None）

# 4. OIDC provider 已关联到 IAM
OIDC_ID=$(aws eks describe-cluster --name <EKS_CLUSTER_NAME> --region us-east-1 \
  --query 'cluster.identity.oidc.issuer' --output text | sed 's|.*/id/||')
aws iam list-open-id-connect-providers | grep $OIDC_ID
# 期望：有一行匹配输出

# 5. ALB Controller Pod 正常
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
# 期望：2 个 Pod 都 Running，READY 1/1

# 6. ALB Controller 日志无报错
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller --tail=20
# 期望：没有 ERROR / panic / unable to

# 7. 私有子网 tag 正确
for SUBNET in $(aws eks describe-cluster --name <EKS_CLUSTER_NAME> --region us-east-1 \
    --query 'cluster.resourcesVpcConfig.subnetIds' --output json | jq -r '.[]'); do
  echo "=== $SUBNET ==="
  aws ec2 describe-subnets --subnet-ids $SUBNET \
    --query 'Subnets[0].{Public:MapPublicIpOnLaunch,Tags:Tags}' --output json
done
# 期望：私有子网（Public=false）有 kubernetes.io/role/internal-elb=1 tag
```

常见坑：

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| kubectl 报 Unable to connect to the server | kubeconfig 过期 / 区域错 | `aws eks update-kubeconfig --name <EKS_CLUSTER_NAME> --region us-east-1` |
| eksctl create iamserviceaccount 报 no IAM OIDC provider | OIDC 未启用 | 跑 §4.2 的 `eksctl utils associate-iam-oidc-provider` |
| ALB Controller Pod CrashLoopBackOff | IRSA 没建 / policy 没附 | `kubectl describe pod` 看事件，检查 §3.2 四步 |
| ALB Controller 日志 failed to find target subnets | 私有子网没打 internal-elb tag | 跑 §4.3 的打 tag 脚本 |

## 17.2 Step 2：Namespace + IRSA + Secret 权限

```cpp
# 1. Namespace 存在
kubectl get ns litellm
# 期望：STATUS=Active

# 2. ServiceAccount 存在且带 IRSA 注解
kubectl get sa litellm -n litellm -o yaml | grep eks.amazonaws.com/role-arn
# 期望：annotations 里有 eks.amazonaws.com/role-arn: arn:aws:iam::...

# 3. IRSA Role 存在
ROLE_NAME=$(kubectl get sa litellm -n litellm \
  -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}' | awk -F/ '{print $NF}')
aws iam get-role --role-name $ROLE_NAME --query 'Role.AssumeRolePolicyDocument'
# 期望：Trust policy 里有 OIDC Provider ARN + Federated condition（sub = system:serviceaccount:litellm:litellm）

# 4. Role 附加了 Bedrock policy
aws iam list-attached-role-policies --role-name $ROLE_NAME
# 期望：至少有 AmazonBedrockFullAccess（或等价 policy）

# 5. Role 附加了 SecretsManager inline policy
aws iam list-role-policies --role-name $ROLE_NAME
# 期望：有 SecretsManagerReadLitellm

# 6. 用 Pod 实际验证 IRSA 能拿到凭证
kubectl run irsa-test --rm -it --restart=Never \
  --serviceaccount=litellm -n litellm \
  --image=amazon/aws-cli --command -- \
  sh -c "aws sts get-caller-identity"
# 期望：返回 Arn: arn:aws:sts::<ACCOUNT>:assumed-role/<ROLE_NAME>/...
```

常见坑：`AccessDenied: User ... is not authorized to perform sts:AssumeRoleWithWebIdentity` → Trust policy 里 sub condition 和实际 namespace/sa 不匹配。对比 `kubectl get sa -n litellm litellm -o yaml` 和 trust policy 的 StringEquals。

## 17.3 Step 3：Secrets Manager + CSI Driver

```cpp
# 1. 四个 secret 都存在
for name in litellm/db litellm/master-key litellm/salt-key litellm/bedrock-aksk; do
  echo "=== $name ==="
  aws secretsmanager describe-secret --secret-id $name --region us-east-1 \
    --query '{Name:Name,ARN:ARN,LastChangedDate:LastChangedDate}' --output json
done
# 期望：每个都返回 ARN，无 ResourceNotFound

# 2. Secret JSON 结构正确
aws secretsmanager get-secret-value --secret-id litellm/db --region us-east-1 \
  --query SecretString --output text | jq .
# 期望：{"database_url": "postgresql://..."}
# ⚠️ JSON key 必须和 SecretProviderClass 里 jmesPath.path 完全一致

# 3. CSI Driver Pod 正常
kubectl get pods -n kube-system -l app=secrets-store-csi-driver
kubectl get pods -n kube-system -l app=secrets-store-csi-driver-provider-aws
# 期望：全部 Running（DaemonSet，每个节点一个）

# 4. SecretProviderClass 已 apply
kubectl get secretproviderclass litellm-secrets -n litellm
kubectl describe secretproviderclass litellm-secrets -n litellm
# 期望：存在，且 objects / secretObjects 列全

# 5. Pod 起来后，CSI 挂载成功
POD=$(kubectl get pods -n litellm -l app.kubernetes.io/name=litellm -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n litellm $POD -- ls -la /mnt/secrets/
# 期望：列出 database_url / litellm_master_key / litellm_salt_key / aws_access_key_id / aws_secret_access_key

# 6. 同步出来的 k8s Secret 存在
kubectl get secrets -n litellm
# 期望：litellm-db-secret / litellm-master-key / litellm-salt-key / litellm-bedrock-aksk 都在

# 7. 检查 Secret 内容前缀（不要把全部 echo 到日志）
kubectl get secret litellm-db-secret -n litellm -o jsonpath='{.data.DATABASE_URL}' | base64 -d | head -c 30
# 期望：前缀 postgresql:// ...
```

常见坑：

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| Pod 起不来，FailedMount: failed to fetch secret | IRSA 没 Secrets Manager 权限 / Resource ARN 不匹配 | 检查 §5.1 inline policy，ARN 模式要覆盖 litellm/* |
| /mnt/secrets/ 只有部分文件 | SecretProviderClass 里 objectName 拼错 / AWS 里 JSON key 拼错 | 对比 jmesPath.path 和 Secrets Manager 里实际 JSON |
| kubectl get secrets 看不到 litellm-db-secret | syncSecret.enabled=true 没开 / Pod 还没挂载过 | helm 安装 CSI Driver 时加 --set syncSecret.enabled=true |

## 17.4 Step 4：RDS PostgreSQL 连通性

```cpp
# 1. 从 EKS 节点 Pod 里测端口通不通
kubectl run pg-test --rm -it --restart=Never -n litellm \
  --image=postgres:15-alpine --command -- \
  sh -c "nc -zv <RDS_ENDPOINT> 5432"
# 期望：open / succeeded

# 2. 用 litellm_user 实际登录
kubectl run pg-login --rm -it --restart=Never -n litellm \
  --image=postgres:15-alpine --command -- \
  sh -c "PGPASSWORD='your_password' psql -h <RDS_ENDPOINT> -U litellm_user -d litellm -c '\\l'"
# 期望：列出数据库列表，litellm 在其中

# 3. litellm_user 有建表权限（LiteLLM 启动时会 migrate）
kubectl run pg-perm --rm -it --restart=Never -n litellm \
  --image=postgres:15-alpine --command -- \
  sh -c "PGPASSWORD='your_password' psql -h <RDS_ENDPOINT> -U litellm_user -d litellm -c 'CREATE TABLE _perm_test(id int); DROP TABLE _perm_test;'"
# 期望：CREATE TABLE / DROP TABLE 都成功

# 4. LiteLLM 启动后表已建
kubectl run pg-tables --rm -it --restart=Never -n litellm \
  --image=postgres:15-alpine --command -- \
  sh -c "PGPASSWORD='your_password' psql -h <RDS_ENDPOINT> -U litellm_user -d litellm -c '\\dt'"
# 期望：能看到 LiteLLM_* 开头的表（LiteLLM_VerificationToken / LiteLLM_SpendLogs 等）
```

常见坑：`nc` 不通 → RDS SG 没放通 EKS 节点 SG 的 5432。跑 §8.3 的 authorize-security-group-ingress。

## 17.5 Step 5：ElastiCache Valkey 连通性

```cpp
# 1. Valkey 状态 available
aws elasticache describe-serverless-caches \
  --serverless-cache-name litellm-valkey --region us-east-1 \
  --query 'ServerlessCaches[0].{Status:Status,Endpoint:Endpoint.Address,Port:Endpoint.Port}'
# 期望：Status=available，Endpoint 非空

# 2. 从 Pod 里测端口通
kubectl run valkey-test --rm -it --restart=Never -n litellm \
  --image=redis:7-alpine --command -- \
  sh -c "nc -zv <VALKEY_ENDPOINT> 6379"
# 期望：open

# 3. TLS 握手 + PING（Serverless Valkey 强制 TLS）
kubectl run valkey-ping --rm -it --restart=Never -n litellm \
  --image=redis:7-alpine --command -- \
  sh -c "redis-cli -h <VALKEY_ENDPOINT> -p 6379 --tls --insecure PING"
# 期望：PONG

# 4. LiteLLM Pod 里 cache 生效后能看到 key
kubectl run valkey-keys --rm -it --restart=Never -n litellm \
  --image=redis:7-alpine --command -- \
  sh -c "redis-cli -h <VALKEY_ENDPOINT> -p 6379 --tls --insecure KEYS 'litellm*' | head -5"
# 期望：cache hit 之后能看到 litellm:... 开头的 key
```

常见坑：`redis-cli` 不加 `--tls` 会直接 reset connection → ElastiCache Serverless 强制 TLS，values.yaml 里的 `ssl: true` 必须开。

## 17.6 Step 6：Bedrock 凭证 + 模型访问

```cpp
# 1. AKSK 本身有效（从 Secrets Manager 取出来本地测）
CREDS=$(aws secretsmanager get-secret-value \
  --secret-id litellm/bedrock-aksk --region us-east-1 \
  --query SecretString --output text)
AK=$(echo $CREDS | jq -r .AWS_ACCESS_KEY_ID)
SK=$(echo $CREDS | jq -r .AWS_SECRET_ACCESS_KEY)

AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK \
  aws sts get-caller-identity --region us-east-1
# 期望：返回 litellm-bedrock-user 的 Arn

# 2. 列出账号可访问的 Bedrock 模型
AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK \
  aws bedrock list-foundation-models --region us-east-1 \
  --query 'modelSummaries[?contains(modelId, `claude`)].modelId' --output text
# 期望：列出 anthropic.claude-* 系列，包含你在 values.yaml 里引用的 modelId

# 3. 直接调一次 InvokeModel 验证权限
AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK \
  aws bedrock-runtime invoke-model --region us-east-1 \
  --model-id us.anthropic.claude-sonnet-4-6 \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/bedrock-test.json && cat /tmp/bedrock-test.json | jq .
# 期望：返回 content / stop_reason，无 AccessDenied
```

常见坑：`AccessDeniedException: You don't have access to the model with the specified model ID` → AWS 控制台 Bedrock → **Model access** 没申请或没批准。每个账号每个 region 都要单独申请。

## 17.7 Step 7：Helm 部署 + Pod 健康

```cpp
# 1. Helm release 存在且 DEPLOYED
helm list -n litellm
# 期望：STATUS=deployed

# 2. 查看 helm 生成的 values 是不是你期望的
helm get values litellm -n litellm
# 期望：model_list、environmentSecrets、volumes 都对

# 3. Deployment 全部就绪
kubectl get deployment litellm -n litellm
# 期望：READY 列 =  desired（如 2/2）

# 4. Pod 状态 Running + Ready
kubectl get pods -n litellm -l app.kubernetes.io/name=litellm
# 期望：全部 Running，READY 1/1，RESTARTS 稳定不涨

# 5. Pod 无崩溃循环
kubectl describe pod -n litellm -l app.kubernetes.io/name=litellm | grep -E "State|Reason|Last State" | head -20
# 期望：State=Running，Last State（如有）不是 Error / OOMKilled

# 6. Pod 启动日志无 ERROR
POD=$(kubectl get pods -n litellm -l app.kubernetes.io/name=litellm -o jsonpath='{.items[0].metadata.name}')
kubectl logs -n litellm $POD --tail=50
# 期望：看到 "Application startup complete" / Uvicorn running，无 traceback

# 7. 环境变量都注入了（关键：DATABASE_URL / PROXY_MASTER_KEY / AWS_ACCESS_KEY_ID）
kubectl exec -n litellm $POD -- env | grep -E "^(DATABASE_URL|PROXY_MASTER_KEY|LITELLM|AWS_)" | sed 's/=.*/=***/'
# 期望：列出这些变量名（值不要打印），都存在

# 8. /etc/litellm/config.yaml 生成正确
kubectl exec -n litellm $POD -- cat /etc/litellm/config.yaml | head -40
# 期望：model_list / general_settings / router_settings 都在，master_key: os.environ/PROXY_MASTER_KEY

# 9. ConfigMap 内容
kubectl get configmap -n litellm
kubectl get configmap litellm-config -n litellm -o yaml | head -50
```

常见坑：

| 症状 | 根因 | 排查 |
| --- | --- | --- |
| Pod Pending | 节点资源不够 / PVC 挂不上 | kubectl describe pod 看 Events |
| Pod CrashLoopBackOff, logs 里 "No module named ..." | image tag 用错 | 对回 v1.82.3-stable（或最新 stable） |
| Pod 启动报 "could not connect to server" | DATABASE_URL 错 / SG 没放通 | 参考 §16.5 单独测 RDS |
| 日志 "ValueError: Missing LITELLM_MASTER_KEY" | PROXY_MASTER_KEY env 没注入 | 查 masterkeySecretName 对不对，§5.2 三段注入链 |
| Pod 日志里 Bedrock 调用报 ExpiredToken | AKSK 已轮换但 Pod 没重启 | kubectl rollout restart deploy/litellm -n litellm |

## 17.8 Step 8：HPA + PDB 弹性配置验收

litellm 跑起来不等于"能稳定服务"。本步骤验证两个**自动化机制**配置正确：

- **HPA (Horizontal Pod Autoscaler)**：流量来了能自动扩容
- **PDB (PodDisruptionBudget)**：节点维护/升级时不让业务挂

它们都是部署后才生效的"动态行为"，需要单独验收。详细原理见
[`19-karpenter.md`](./19-karpenter.md) §19.15。

### 17.8.1 metrics-server 是 HPA 的前置依赖

HPA 读 metrics 走 `metrics.k8s.io` API，这个 API 由 metrics-server 提供。
EKS **不预装** metrics-server，HPA 装了等于摆设。

```cpp
# 1. metrics-server addon 已装
aws eks list-addons --cluster-name <EKS_CLUSTER_NAME> --region us-east-1 \
  --query 'addons[?@==`metrics-server`]' --output text
# 期望：返回 metrics-server (非空)

# 2. metrics-server pod 在跑
kubectl get pods -n kube-system -l app.kubernetes.io/name=metrics-server
# 期望：2 个 Pod READY 1/1, Running

# 3. metrics.k8s.io API 可用
kubectl api-resources --api-group=metrics.k8s.io
# 期望：列出 nodes, pods 资源 (返回非空)

# 4. 实测能拿到指标
kubectl top node
kubectl top pod -n litellm --containers
# 期望：CPU(cores) / MEMORY(bytes) 列有数字, 不报 "metrics not available"
```

**没装 metrics-server 的症状**：HPA 的 TARGETS 列永远显示 `<unknown>/X%`，
副本数永远不会因为 CPU/mem 变化。

### 17.8.2 HPA 配置验收

```cpp
# 1. HPA 对象存在
kubectl get hpa litellm -n litellm
# 期望：MINPODS=2, MAXPODS=10, REPLICAS≥2, TARGETS 列有具体数字 (不是 <unknown>)

# 2. HPA spec 验证
kubectl get hpa litellm -n litellm -o yaml | grep -A 30 'spec:'
# 期望:
#   minReplicas: 2
#   maxReplicas: 10
#   metrics: 至少有 cpu (target 60%), 视情况有 memory (target 80%)
#   behavior.scaleUp.stabilizationWindowSeconds: 30
#   behavior.scaleDown.stabilizationWindowSeconds: 300

# 3. HPA 当前判断详情 (Conditions / 最近一次决策)
kubectl describe hpa litellm -n litellm
# 期望:
#   Reference: Deployment/litellm
#   Min/Max replicas: 2/10
#   Conditions:
#     AbleToScale       True
#     ScalingActive     True
#     ScalingLimited    False  (除非已经在 min/max 边界)
#   Events: 最近无 FailedGetResourceMetric / FailedComputeMetricsReplicas

# 4. 没有 FailedGetResourceMetric (== metrics-server 工作正常的最强信号)
kubectl get events -n litellm --field-selector involvedObject.kind=HorizontalPodAutoscaler --sort-by=.lastTimestamp | tail -10
# 期望：无 Warning 类型的 FailedGetResourceMetric
```

### 17.8.3 PDB 配置验收

```cpp
# 1. PDB 对象存在
kubectl get pdb litellm -n litellm
# 期望：
#   NAME      MIN AVAILABLE   ALLOWED DISRUPTIONS   AGE
#   litellm   1               1                     ...
# 关键: ALLOWED DISRUPTIONS=1 表示 PDB 当前允许 1 个 pod 被自愿 evict

# 2. PDB selector 真匹配到 pod
kubectl get pdb litellm -n litellm -o yaml | grep -A 5 'selector:'
# 期望: matchLabels: {app: litellm}, 跟 Deployment.spec.selector 一致

# 3. PDB 当前 status 三个数字
kubectl get pdb litellm -n litellm -o json | jq '.status | {currentHealthy, desiredHealthy, expectedPods, disruptionsAllowed}'
# 期望:
#   currentHealthy: 2     (实际 ready 的 pod 数)
#   desiredHealthy: 1     (= minAvailable)
#   expectedPods: 2       (= Deployment.replicas)
#   disruptionsAllowed: 1 (= currentHealthy - desiredHealthy)
# 这 4 个数字最能反映 PDB 的实时工作状态

# 4. 模拟 evict 看 PDB 是否真生效
POD=$(kubectl get pods -n litellm -l app=litellm -o jsonpath='{.items[0].metadata.name}')
kubectl get pod $POD -n litellm -o json | \
  kubectl auth can-i --as system:serviceaccount:karpenter:karpenter \
  create pods/eviction
# (这条主要是测 RBAC, eviction 实际验证用下面 17.8.5 测试)
```

### 17.8.4 PDB 在我们这套里到底干啥

PDB **只**保护"自愿中断"（voluntary disruption），不是万能 HA 保险。具体：

| 场景 | PDB 是否生效 | 替代保护机制 |
|---|---|---|
| Karpenter drift 替换节点（5/17 那次事故） | ✅ **核心场景**：限制 Karpenter 一次只 evict 1 个 pod | — |
| Karpenter consolidation（合并节点省钱） | ✅ 同上 | — |
| `kubectl drain` 节点（运维手动） | ✅ drain 走 eviction API | — |
| EKS Managed Node Group 升级 | ✅ EKS 也走 eviction API | — |
| spot 节点被回收（配了 SQS interruption queue 时） | ✅ Karpenter 主动 evict | 没配 queue 时 → ❌ |
| 节点真挂掉（hardware failure） | ❌ 走 DELETE 路径，不走 eviction | 跨 AZ + minReplicas=2 |
| HPA 缩容 | ❌ 走 DELETE 路径，不走 eviction | HPA 自身 stabilizationWindow 控制节奏 |
| Pod OOMKill | ❌ 单 pod 级，PDB 不参与 | mem limit + headroom |

我们这里 `minAvailable: 1` + `replicas: 2` 的具体行为：

```
正常状态: currentHealthy=2, desiredHealthy=1 → disruptionsAllowed=1
  → 允许 Karpenter 一次 evict 1 个 pod
  
evict 第 1 个: 该 pod Terminating, currentHealthy=1
  → disruptionsAllowed=0 → 暂时阻止再 evict
  → Karpenter 等
  
新 pod ready: currentHealthy=2 → disruptionsAllowed=1
  → Karpenter 可以 evict 第 2 个

→ 整个过程始终 ≥ 1 ready pod 服务业务
```

**反模式**：如果 minAvailable 设成 2（== replicas 数）：
- disruptionsAllowed = 0 → Karpenter 永远不能 evict
- drift 触发后节点替换**完全卡死**
- 必须人工介入

**指导原则**：`minAvailable` 应该 < replicas。replicas=2 时设 1，replicas≥4
时建议改 `minAvailable: 50%` 让保护强度跟随副本数。

### 17.8.5 联动测试：模拟 evict 看 PDB 真在保护

```cpp
# 准备：拿到当前 2 个 pod 名字
PODS=($(kubectl get pods -n litellm -l app=litellm -o jsonpath='{.items[*].metadata.name}'))
echo "Pod 1: ${PODS[0]}"
echo "Pod 2: ${PODS[1]}"

# 测试：第 1 次 evict（应该成功）
kubectl proxy --port=8001 &
PROXY_PID=$!
sleep 2

curl -k -s -X POST \
  http://127.0.0.1:8001/api/v1/namespaces/litellm/pods/${PODS[0]}/eviction \
  -H 'Content-Type: application/json' \
  -d '{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"'${PODS[0]}'","namespace":"litellm"}}'
# 期望：HTTP 201 Created (无 body 或 status: Success)

# 立刻测第 2 次 evict 第 2 个 pod（应该被 PDB 挡住）
curl -k -s -X POST \
  http://127.0.0.1:8001/api/v1/namespaces/litellm/pods/${PODS[1]}/eviction \
  -H 'Content-Type: application/json' \
  -d '{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"'${PODS[1]}'","namespace":"litellm"}}'
# 期望：HTTP 429 TooManyRequests, body 含 "Cannot evict pod as it would violate the pod's disruption budget"

kill $PROXY_PID

# 验证业务始终 ≥ 1 ready pod
kubectl get pods -n litellm -l app=litellm
# 期望：总有 ≥ 1 个 READY 1/1 (Deployment 会重新拉起新 pod 替代刚被 evict 的)
```

### 17.8.6 常见坑

| 症状 | 根因 | 修复 |
|---|---|---|
| HPA TARGETS 显示 `<unknown>/X%` | metrics-server 没装 | `aws eks create-addon --addon-name metrics-server` |
| HPA 副本数稳定在 maxReplicas，永远不缩 | mem request 太低，baseline mem utilization 已经 > target | 调大 mem request 留 headroom（参考 §19.15.1）|
| HPA scale 太抖（频繁扩缩） | scaleDown.stabilizationWindowSeconds 太短 | 默认 300s 一般够用；有特殊 burst 模式可以调到 600s |
| Karpenter drift 时业务**整体不可用 60-90s** | 没 PDB / PDB minAvailable=0 | 加 PDB 至少 minAvailable: 1 |
| Karpenter drift **完全卡死**不进展 | PDB minAvailable == replicas | 调小 minAvailable（少于 replicas） |
| `disruptionsAllowed: 0` 但没在 drift 中 | currentHealthy < desiredHealthy（pod 没 ready） | 看 pod 状态，是不是 startup 失败 / readiness 卡住 |
| PDB selector 不匹配 pod | label 不一致（如 Deployment 用 `app.kubernetes.io/name`，PDB 用 `app`） | 对齐 selector matchLabels 与 Deployment 模板 labels |

## 17.9 Step 9：Service + Ingress + Internal ALB

```cpp
# 1. Service 存在
kubectl get svc litellm -n litellm
# 期望：TYPE=ClusterIP，PORT(S)=4000/TCP

# 2. Service 能在集群内部访问
kubectl run curl-test --rm -it --restart=Never -n litellm \
  --image=curlimages/curl --command -- \
  curl -s http://litellm:4000/health/liveliness
# 期望：{"status":"healthy"}

# 3. Ingress 已拿到 ALB DNS
kubectl get ingress litellm -n litellm
# 期望：ADDRESS 列非空，形如 internal-k8s-litellm-xxx.us-east-1.elb.amazonaws.com

# 4. ALB 真的建出来了
ALB_DNS=$(kubectl get ingress litellm -n litellm -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo $ALB_DNS
aws elbv2 describe-load-balancers --region us-east-1 \
  --query "LoadBalancers[?DNSName=='$ALB_DNS'].{Name:LoadBalancerName,Scheme:Scheme,State:State.Code}"
# 期望：Scheme=internal，State=active

# 5. ALB TargetGroup 健康
TG_ARN=$(aws elbv2 describe-target-groups --region us-east-1 \
  --query "TargetGroups[?contains(LoadBalancerArns[0], (aws elbv2 describe-load-balancers --query \"LoadBalancers[?DNSName=='$ALB_DNS'].LoadBalancerArn\" --output text | head -1))].TargetGroupArn" \
  --output text 2>/dev/null | head -1)
# 或更简单：AWS Console → EC2 → Target Groups 查 health

aws elbv2 describe-target-health --target-group-arn $TG_ARN --region us-east-1 \
  --query 'TargetHealthDescriptions[].{Target:Target.Id,Port:Target.Port,State:TargetHealth.State}'
# 期望：所有 target State=healthy

# 6. 从集群内访问 ALB DNS（验证 VPC 内可达）
kubectl run alb-test --rm -it --restart=Never -n litellm \
  --image=curlimages/curl --command -- \
  curl -sv http://$ALB_DNS/health/liveliness 2>&1 | tail -10
# 期望：HTTP/1.1 200，body 是 {"status":"healthy"}
```

常见坑：

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| Ingress ADDRESS 一直空 | 私有子网没 internal-elb tag / ALB Controller 挂了 | §16.2 检查子网 tag 和 Controller 日志 |
| Target 一直 unhealthy | healthcheck path 不对 / Pod 不 ready | annotations 确认 /health/liveliness；kubectl get pod 看 READY |
| 502 Bad Gateway | healthcheck 过但 Pod 实际在启动 | 加 readinessProbe initialDelaySeconds |

## 17.10 Step 10：CloudFront + VPC Origin

```cpp
# 1. VPC Origin 状态 Deployed
aws cloudfront list-vpc-origins \
  --query 'VpcOriginList.Items[?Name==`litellm-internal-alb`].{Id:Id,Status:Status}'
# 期望：Status=Deployed

# 2. Distribution 状态 Deployed
aws cloudfront list-distributions \
  --query 'DistributionList.Items[?Comment==`litellm` || contains(Origins.Items[0].Id, `litellm`)].{Id:Id,Domain:DomainName,Status:Status,Enabled:Enabled}'
# 期望：Status=Deployed，Enabled=true

# 3. DNS 解析
dig +short <YOUR_CLOUDFRONT_DOMAIN>
# 期望：返回 IPv4 地址（通常是 CloudFront edge 的 Anycast IP）

# 4. TLS 握手正常
curl -svo /dev/null https://<YOUR_CLOUDFRONT_DOMAIN>/health/liveliness 2>&1 | grep -E "SSL|TLS|HTTP/" | head -10
# 期望：TLSv1.2/TLSv1.3 OK，HTTP/2 200

# 5. 从公网走 CloudFront 到 ALB 到 Pod 全链路通
curl -s https://<YOUR_CLOUDFRONT_DOMAIN>/health/liveliness
# 期望：{"status":"healthy"}

# 6. 关键 header 没被吞（特别是 Authorization）
curl -sv https://<YOUR_CLOUDFRONT_DOMAIN>/v1/models \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" 2>&1 | grep -E "^[<>]" | head -20
# 期望：请求头 > Authorization: Bearer ... 发出去
#       响应 < HTTP/2 200，且返回 JSON 模型列表

# 7. CloudFront 回源使用 VPC Origin（不走公网）
aws cloudfront get-distribution-config --id <CLOUDFRONT_DISTRIBUTION_ID> \
  --query 'DistributionConfig.Origins.Items[0]'
# 期望：有 VpcOriginConfig 字段，DomainName 是 internal ALB

# 8. 如果遇到 /ui/login redirect 到内部 ALB 地址的问题
# 检查 Origin Request Policy 是不是 Managed-AllViewer
aws cloudfront get-distribution-config --id <CLOUDFRONT_DISTRIBUTION_ID> \
  --query 'DistributionConfig.DefaultCacheBehavior.OriginRequestPolicyId'
# 期望：216adef6-5c7f-47e4-b989-5492eafa07d3 (Managed-AllViewer)
# 如果是 AllViewerExceptHostHeader，按 §10 说明改掉
```

常见坑：

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| 503 Origin server is unreachable | VPC Origin 没 Deployed / ALB DNS 变了 | 等 VPC Origin Deployed，重建 Origin 指新 ALB |
| /ui 登录后跳到 internal-k8s-...elb.amazonaws.com | Origin Request Policy 丢 Host | 改用 Managed-AllViewer（§10） |
| 401 Unauthorized 但 key 正确 | CloudFront 策略吞了 Authorization header | 确认 Origin Request Policy 转发 all viewer headers |

## 17.11 Step 11：端到端功能验证

```cpp
export LITELLM_MASTER_KEY="<YOUR_MASTER_KEY>"
export ENDPOINT="https://<YOUR_CLOUDFRONT_DOMAIN>"

# 1. Liveness
curl -s $ENDPOINT/health/liveliness
# 期望：{"status":"healthy"}

# 2. Readiness（DB / Valkey 都通才算 ready）
curl -s $ENDPOINT/health/readiness
# 期望：{"status":"healthy","db":"connected","cache":"connected",...}

# 3. 模型列表（鉴权通 + config 加载成功）
curl -s $ENDPOINT/v1/models \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" | jq '.data[].id'
# 期望：claude-sonnet-4-6、claude-opus-4-6、claude-haiku-3-5 都在

# 4. 实际调一次模型（Bedrock 权限 + 网络 + 凭证全通）
curl -s $ENDPOINT/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"say hello in 3 words"}]}' | jq '.choices[0].message.content'
# 期望：返回一句英文

# 5. Response Cache 命中
for i in 1 2; do
  echo "=== 第 $i 次 ==="
  curl -s -w "\nTime: %{time_total}s\n" $ENDPOINT/v1/chat/completions \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"what is 1+1"}]}' | tail -2
done
# 期望：第 2 次明显快（< 0.3s，且 _cache_hit: true）

# 6. Fallback 生效（验证 claude-sonnet-4-6 挂了会转 haiku）
# 临时改一个错的 model id 让 sonnet 失败，观察是否走 haiku
# （谨慎操作，生产环境不要做）

# 7. Streaming 正常
curl -N $ENDPOINT/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"count 1 to 5"}],"stream":true}'
# 期望：SSE 流式输出，多行 data: {...}，最后 data: [DONE]

# 8. DB 里有 spend log（说明 DB 写入路径通）
kubectl exec -n litellm $POD -- env | grep DATABASE_URL
# 从跳板机 psql 进去：
# SELECT COUNT(*) FROM "LiteLLM_SpendLogs" WHERE "startTime" > NOW() - INTERVAL '1 hour';
# 期望：有新记录

# 9. Dashboard 可访问
# 浏览器打开 https://<YOUR_CLOUDFRONT_DOMAIN>/ui/
# 用 Master Key 登录，看 Models / Keys / Logs 页面都能加载

# 10. Prompt Cache 验证（可选）
curl -s $ENDPOINT/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"system","content":[{"type":"text","text":"<长 system prompt，至少 1024 tokens>","cache_control":{"type":"ephemeral"}}]},{"role":"user","content":"q1"}]}' \
  | jq '.usage'
# 第一次：cache_creation_input_tokens > 0
# 第二次（换 user message 但 system 相同）：cache_read_input_tokens > 0
```

## 17.12 日志与可观测性

```cpp
# Pod 日志（实时）
kubectl logs -n litellm -l app.kubernetes.io/name=litellm -f --tail=100

# 只看 ERROR
kubectl logs -n litellm -l app.kubernetes.io/name=litellm --tail=1000 | grep -i error

# 指定 Pod
POD=$(kubectl get pods -n litellm -l app.kubernetes.io/name=litellm -o jsonpath='{.items[0].metadata.name}')
kubectl logs -n litellm $POD --previous   # 看上次挂掉前的日志
kubectl logs -n litellm $POD -c litellm   # 多容器时指定 container

# Events（最近 1 小时，按时间排序）
kubectl get events -n litellm --sort-by='.lastTimestamp' | tail -30

# 资源用量
kubectl top pods -n litellm
kubectl top nodes

# HPA 状态
kubectl get hpa -n litellm
kubectl describe hpa litellm -n litellm

# Helm 历史（回滚定位）
helm history litellm -n litellm
helm get manifest litellm -n litellm --revision <N>

# ALB Controller 日志（Ingress 问题必查）
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller --tail=100 | grep -i litellm

# CSI Driver 日志（secret 挂载问题必查）
kubectl logs -n kube-system -l app=secrets-store-csi-driver --tail=100
kubectl logs -n kube-system -l app=secrets-store-csi-driver-provider-aws --tail=100

# CloudWatch Logs (ALB access logs 如果启用)
aws logs tail /aws/elasticloadbalancing/<ALB_NAME> --follow --region us-east-1

# S3 success_callback 日志（已在 values.yaml 配）
aws s3 ls s3://litellm-logs-<ACCOUNT_ID>/litellm-logs/ --recursive | tail -5
```

## 17.13 一键验收脚本

把前面所有关键检查串成一个脚本，新环境部署完跑一遍，全绿才能算完工：

```cpp
#!/bin/bash
# litellm-verify.sh — LiteLLM on EKS 一键验收
set -e

CLUSTER=<EKS_CLUSTER_NAME>
REGION=us-east-1
NS=litellm
ENDPOINT="https://<YOUR_CLOUDFRONT_DOMAIN>"
MASTER_KEY="${LITELLM_MASTER_KEY:?set LITELLM_MASTER_KEY env var}"

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; FAILED=1; }

echo "=== Step 1: EKS ==="
kubectl get nodes -o json | jq -e '[.items[].status.conditions[] | select(.type=="Ready" and .status=="True")] | length >= 2' >/dev/null \
  && pass "节点 ≥ 2 且 Ready" || fail "节点数/状态异常"

aws eks describe-cluster --name $CLUSTER --region $REGION \
  --query 'cluster.identity.oidc.issuer' --output text | grep -q https \
  && pass "OIDC Provider 已启用" || fail "OIDC 未启用"

echo "=== Step 2: IRSA ==="
kubectl get sa litellm -n $NS -o yaml | grep -q eks.amazonaws.com/role-arn \
  && pass "ServiceAccount 有 IRSA 注解" || fail "IRSA 注解缺失"

echo "=== Step 3: Secrets ==="
for s in litellm/db litellm/master-key litellm/salt-key litellm/bedrock-aksk; do
  aws secretsmanager describe-secret --secret-id $s --region $REGION >/dev/null 2>&1 \
    && pass "Secret $s 存在" || fail "Secret $s 缺失"
done

echo "=== Step 4: Pods ==="
READY=$(kubectl get deployment litellm -n $NS -o jsonpath='{.status.readyReplicas}')
DESIRED=$(kubectl get deployment litellm -n $NS -o jsonpath='{.spec.replicas}')
[ "$READY" = "$DESIRED" ] && pass "Deployment $READY/$DESIRED Ready" || fail "Deployment 未全 Ready ($READY/$DESIRED)"

POD=$(kubectl get pods -n $NS -l app.kubernetes.io/name=litellm -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n $NS $POD -- ls /mnt/secrets/ 2>/dev/null | grep -q database_url \
  && pass "CSI 挂载 secrets 成功" || fail "CSI 挂载失败"

echo "=== Step 5: Ingress ==="
ALB=$(kubectl get ingress litellm -n $NS -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
[ -n "$ALB" ] && pass "Ingress ALB: $ALB" || fail "Ingress 未分配 ALB"

echo "=== Step 6: 端到端 ==="
curl -sf $ENDPOINT/health/liveliness >/dev/null \
  && pass "liveliness OK" || fail "liveliness 失败"

curl -sf $ENDPOINT/health/readiness >/dev/null \
  && pass "readiness OK" || fail "readiness 失败 (DB/Valkey?)"

MODELS=$(curl -sf $ENDPOINT/v1/models -H "Authorization: Bearer $MASTER_KEY" | jq -r '.data | length')
[ "$MODELS" -gt 0 ] && pass "模型列表：$MODELS 个" || fail "模型列表为空"

RESP=$(curl -sf $ENDPOINT/v1/chat/completions \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' \
  | jq -r '.choices[0].message.content' 2>/dev/null)
[ -n "$RESP" ] && [ "$RESP" != "null" ] && pass "模型调用 OK: $RESP" || fail "模型调用失败"

# 缓存命中
curl -sf $ENDPOINT/v1/chat/completions \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"cache-warmup-probe"}],"max_tokens":5}' >/dev/null
HIT=$(curl -sf $ENDPOINT/v1/chat/completions \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"cache-warmup-probe"}],"max_tokens":5}' \
  | jq -r '._cache_hit // false')
[ "$HIT" = "true" ] && pass "Response Cache 命中" || fail "Response Cache 未命中（检查 Valkey）"

echo ""
[ -z "$FAILED" ] && echo "🎉 全部通过" || { echo "⚠️  有检查项未通过"; exit 1; }
```

使用方法：

```cpp
export LITELLM_MASTER_KEY="sk-..."
chmod +x litellm-verify.sh
./litellm-verify.sh
```

## 17.14 快速故障定位流程图

```
用户请求失败
  │
  ├─ 连不上域名？
  │    ├─ dig / curl -v 看 DNS
  │    └─ CloudFront Distribution 是否 Deployed？
  │
  ├─ 403/503 (CloudFront 层)？
  │    ├─ VPC Origin 状态？→ §16.10 Step 9
  │    └─ Origin Request Policy 对不对？→ §10 末尾坑
  │
  ├─ 502 Bad Gateway？
  │    ├─ ALB Target 健康？→ aws elbv2 describe-target-health
  │    └─ Pod Ready？→ kubectl get pods
  │
  ├─ 401 Unauthorized？
  │    ├─ Master Key 对不对？→ 从 Secrets Manager 取出来比对
  │    └─ Authorization header 被吞了？→ Origin Request Policy
  │
  ├─ 500 + "AccessDenied" in 日志？
  │    ├─ Bedrock Model Access 没申请 → 控制台申请
  │    └─ AKSK 过期/错了 → §16.7
  │
  ├─ 500 + "connection refused to postgres"？
  │    ├─ RDS SG？→ §16.5
  │    └─ DATABASE_URL 拼错？→ Secrets Manager 里的 JSON
  │
  ├─ 500 + "redis connection"？
  │    ├─ Valkey SG？→ §16.6
  │    └─ ssl: true 是否开？
  │
  └─ 模型超时/慢？
       ├─ Bedrock quota 打满？→ 多账号 / 多 deployment
       ├─ Router cooldown？→ kubectl logs 看 retry 日志
       └─ Network latency？→ 检查是不是跨 region
```

## 17.15 完整验收 checklist（收工前必过）

- [ ] 16.2 EKS 7 项全过

- [ ] 16.3 IRSA 6 项全过（重点：aws sts get-caller-identity 成功）

- [ ] 16.4 Secrets 7 项全过（重点：/mnt/secrets/ 5 个文件都在）

- [ ] 16.5 RDS 4 项全过（重点：litellm_user 能建表）

- [ ] 16.6 Valkey 4 项全过（重点：TLS PING PONG）

- [ ] 16.7 Bedrock 3 项全过（重点：直接 invoke-model 成功）

- [ ] 16.8 Helm/Pod 9 项全过（重点：env 有 DATABASE_URL/PROXY_MASTER_KEY/AWS_*）

- [ ] 16.9 Ingress/ALB 6 项全过（重点：Target healthy）

- [ ] 16.10 CloudFront 8 项全过（重点：Origin Request Policy 是 Managed-AllViewer）

- [ ] 16.11 端到端 10 项全过（重点：chat/completions 返回正常，缓存命中生效）

- [ ] 16.13 一键脚本输出 "🎉 全部通过"

- [ ] Dashboard 浏览器登录成功

- [ ] 日志里最近 10 分钟无 ERROR / Traceback

- [ ] DB 里 LiteLLM_SpendLogs 有真实流量记录

全部勾完，这套 LiteLLM on EKS 才算稳稳地搭建成功。

## 17.16 弹性扩缩容链路实测演示（参考时间线）

部署完成后建议主动跑一次完整 demo，确认 HPA → Karpenter 链路真在工作。
本节记录一次实际演示的时间线和观察，可作为：

- 第一次 demo 看链路真在工作的对照
- 出问题时对照"正常情况下应该是什么样"
- 不熟悉 K8s 的团队成员的入门教学

测试方法见 [`19-karpenter.md`](./19-karpenter.md) §19.14（5 种验证方法）。
原理详解见同文档 §19.15。

### 17.16.1 测试方法（最稳妥的 Method B）

不发任何业务流量，**只改 HPA target 触发扩容信号**。零 Bedrock 调用、零业务影响。

```bash
# 1. 触发：mem target 80% → 40% (当前 mem 49% 立刻 > 新 target)
kubectl -n litellm patch hpa litellm --type='json' \
  -p='[{"op":"replace","path":"/spec/metrics/1/resource/target/averageUtilization","value":40}]'

# 2. 等约 90 秒看链路:
#    - HPA REPLICAS: 2 → 3
#    - 第 3 个 pod 进 Pending  
#    - Karpenter 起新 m6a.large
#    - pod 调度过去 → ready

# 3. 恢复:
kubectl -n litellm patch hpa litellm --type='json' \
  -p='[{"op":"replace","path":"/spec/metrics/1/resource/target/averageUtilization","value":80}]'
```

成本：多出来一台 m6a.large 跑约 5-10 分钟，约 **$0.01**。

### 17.16.2 完整时间线（实测）

```
T+0:00  ── 基线 ─────────────────────────────────────
        HPA       cpu 3%/60%, memory 49%/80%, REPLICAS=2
        Pods      2 (us-east-1a × 1, us-east-1b × 1)
        Nodes     2 m6a.large (DRIFTED 列空)
        实测 mem  ~2542 MiB / 2543 MiB per pod

T+0:30  >>> 触发: HPA mem target 80% → 40% <<<
        改后 TARGETS: memory 49%/40% (ratio 1.225, > 1.1 tolerance)

T+1:00  ✨ HPA 决策: ceil(2 × 49/40) = ceil(2.45) = 3
        ✨ Deployment.replicas: 2 → 3
        ✨ 第 3 个 pod 创建, 状态 Pending
        ✨ Karpenter 立即创建新 NodeClaim (us-east-1b)

T+1:30  ✨ 新节点 EC2 启动完成, kubelet 注册成功 (用了 70 秒, 比文档预估快)
        新 NodeClaim 状态: Ready

T+2:00  ✨ 第 3 个 pod 1/1 Ready, startupProbe 通过
        HPA TARGETS 显示 memory 38%/40% (新 pod 没 stress, 平均下来)
        正向链路完整跑通 ✅

T+3:30  >>> 恢复: HPA mem target 40% → 80% <<<
        TARGETS: memory 43%/80% (ratio 0.54, in tolerance below)
        进入 scaleDown stabilizationWindow=300s 的观察期

T+4:00  ~ T+5:30  HPA 持续观察 5 分钟, REPLICAS 维持 3

T+6:00  ✨ HPA 缩容: REPLICAS 3 → 2
        HPA 事件: "All metrics below target"
        1 个 pod 被 evict

T+6:30  ✨ Karpenter 检测节点 underutilized → delete
        ✨ NodeClaim: 3 → 2
        反向链路完整跑通 ✅

T+8:00  ── 终态恢复 ────────────────────────────────
        HPA       cpu 3%/60%, memory 43%/80%, REPLICAS=2
        Pods      2 (us-east-1a × 1, us-east-1b × 1, 跨 AZ ✅)
        Nodes     2 m6a.large
```

### 17.16.3 Karpenter 关键日志片段

正向触发：

```
disrupting node(s) ... (此次 demo 没触发 drift, 略)

# 起新节点
created nodeclaim default-jcjxc
launched nodeclaim default-jcjxc, instance-type=m6a.large, zone=us-east-1b
```

反向回收：

```
disrupting node(s)
  reason: underutilized
  decision: delete
  pod-count: 1
  disrupted-nodes: [{name: ip-10-0-11-80, NodeClaim: default-n66nq, instance-type: m6a.large}]

tainted node ip-10-0-11-80  taint: karpenter.sh/disrupted:NoSchedule
deleted node ip-10-0-11-80
deleted nodeclaim default-n66nq
```

HPA 事件：

```
SuccessfulRescale  New size: 3; reason: memory resource utilization (percentage of request) above target
SuccessfulRescale  New size: 2; reason: All metrics below target
```

### 17.16.4 三个超出预期的发现

#### 1. 节点 cold start 70 秒就 Ready（比文档估算快 50%）

文档 [`19-karpenter.md`](./19-karpenter.md) §19.15.2 估算的是 ~150 秒。实测：

```
T+1:00  Karpenter 调用 EC2 RunInstances
T+1:30  Node Ready                     (delta: ~30 秒)
T+2:00  Pod 1/1 Ready                  (delta: ~30 秒, image 拉取 + startup)
```

原因：
- AMI 已经缓存在 zone（不是 cold AMI）
- litellm image 568 MB 已经在 ECR/区域缓存
- 大部分时间花在 EC2 boot + kubelet bootstrap

如果你看到节点 cold start 超过 5 分钟，要排查：
- Karpenter controller 是否在运行
- ECR / Container Registry 速率限制
- 节点 SG 是否能联控制面（参见 §19.5.3）

#### 2. Karpenter 选择回收"老节点"而不是"新节点"

终态保留的是新建的 `default-jcjxc`（demo 中 10 分钟前才起的），删掉的是
原本就有的 `default-n66nq`（已经活了 160+ 分钟）。

为什么？Karpenter 的 cost 模型考虑了 `expireAfter: 720h`：

```
default-n66nq:  已活 160 分钟  →  剩余寿命 ~570 小时
default-jcjxc:  已活 10 分钟   →  剩余寿命 ~720 小时

→ 删老节点 = 集群"剩余寿命"最大化
→ 减少未来强制 expire 滚动的次数
→ 更稳定
```

这是 Karpenter v1 的隐藏智能。运维可以放心：consolidation 决策会自动倾向
"留下更新的节点"。

#### 3. consolidation 实际比 `consolidateAfter: 30m` 快很多

文档之前的描述："多余节点会在 30 分钟后被 Karpenter consolidation 回收"。

实测：HPA evict pod 后 **30 秒**（不是 30 分钟）节点就被回收了。

原因（推测）：
- `consolidateAfter: 30m` 是连续 underutilized 状态的"冷却时间"，从节点
  **持续** underutilized 开始计时
- demo 期间，被删的节点 `default-n66nq` 在 demo 之前就已经是 underutilized
  状态（litellm 改 mem request 5Gi 后，单节点装不满，长期空着 60% 内存）
- 它的 underutilized timer 已经超过 30 分钟门槛
- 一旦 HPA 把它上的 pod evict 掉变完全空闲，Karpenter 立刻删

→ "30 分钟回收"是理论最坏情况，实际经常更快。

### 17.16.5 验证结论

| 验证项 | 结果 | 时延 |
|---|---|---|
| HPA 看到 metrics 变化能触发扩容 | ✅ | ~60 秒（受 metrics-server scrape 限制） |
| HPA 改 Deployment.replicas | ✅ | < 1 秒 |
| 新 pod mem 5Gi 装不下进入 Pending | ✅ | 立刻 |
| Karpenter 看到 Pending 起新节点 | ✅ | ~5 秒决策 + ~30 秒 EC2 启动 |
| 节点注册到集群 + Ready | ✅ | ~30 秒（kubelet bootstrap） |
| Pod 调度到新节点 + 启动完成 | ✅ | ~30 秒 |
| 跨 AZ 始终维持（topologySpread）| ✅ | — |
| HPA 反向缩容（target 变高） | ✅ | ~5 分钟（stabilizationWindow=300s） |
| Karpenter 回收空节点 | ✅ | ~30 秒（实际快于文档估算） |
| 终态恢复到基线 | ✅ | 总耗时约 7 分钟 |
| Bedrock 调用 / 业务影响 | ❌ 无 | — |
| 总成本 | ~$0.01 | 一台 m6a.large 跑 5-10 分钟 |

整条链路工作得**比文档描述的还快/还流畅**。

### 17.16.6 期望对照

如果你的环境跑这个 demo 看到的是：

| 你看到的 | 可能问题 | 排查 |
|---|---|---|
| HPA TARGETS 一直 `<unknown>/X%` | metrics-server 没装 | 见 §17.8.1 |
| HPA 改了 mem target 但 REPLICAS 不变 | mem 实际利用率本来就在容差区间 | 检查实际 mem 利用率, 调更激进的 target |
| 第 3 个 pod 一直 Pending 几分钟 | Karpenter 没起新节点 | 见 §17.8.6 + [`19-karpenter.md`](./19-karpenter.md) §19.13 |
| 新节点起来但 pod 还是 Pending | nodeSelector / taint / topology 不匹配 | `kubectl describe pod` 看 events |
| 恢复 target 后 5 分钟没缩 | mem 利用率仍在容差区 | 看 HPA TARGETS 是否在 [0.9, 1.1] 之间 |
| 节点回收要等很久 | 节点之前不是 underutilized 状态 | 这是正常情况，等 `consolidateAfter` 即可 |


# 18 维护
