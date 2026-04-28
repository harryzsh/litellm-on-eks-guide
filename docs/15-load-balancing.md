# Load Balancing 与多账号路由

### 15.1 路由策略概览

LiteLLM Router 在同名 `model_name` 的多个 deployment 之间自动负载均衡。支持以下策略：

| 策略 | `routing_strategy` 值 | 行为 | 适用场景 |
| --- | --- | --- | --- |
| **加权随机（默认）** | `simple-shuffle` | 按 rpm/tpm 权重随机分配，无额外开销 | 通用生产环境（推荐） |
| **最低用量** | `usage-based-routing` | 路由到当前 TPM/RPM 用量最低的 deployment | 多 deployment quota 不同，需均匀消耗 |
| **最低延迟** | `latency-based-routing` | 路由到历史响应最快的 deployment | 延迟敏感应用 |
| **最少并发** | `least-busy` | 路由到当前活跃请求最少的 deployment | 高并发场景 |
| **最低成本** | `cost-based-routing` | 优先选最便宜的 deployment | 多 provider 混合（Bedrock + Anthropic Direct） |

> 💡 生产建议：使用默认的 `simple-shuffle`。它延迟开销最小，配合 rpm 权重已能满足大多数场景。其他策略需要 Valkey 追踪状态，增加复杂度。

### 15.2 可靠性机制

#### Cooldown（自动冷却）

当某个 deployment 连续失败超过阈值，Router 自动将其从可用池移除，冷却期后自动恢复：

```
router_settings:
  allowed_fails: 3        # 1 分钟内允许失败次数，超过则冷却
  cooldown_time: 30        # 冷却时长（秒），期间该 deployment 不接收请求
```

触发冷却的条件：

- 429（Rate Limit）→ 立即冷却

- 401（Auth 失败）/ 404（Not Found）→ 立即冷却

- 连续失败率 > 50% → 冷却

冷却期间，流量自动切到其他健康的 deployment，用户无感知。

#### Fallback（跨模型降级）

当同一 model group 的所有 deployment 都不可用时，切到备用模型：

```
litellm_settings:
  fallbacks:
    - {"claude-opus-team-alpha": ["claude-sonnet-team-alpha"]}
    - {"claude-sonnet-team-alpha": ["claude-haiku-team-alpha"]}
```

降级链：Opus 全挂 → 降到 Sonnet → Sonnet 全挂 → 降到 Haiku。

#### Retry（重试）

```
router_settings:
  num_retries: 3           # 失败后重试次数（自动切换 deployment）
  timeout: 600             # 单次请求超时（秒）
```

重试逻辑：429 用指数退避，其他错误立即重试到下一个 deployment。

#### Deployment Priority（主备优先级）

```
model_list:
  - model_name: "claude-opus-team-alpha"
    litellm_params:
      model: "bedrock/arn:aws:bedrock:us-east-1:<ACCOUNT_ID>:inference-profile/alpha-opus"
      aws_access_key_id: os.environ/ACCT_1_AK
      aws_secret_access_key: os.environ/ACCT_1_SK
      order: 1              # 最高优先级，优先使用

  - model_name: "claude-opus-team-alpha"
    litellm_params:
      model: "bedrock/arn:aws:bedrock:us-east-1:<ACCOUNT_ID>:inference-profile/alpha-opus"
      aws_access_key_id: os.environ/ACCT_2_AK
      aws_secret_access_key: os.environ/ACCT_2_SK
      order: 2              # order=1 失败后才使用
```

同一 order 内按 `simple-shuffle` 分配，某个 order 全失败后自动降到下一级。

### 15.3 多账号 + Per-Team Inference Profile 配置（方案 A · 推荐）

> **命名原则**：客户端统一使用和 Claude 官方一致的模型名（`claude-opus-4-7` / `claude-sonnet-4-7` / `claude-haiku-4-7`），**不带 team 后缀**；团队隔离 + 账号负载均衡 + AWS 分账全部在 LiteLLM 和 Bedrock 侧完成。客户端只靠 API key 区分身份。

