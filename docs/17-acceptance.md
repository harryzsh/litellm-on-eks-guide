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

## 17.8 Step 8：Service + Ingress + Internal ALB

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

## 17.9 Step 9：CloudFront + VPC Origin

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

## 17.10 Step 10：端到端功能验证

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

## 17.11 日志与可观测性

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

## 17.12 一键验收脚本

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

## 17.13 快速故障定位流程图

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

## 17.14 完整验收 checklist（收工前必过）

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


# 18 维护
