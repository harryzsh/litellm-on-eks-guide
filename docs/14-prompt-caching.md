# Prompt Caching 策略

LiteLLM + Bedrock 架构下有两层独立的缓存机制，分别作用在不同层级，可叠加使用：

|  | Response Cache（LiteLLM 层） | Prompt Cache（Bedrock / Anthropic 层） |
| --- | --- | --- |
| **作用层级** | LiteLLM Proxy（Valkey） | 模型提供商（Bedrock API） |
| **缓存对象** | 完整的 API 响应 | 输入 prompt 的 KV cache |
| **命中条件** | model + messages 完全一致 | 相同 prompt prefix（前缀匹配） |
| **省什么** | API 调用费 + 端到端延迟 | Input token 费（~90% 折扣）+ TTFT |
| **适用场景** | 高频重复查询（FAQ、健康检查、相同 prompt 批量调用） | 长 system prompt、RAG context、多轮对话 |
| **需要配置** | 需要：Valkey + values.yaml | 不需要：Bedrock 自动触发（也可主动控制） |

> 💡 两层缓存不冲突：Response Cache 命中时直接返回，不调 Bedrock；未命中时请求到 Bedrock，Bedrock 侧的 Prompt Cache 仍可生效，降低 input token 费用。

### 14.1 Response Cache（LiteLLM 层）可选 先不配

#### 原理

LiteLLM 对每个请求生成 cache key（基于 model + messages + 部分参数），如果 Valkey 中已有完全匹配的缓存响应，直接返回，不调用 Bedrock。

Cache key 生成逻辑：`hash(model, messages, temperature, ...)`。只要任意参数不同（包括 temperature），都不会命中。

#### 配置参数详解

在 `values.yaml` 的 `litellm_settings` 中配置：

```
litellm_settings:
  cache: true                    # 总开关
  cache_params:
    type: "redis"                # 缓存后端：redis / s3 / local（生产用 valkey）
    host: "<VALKEY_ENDPOINT>"     # ElastiCache endpoint（见第八节）
    port: 6379
    ssl: true                    # ElastiCache Serverless 强制 TLS
    ssl_cert_reqs: null          # 跳过证书验证（ElastiCache 自签证书）
    ssl_check_hostname: false
    ttl: 3600                    # 缓存过期时间（秒），默认 3600
    namespace: "litellm"         # Valkey key 前缀，多实例共用同一 Valkey 时避免冲突
    supported_call_types:        # 哪些调用类型启用缓存（空数组 = 全部启用）
      - "completion"             # /v1/completions
      - "acompletion"           # async completions
      - "embedding"             # /v1/embeddings
      - "aembedding"            # async embeddings
```

#### 关键参数说明

- **`ttl`**：缓存过期时间。设太短命中率低，设太长可能返回过时内容。建议：

  - FAQ / 知识问答：3600s（1小时）

  - 实时性要求高的场景：300s（5分钟）或关闭

  - 可在请求级覆盖：请求 header 传 `Cache-Control: s-maxage=600`

- **`supported_call_types`**：控制哪些 API 启用缓存。设为空数组 `[]` 表示全部启用。如果只想缓存 embeddings（重复率高），可以只写 `["embedding", "aembedding"]`

- **`namespace`**：多套 LiteLLM 共享同一 Valkey 时，用不同 namespace 隔离

#### 请求级缓存控制

除了全局配置，LiteLLM 支持在单个请求里控制缓存行为：

```cpp
# 强制跳过缓存（即使有缓存也重新调用模型）
curl https://<YOUR_CLOUDFRONT_DOMAIN>/v1/chat/completions \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "cache": {"no-cache": true}
  }'

# 强制刷新缓存（调用模型并更新缓存）
curl https://<YOUR_CLOUDFRONT_DOMAIN>/v1/chat/completions \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "cache": {"no-store": true}
  }'
```

#### Streaming 场景注意

⚠️ LiteLLM 默认**不缓存 streaming 响应**。如需缓存 streaming，需在 `supported_call_types` 中加入对应类型，且 LiteLLM 会先完整接收响应再缓存。第二次请求命中缓存时，仍会以 streaming 格式返回（模拟 stream）。

#### 成本影响

Response Cache 命中 = 零 Bedrock 调用费。假设 30% 命中率：