#### 场景

- 10 个 AWS 账号，每个账号为每个 team 创建独立的 App Inference Profile

- 每个 Inference Profile 带独立 tag（`team=a/b/c`），供 AWS Cost Explorer 分账

- 每个 team 的请求在自己的 10 个 deployment 之间 `simple-shuffle` 负载均衡

- 客户端（Claude Code、OpenClaw 等）用**统一的公开模型名**，换 team 只需要换 API key

#### 架构

```
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│     Team A CC        │    │     Team B CC        │    │     Team C CC        │
│                      │    │                      │    │                      │
│  ANTHROPIC_BASE_URL  │    │  ANTHROPIC_BASE_URL  │    │  ANTHROPIC_BASE_URL  │
│  = litellm:4000      │    │  = litellm:4000      │    │  = litellm:4000      │
│                      │    │                      │    │                      │
│  ANTHROPIC_AUTH_TOKEN│    │  ANTHROPIC_AUTH_TOKEN│    │  ANTHROPIC_AUTH_TOKEN│
│  = sk-team-a-xxxxx   │    │  = sk-team-b-xxxxx   │    │  = sk-team-c-xxxxx   │
│                      │    │                      │    │                      │
│  ANTHROPIC_DEFAULT_  │    │  ANTHROPIC_DEFAULT_  │    │  ANTHROPIC_DEFAULT_  │
│  OPUS_MODEL=         │    │  OPUS_MODEL=         │    │  OPUS_MODEL=         │
│  claude-opus-4-7     │    │  claude-opus-4-7     │    │  claude-opus-4-7     │
│  ← 三个 team 相同！  │    │  ← 三个 team 相同！  │    │  ← 三个 team 相同！  │
└──────────┬───────────┘    └──────────┬───────────┘    └──────────┬───────────┘
           │                           │                           │
           │ model=claude-opus-4-7     │ model=claude-opus-4-7     │ model=claude-opus-4-7
           │ + sk-team-a-xxxxx         │ + sk-team-b-xxxxx         │ + sk-team-c-xxxxx
           ▼                           ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              LiteLLM Proxy                                      │
│                                                                                 │
│  Step 1: 鉴权 key → 识别 team_id                                                │
│  Step 2: 查 team 的 model_aliases                                               │
│    • Team A.model_aliases = {"claude-opus-4-7": "claude-opus-4-7-team-a"}       │
│    • Team B.model_aliases = {"claude-opus-4-7": "claude-opus-4-7-team-b"}       │
│    • Team C.model_aliases = {"claude-opus-4-7": "claude-opus-4-7-team-c"}       │
│  Step 3: 改写后进入 Router → 在同 team 的 N 个 deployment 间 simple-shuffle      │
└─────────────────────────────────────────────────────────────────────────────────┘
           │                           │                           │
           ▼                           ▼                           ▼
    claude-opus-4-7-team-a      claude-opus-4-7-team-b      claude-opus-4-7-team-c
    (Account 1~10 的 Team A     (Account 1~10 的 Team B     (Account 1~10 的 Team C
     Inference Profile)          Inference Profile)          Inference Profile)
           │                           │                           │
           ▼                           ▼                           ▼
           Bedrock App Inference Profile（tag=team，Cost Explorer 自动分账）
```

简化视图（单个 team 内的路由）：

```
Team A 请求 (sk-team-a-xxxxx + model=claude-opus-4-7)
  └─→ LiteLLM alias 改写 → "claude-opus-4-7-team-a"
       ├─ Account 1: arn:.../inference-profile/team-a-opus (tag: team=a)
       ├─ Account 2: arn:.../inference-profile/team-a-opus (tag: team=a)
       ├─ ...
       └─ Account 10: arn:.../inference-profile/team-a-opus (tag: team=a)
       → simple-shuffle 跨 10 个账号，quota 叠加
```

#### 设计要点

| 维度 | 方案 |
| --- | --- |
| 客户端模型命名 | 统一用 `claude-opus-4-7` 等官方名（三个 team 完全一致） |
| Team 隔离 | LiteLLM `model_aliases` 按 team 映射到不同内部 model_name |
| 账号负载均衡 | 每个内部 model_name 在 model_list 里注册 N 个同名 deployment |
| AWS 分账 | Inference Profile 的 `team` tag → Cost Explorer 自动拆分 |
| 换 team | 只换 API key，客户端其他配置不变 |
| 新增 team | 只在 LiteLLM 侧加 deployment + 建 team + 发 key，客户端零改动 |

#### Step 1：AWS 侧 — 创建 App Inference Profile（每个账号 × 每个 team）

```cpp
# 在每个账号中，为每个 team 创建带 tag 的 Inference Profile
# 示例：Account 1 中为 Team A 创建
aws bedrock create-inference-profile \
  --inference-profile-name "team-a-opus" \
  --model-source '{"copyFrom":"arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-7-v1"}' \
  --tags '[{"key":"team","value":"a"},{"key":"cost-center","value":"team-a"}]' \
  --region us-east-1

# Account 1 中为 Team B 创建
aws bedrock create-inference-profile \
  --inference-profile-name "team-b-opus" \
  --model-source '{"copyFrom":"arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-7-v1"}' \
  --tags '[{"key":"team","value":"b"},{"key":"cost-center","value":"team-b"}]' \
  --region us-east-1

# Sonnet / Haiku 同理，每个账号每个 team 都要建
```

⚠️ 10 账号 × 3 teams × 3 模型 = 90 个 profile，建议用脚本批量创建（见 Step 6）。

#### Step 2：Secrets Manager — 存储各账号 AKSK

```cpp
# 每个账号的 AKSK 存一个 secret
for i in $(seq 1 10); do
  aws secretsmanager create-secret \
    --name "litellm/bedrock-aksk-acct-${i}" \
    --secret-string "{\"ACCT_${i}_AK\":\"<YOUR_AWS_ACCESS_KEY_ID>\",\"ACCT_${i}_SK\":\"your-secret\"}" \
    --region us-east-1
done
```

更新 SecretProviderClass，为每个账号注入对应的 env var（参考第七节格式）。

#### Step 3：values.yaml — model_list 注册底层 deployment

底层 `model_name` 带 team 后缀作为"**内部路由键**"（不暴露给客户端），客户端看不到这个名字：

```
proxy_config:
  model_list:
    # ===== Team A 的 opus：10 个账号 =====
    - model_name: "claude-opus-4-7-team-a"       # 内部 model name
      litellm_params:
        model: "bedrock/arn:aws:bedrock:us-east-1:<ACCOUNT_ID>:inference-profile/team-a-opus"
        aws_access_key_id: os.environ/ACCT_1_AK
        aws_secret_access_key: os.environ/ACCT_1_SK
        aws_region_name: "us-east-1"
        rpm: 50
        tpm: 200000
        max_parallel_requests: 10

    - model_name: "claude-opus-4-7-team-a"
      litellm_params:
        model: "bedrock/arn:aws:bedrock:us-east-1:<ACCOUNT_ID>:inference-profile/team-a-opus"
        aws_access_key_id: os.environ/ACCT_2_AK
        aws_secret_access_key: os.environ/ACCT_2_SK
        aws_region_name: "us-east-1"
        rpm: 50
        tpm: 200000
        max_parallel_requests: 10

    # ... Account 3~10 同结构 ...

    # ===== Team B 的 opus =====
    - model_name: "claude-opus-4-7-team-b"
      litellm_params:
        model: "bedrock/arn:aws:bedrock:us-east-1:<ACCOUNT_ID>:inference-profile/team-b-opus"
        aws_access_key_id: os.environ/ACCT_1_AK
        aws_secret_access_key: os.environ/ACCT_1_SK
        aws_region_name: "us-east-1"
        rpm: 50
        tpm: 200000

    # ... 每个 team × 每个账号 × 每个模型 ...

router_settings:
  routing_strategy: simple-shuffle
  num_retries: 3
  allowed_fails: 3
  cooldown_time: 30
  enable_pre_call_checks: true
```