- 月 100 万次请求 → 30 万次走缓存 → 省 30 万次 Bedrock 调用费

- ElastiCache Serverless 成本远低于 Bedrock 调用费（约 $0.125/GB-hr）

#### 目前状态 (我的环境)

**变更：** `supported_call_types` 从 `[completion, acompletion]` 改为 `[]`

###### 原因

我们的前端是 Claude Code，其请求特点决定了 Response Cache 几乎无法命中：

1. **每次请求内容都不同** — Claude Code 每轮对话包含完整的对话历史 + 代码上下文 + 用户新指令，几乎不可能出现两次完全相同的请求

1. **Response Cache 是精确匹配** — 要求 model + messages + temperature 等参数完全一致才能命中，任何一个字符不同都 miss

1. **Semantic Cache 也不适用** — 虽然支持语义相似度匹配，但 Claude Code 的请求里包含大量代码上下文，即使用户问题相似，上下文不同也无法命中；且每次请求额外调 embedding 模型会增加延迟和费用

###### Valkey 保留的原因

虽然关闭了 Response Cache，Valkey 仍然需要保留，用于：

| 功能 | 说明 |
| --- | --- |
| Router 状态 | cooldown 计数、deployment 健康状态 |
| Prompt Cache 路由记忆 | `optional_pre_call_checks: ["prompt_caching"]` 记住请求路由到哪个 deployment |
| Rate Limiting | 多 Pod 共享 rpm/tpm 计数器 |

###### 什么时候该开 Response Cache

如果未来接入其他前端（非 Claude Code），以下场景适合开启：

- FAQ 机器人（高重复率查询）

- Embedding 请求（`supported_call_types: ["embedding", "aembedding"]`）

- 批量处理相同 prompt 模板的任务

- 健康检查 / 测试请求

###### 当前配置

```
litellm_settings:
  cache: true
  cache_params:
    type: redis
    host: "litellm-valkey-b70cvj.serverless.<VALKEY_ENDPOINT>"
    port: 6379
    ssl: true
    supported_call_types: []  # 不缓存任何响应
    ttl: 600
```

## 

### 14.2 Semantic Cache（语义缓存，可选）

Response Cache 是精确匹配，"1+1等于几" 和 "一加一是多少" 不会命中。Semantic Cache 用 embedding 做相似度匹配，语义相近的问题可以复用缓存。

#### 配置

```
litellm_settings:
  cache: true
  cache_params:
    type: "redis"
    host: "<VALKEY_ENDPOINT>"
    port: 6379
    ssl: true

    # 语义缓存配置
    similarity_threshold: 0.8        # 相似度阈值（0-1），越高越严格
    default_in_memory_ttl: 600       # 内存缓存 TTL（秒）
    default_in_redis_ttl: 3600       # Valkey 缓存 TTL（秒）
```

#### 注意事项

- 需要额外的 embedding 调用（每次请求先算 embedding 再查 Valkey），会增加延迟和 embedding 费用

- 适合 FAQ、客服等场景（用户问法多变但意思相近）

- 不适合代码生成、创意写作等场景（语义相近但期望输出不同）

- 建议先用精确匹配，观察命中率后再决定是否开启语义缓存

### 14.3 Prompt Cache（Bedrock / Anthropic 层）

#### 原理

Prompt Cache 是 Anthropic 模型（Claude）在推理层面的优化。当多个请求共享相同的 prompt 前缀（system prompt、few-shot examples、RAG context 等），模型会复用之前计算好的 KV cache，跳过重复计算。

这不是 LiteLLM 的功能，而是 Bedrock / Anthropic API 原生支持的。LiteLLM 作为 proxy 透传请求，自然享受这个优化。

#### Bedrock 上的自动触发条件

Bedrock 上 Claude 模型的 Prompt Cache 需要显式标记（通过 cache_control 或 cachePoint），不是完全自动的。且需要满足以下条件才能命中：

- **最低 token 数**：缓存的 prefix 部分需达到一定长度（通常 ≥ 1024 tokens）

- **前缀完全一致**：从第一个 token 开始，连续相同的部分才会被缓存

- **同一模型**：不同模型之间不共享 cache

- **时间窗口**：缓存有 TTL（通常 5 分钟），超时后需重新构建

#### LiteLLM 透传说明

LiteLLM 配置了 `drop_params: true` 后，会自动透传 Anthropic 特有参数（包括 `cache_control`），**但实际生产中加 `cache_control_injection_points` 更稳妥。**


 Claude Code 客户端自己会发 cache_control（内置了这个逻辑），所以直连 Bedrock 时确实不需要额外配置

  但通过 LiteLLM proxy 时，cache_control_injection_points 是双保险——即使客户端没发，LiteLLM 也会自动注入


**additional_drop_params:**

      - vector_store_ids

      - vector_store_id


Bedrock 目前不支持 vector_store_id. litellm为了open ai 所以透传了vector_store_id, 但是bedrock 不认识 https://github.com/BerriAI/litellm/pull/23742#issuecomment


#### AWS 官方说明

> "Cross-region inference automatically selects the optimal AWS Region... At times of high demand, these optimizations may lead to increased cache writes."

正确理解：高负载时偶尔会 miss，但正常使用可以稳定命中。

#### 配置方法（只需两步）

##### 1. 模型里加 cache_control_injection_points (Optional) Claude Code 客户端自己注入cache_control 标记

```
model_list:
  - model_name: "claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6"
      cache_control_injection_points:
        - location: message
          role: system
```

LiteLLM 自动给 system message 注入 `cache_control`，客户端不需改任何东西。

##### ConfigMap Router 加 prompt_caching 路由 亲和路由

```
router_settings:
  optional_pre_call_checks: ["prompt_caching"]
```

记住 cache write 到同一个LLM model 发生在哪个 deployment，后续请求路由到同一个。

![image](MjXNboKd4o4207xETy3cPW0dnEf)

##### 实际 Limitations

| 限制 | 说明 |
| --- | --- |
| 缓存建立延迟 | 第一次请求后需等几秒。Claude Code 正常对话间隔 >5秒，不受影响 |
| 高负载时 | 偶尔 miss，不是完全不命中 |
| 最低 token 数 | Sonnet 4: ≥1024, Haiku 3.5: ≥2048, Opus 4.5: ≥4096 |
| TTL | 默认 5分钟，Sonnet 4.5/Opus 4.5/Haiku 4.5 支持 1小时 |
| 前缀必须一致 | 任何修改都会 miss |
| 每请求最多 4 checkpoint | 可分布在 system/messages/tools |

##### 定价（Anthropic Claude on Bedrock）

| Token 类型 | 价格（相对 input token） |
| --- | --- |
| 正常 Input token | 1x（基准价） |
| Cache write（首次写入缓存） | 1.25x（比正常贵 25%） |
| Cache read（命中缓存） | 0.1x（**便宜 90%**） |

举例（Claude Sonnet 4）：

- Input: $3/MTok

- Cache write: $3.75/MTok

- Cache read: $0.30/MTok

只要同一个 cached prefix 被读取 **2 次以上**，就比不缓存更便宜。

##### 最佳实践

1. **把不变的内容放前面**：system prompt → RAG context → few-shot examples → 用户消息。前面的内容越稳定，缓存命中率越高

1. **长 system prompt 必加 cache_control**：如果 system prompt 超过 1024 tokens，显式标记 `cache_control` 确保缓存

1. **多轮对话天然受益**：每轮对话只新增最后一条用户消息，前面的对话历史自动复用缓存

1. **批量处理同一文档**：对同一份 RAG 文档问多个问题时，把文档放在 system prompt 里，所有问题共享缓存

##### 参考链接