🔑 关键：`claude-opus-4-7-team-a` 是 LiteLLM 内部路由键，客户端永远不会直接填这个名字。

#### Step 4：创建 Team + 配置 model_aliases（核心步骤）

这一步是**整个方案的灵魂**：用 LiteLLM 官方的 `model_aliases` 字段，把统一的公开模型名（`claude-opus-4-7`）按 team 映射到不同的内部 model_name。

```cpp
export ADMIN_URL="https://<YOUR_CLOUDFRONT_DOMAIN>"
export ADMIN_KEY="${LITELLM_MASTER_KEY}"

# 创建 Team A
curl -X POST $ADMIN_URL/team/new \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "team_alias": "team-a",
    "model_aliases": {
      "claude-opus-4-7": "claude-opus-4-7-team-a",
      "claude-sonnet-4-7": "claude-sonnet-4-7-team-a",
      "claude-haiku-4-7": "claude-haiku-4-7-team-a"
    },
    "models": [
      "claude-opus-4-7-team-a",
      "claude-sonnet-4-7-team-a",
      "claude-haiku-4-7-team-a"
    ],
    "rpm_limit": 500,
    "tpm_limit": 2000000,
    "max_budget": 1000.0
  }'
# 响应里记录 team_id

# 创建 Team B
curl -X POST $ADMIN_URL/team/new \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "team_alias": "team-b",
    "model_aliases": {
      "claude-opus-4-7": "claude-opus-4-7-team-b",
      "claude-sonnet-4-7": "claude-sonnet-4-7-team-b",
      "claude-haiku-4-7": "claude-haiku-4-7-team-b"
    },
    "models": [
      "claude-opus-4-7-team-b",
      "claude-sonnet-4-7-team-b",
      "claude-haiku-4-7-team-b"
    ],
    "rpm_limit": 500,
    "tpm_limit": 2000000,
    "max_budget": 1000.0
  }'

# Team C 同理
```

⚠️ **`models`**** 字段必须写"内部 model name"**（带 team 后缀），不能写公开名。因为 LiteLLM 在 alias 解析后才做 team 级权限校验，team 必须被授权访问 alias 映射目标的那些底层 deployment。

#### Step 5：为每个 Team 生成 API Key

```cpp
# Team A 的 key
curl -X POST $ADMIN_URL/key/generate \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": "<team-a-id-from-step-4>",
    "key_alias": "team-a-prod"
  }'
# 返回 sk-team-a-xxxxx → 发给 Team A 开发者

# Team B / Team C 同理，team_id 分别替换
```

#### Step 6：客户端统一配置

**所有 team 的 Claude Code 用完全相同的环境变量**，只有 API key 不同：

```cpp
# Team A 开发者机器
export ANTHROPIC_BASE_URL="https://<YOUR_CLOUDFRONT_DOMAIN>"
export ANTHROPIC_AUTH_TOKEN="sk-team-a-xxxxx"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-7"        # 和官方命名一致
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-7"
claude --model opus

# Team B 开发者机器 — 环境变量除 key 外完全相同
export ANTHROPIC_BASE_URL="https://<YOUR_CLOUDFRONT_DOMAIN>"
export ANTHROPIC_AUTH_TOKEN="sk-team-b-xxxxx"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-7"        # 完全相同
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-7"
claude --model opus
```

请求流转：

```
Team A 发来 model=claude-opus-4-7 + Bearer sk-team-a-xxxxx
  ↓ LiteLLM 根据 key 识别 team_id = team-a
  ↓ 查 team-a 的 model_aliases
  ↓ 把 model 从 "claude-opus-4-7" 改写成 "claude-opus-4-7-team-a"
  ↓ Router 在 10 个 Team A deployment 间 simple-shuffle
  ↓ 最终打到 Team A 的 Inference Profile（带 team=a tag → Cost Explorer 分账）
```

#### Step 7：批量生成 model_list 脚本

10 账号 × 3 teams × 3 模型手写不现实，用脚本生成：