- [AWS Blog: Supercharge your development with Claude Code and Amazon Bedrock prompt caching](https://aws.amazon.com/blogs/machine-learning/supercharge-your-development-with-claude-code-and-amazon-bedrock-prompt-caching/)

- [AWS Blog: Effectively use prompt caching on Amazon Bedrock](https://aws.amazon.com/blogs/machine-learning/effectively-use-prompt-caching-on-amazon-bedrock/)

- [AWS Docs: Prompt caching for faster model inference](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)

- [LiteLLM: Claude Code Prompt Cache Routing](https://docs.litellm.ai/docs/tutorials/claude_code_prompt_cache_routing)

- [LiteLLM: Auto-Inject Prompt Caching](https://docs.litellm.ai/docs/tutorials/prompt_caching)

- [GitHub Issue #1347: Claude 4 prompt caching（已修复）](https://github.com/anthropics/claude-code/issues/1347)

### 14.4 两层叠加策略

#### 决策流程

```
收到请求
  │
  ▼
LiteLLM Response Cache 命中？
  ├── 是 → 直接返回缓存响应（零 Bedrock 费用，零延迟）
  │
  └── 否 → 转发到 Bedrock
            │
            ▼
          Bedrock Prompt Cache 命中？
            ├── 是 → 省 ~90% input token 费 + 更快 TTFT
            └── 否 → 正常推理（全价）
            │
            ▼
          响应写入 LiteLLM Response Cache（下次相同请求直接命中）
```

#### 场景推荐

| 场景 | Response Cache | Prompt Cache | 说明 |
| --- | --- | --- | --- |
| FAQ / 客服 | ✅ 开 | ✅ 自动 | 高重复率，两层都受益 |
| RAG 问答（同文档多问题） | ❌ 关或短 TTL | ✅ 重点用 | 问题不同但文档前缀相同 |
| 多轮对话 | ❌ 关 | ✅ 重点用 | 每轮内容不同，但前缀递增 |
| 批量数据处理（相同 prompt 模板） | ✅ 开 | ✅ 自动 | 模板相同，input 不同时靠 prompt cache |
| 创意写作 / 代码生成 | ❌ 关 | ✅ 可用 | 不希望返回缓存的旧结果 |
| 健康检查 / 测试 | ✅ 开 | ✅ 自动 | 完全相同的请求，response cache 直接命中 |

#### 推荐默认配置

大多数生产场景，建议：

- **Response Cache**：开启，TTL 设 1800s（30分钟），`supported_call_types` 设为 `["embedding", "aembedding"]`（只缓存 embeddings，chat 不缓存）

- **Prompt Cache**：无需配置，Bedrock 自动生效。对长 system prompt 加 `cache_control` 标记即可

- 如果确认有大量完全重复的 chat 请求，再把 `completion` 加入 `supported_call_types`

### 14.5 验证与监控

#### Response Cache 验证

发两次完全相同的请求，对比延迟：

```cpp
export LITELLM_MASTER_KEY="<YOUR_MASTER_KEY>"

for i in 1 2; do
  echo "=== 第 ${i} 次 ==="
  curl -s -w "\nHTTP %{http_code} | Time: %{time_total}s\n" \
    https://<YOUR_CLOUDFRONT_DOMAIN>/v1/chat/completions \
    -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"what is 1+1"}]}' \
    | python3 -c "import sys,json; r=json.load(sys.stdin); print('Cache hit:', r.get('_cache_hit', False))"
done
```

期望结果：

- 第 1 次：~1-2s，`Cache hit: False`

- 第 2 次：~0.1-0.3s，`Cache hit: True`

#### Prompt Cache 验证

Bedrock 响应 header 中会包含缓存信息。通过 LiteLLM 的 response metadata 可以查看：

```cpp
curl -s https://<YOUR_CLOUDFRONT_DOMAIN>/v1/chat/completions \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {"role": "system", "content": [{"type":"text","text":"<长 system prompt，至少 1024 tokens>","cache_control":{"type":"ephemeral"}}]},
      {"role": "user", "content": "问题1"}
    ]
  }' | python3 -m json.tool
```

在响应的 `usage` 字段中查看：

- `cache_creation_input_tokens`：本次写入缓存的 token 数

- `cache_read_input_tokens`：本次从缓存读取的 token 数（> 0 表示命中）

第一次请求会看到 `cache_creation_input_tokens > 0`，第二次相同前缀的请求会看到 `cache_read_input_tokens > 0`。

#### Dashboard 监控

LiteLLM Dashboard（`https://<YOUR_CLOUDFRONT_DOMAIN>/ui`）提供：

- **Cache Hit Rate**：Response Cache 命中率趋势图

- **Cost Savings**：缓存节省的预估费用

- **Per-model metrics**：每个模型的缓存命中情况

建议关注的指标：

- Response Cache 命中率 < 5%：检查是否请求差异太大，考虑关闭节省 Valkey 资源

- Response Cache 命中率 > 50%：考虑增大 TTL 进一步提升

- Prompt Cache read tokens 占比：越高越省钱，优化 prompt 结构可提升