```elixir
#!/usr/bin/env python3
# generate_model_list.py — 生成 values.yaml 的 model_list 部分
import yaml

accounts = {
    "111111111111": "ACCT_1",
    "222222222222": "ACCT_2",
    "333333333333": "ACCT_3",
    "444444444444": "ACCT_4",
    "555555555555": "ACCT_5",
    "666666666666": "ACCT_6",
    "777777777777": "ACCT_7",
    "888888888888": "ACCT_8",
    "999999999999": "ACCT_9",
    "101010101010": "ACCT_10",
}

teams = ["a", "b", "c"]
models = {
    # 公开名 → Bedrock foundation model id
    "opus-4-7":   "anthropic.claude-opus-4-7-v1",
    "sonnet-4-7": "anthropic.claude-sonnet-4-7-v1",
    "haiku-4-7":  "anthropic.claude-haiku-4-7-v1",
}
region = "us-east-1"
rpm_per_deployment = {"opus-4-7": 50, "sonnet-4-7": 100, "haiku-4-7": 200}
tpm_per_deployment = {"opus-4-7": 200000, "sonnet-4-7": 400000, "haiku-4-7": 800000}

model_list = []
for team in teams:
    for model_suffix in models.keys():
        for acct_id, env_prefix in accounts.items():
            model_list.append({
                "model_name": f"claude-{model_suffix}-team-{team}",  # 内部路由键
                "litellm_params": {
                    "model": f"bedrock/arn:aws:bedrock:{region}:{acct_id}:inference-profile/team-{team}-{model_suffix.split('-')[0]}",
                    "aws_access_key_id": f"os.environ/{env_prefix}_AK",
                    "aws_secret_access_key": f"os.environ/{env_prefix}_SK",
                    "aws_region_name": region,
                    "rpm": rpm_per_deployment[model_suffix],
                    "tpm": tpm_per_deployment[model_suffix],
                    "max_parallel_requests": 10,
                }
            })

print(yaml.dump({"model_list": model_list}, default_flow_style=False, allow_unicode=True))
```

```cpp
python3 generate_model_list.py > model_list_fragment.yaml
# 将输出合并到 values.yaml 的 proxy_config.model_list
```

#### 验证

```cpp
export ADMIN_URL="https://<YOUR_CLOUDFRONT_DOMAIN>"
export LITELLM_KEY_A="sk-team-a-xxxxx"

# 1. Team A 用公开名调用
curl $ADMIN_URL/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_KEY_A" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-7","messages":[{"role":"user","content":"hi"}]}'
# 期望：200 正常返回

# 2. 确认 alias 已绑定
curl "$ADMIN_URL/team/info?team_id=<team-a-id>" \
  -H "Authorization: Bearer $ADMIN_KEY"
# 期望响应含：
# "litellm_model_table": {
#   "model_aliases": {
#     "claude-opus-4-7": "claude-opus-4-7-team-a",
#     ...
#   }
# }

# 3. 验证跨 team 隔离：Team A 的 key 调 Team B 的内部名应失败
curl $ADMIN_URL/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_KEY_A" \
  -d '{"model":"claude-opus-4-7-team-b","messages":[{"role":"user","content":"hi"}]}'
# 期望：401/403 — Team A 无权访问 team-b 的内部 model
```

#### 新增 Team 的流程（对比其他方案）

假设要新增 Team D：

1. AWS 侧：10 个账号各建一个 `team-d-<model>` Inference Profile（带 `team=d` tag）

1. values.yaml：加 Team D 的底层 deployment（10 个 `claude-opus-4-7-team-d` 等），`helm upgrade`

1. LiteLLM API：调 `/team/new` 建 Team D + 配 `model_aliases: {"claude-opus-4-7": "claude-opus-4-7-team-d", ...}`

1. LiteLLM API：调 `/key/generate` 生成 Team D 的 key，发给 Team D 开发者

→ **客户端零改动**：Team D 的开发者拿到 key 直接用，环境变量 `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7` 和其他 team 完全一致。

#### 分账说明

AWS Cost Explorer 中按 Inference Profile 的 tag 筛选：

- Tag key: `team` → Tag value: `a` / `b` / `c` / `d`

- 每个 Inference Profile 的调用费用自动归到对应 tag

- 无需在 LiteLLM 侧做额外的费用拆分

⚠️ 前提：AWS Billing Console → Cost Allocation Tags 中激活 `team` tag。新激活的 tag 需要 **24 小时**后才能在 Cost Explorer 中筛选。

#### 注意事项

- `model_aliases` 是 LiteLLM 官方内置能力（参考 `POST /team/new` API），不是实验性特性

- Dashboard（`/ui/`）里每个 team 的 `model_aliases` 可直接查看

- 如某 team 需要临时访问"别的 team 的资源"（跨 team 路由），**不要改 alias**，而是发一张新 key 给它，或调整 team 的 `models` 清单

- 如一个用户属于多个 team，调用时用 `x-litellm-team-id` header 显式指定生效的 team

- 核心优势：**命名层封装在客户端（和官方一致），路由 + 分账层封装在 LiteLLM + Bedrock 侧**，客户端完全不感知 team 的存在

### 15.4 方案对比与选型

| 改 values.yaml + helm upgrade，再调 /team/new 配 model_aliases；客户端零改动 | 方案 A：Per-Team Inference Profile | 方案 B：共享 Pool + LiteLLM 限速 |
| --- | --- | --- |
| **AWS 分账** | ✅ Inference Profile tag 天然隔离 | ❌ 需靠 LiteLLM 日志手动拆分 |
| **Bedrock Quota 隔离** | ✅ 每个 team 独立 profile quota | ❌ 共享 quota，互相影响 |
| **model_list 条目** | 多（N teams × M accounts × K models） | 少（M accounts × K models） |
| **新增 team** | 需改 values.yaml + helm upgrade | 只需 API 创建 team + key |
| **Quota 弹性** | 固定：team 之间不能借用 | 灵活：team 共享总池 |
| **适用场景** | 严格分账、合规审计、独立 quota | 内部团队、快速迭代、弹性共享 |

**选型建议：**

- 需要 AWS Cost Explorer 按 team 分账 → **方案 A**（本节方案）

- 内部团队、不需要 AWS 侧分账 → 方案 B（共享 model_name + LiteLLM team 限速）

- 两者可混合：核心 team 用方案 A（独立 profile），临时 / 测试 team 用方案 B（共享 pool）

十六、逐步验证与故障排查

本章按部署顺序给出每一步的验证方法：用什么命令、预期输出是什么、失败时怎么排查。建议每完成一节就跑一遍对应的 checklist，问题越早发现越好定位。

16.1 验证哲学

三个层次，由浅入深：

1. 存在性验证：资源建出来了吗？（AWS API / kubectl get）

1. 连通性验证：能访问到吗？（DNS 解析 / 端口通 / TLS 握手）

1. 功能性验证：业务逻辑正确吗？（端到端调模型、看响应、查日志）

不要跳步。看到 pod 是 Running 就以为没事，可能 CSI 挂载其实失败了 / Bedrock 权限不对 / Ingress 还没拿到 ALB DNS。每步都过一遍。

常用工具箱：

- aws cli：查 AWS 资源状态

- kubectl：查 K8s 资源状态

- helm：查 chart 状态、历史

- curl / nc / dig：连通性测试

- jq / yq：解析 JSON / YAML 输出

- psql / redis-cli：DB 直连验证


# 16 Budget 管控

LiteLLM 在 Virtual Key / User / Team 三层上都支持预算（$ 消费上限）和速率（RPM/TPM）限制，搭配 RDS Postgres 做持久化和追踪。本章讲清楚：层级关系、配额含义、重置机制、落地建议。

参考：

- https://docs.litellm.ai/docs/proxy/users

- https://docs.litellm.ai/docs/proxy/team_budgets

- https://docs.litellm.ai/docs/proxy/budget_reset_and_tz
