# 模型管理

### Config model 与 DB model 的区别

LiteLLM 有两套模型管理路径，二者并存：

- **Config model（values.yaml）：** 存储在 Helm values.yaml → ConfigMap，Pod 启动时加载，改 values.yaml + helm upgrade，优先级低

- **DB model（store_model_in_db）：** 存储在 PostgreSQL，运行时动态读取，UI/API 直接操作热更新，优先级高

> ⚠️ store_model_in_db: true 时，DB 中的同名模型会覆盖 config 里的配置。如果你在 UI 里改了某个模型的参数，下次 helm upgrade 不会覆盖回来。

**推荐原则：**

- 生产模型 → 写进 values.yaml（GitOps，可审计）

- 临时测试 → UI 直接添加，确认后再同步到 values.yaml

- 不要在两边都改同一个模型，容易产生配置漂移

### 13.1 方式一：UI 操作（即时生效）

打开 Dashboard：`https://<YOUR_CLOUDFRONT_DOMAIN>/ui`
使用 Master Key 登录（从 Secrets Manager 获取）
左侧导航 → Models → Add Model / Edit / Delete
立即生效，无需重启 Pod

### 13.2 方式二：修改 values.yaml + helm upgrade（持久化）

编辑 values.yaml 中的 proxy_config.model_list，必须包含所有模型（数组整体替换，不会追加）：

```
proxy_config:
  model_list:
    - model_name: "claude-sonnet-4-6"
      litellm_params:
        model: "bedrock/us.anthropic.claude-sonnet-4-6"
        aws_region_name: "us-east-1"
    - model_name: "claude-opus-4-6"
      litellm_params:
        model: "bedrock/us.anthropic.claude-opus-4-6-v1"
        aws_region_name: "us-east-1"
    - model_name: "claude-haiku-3"
      litellm_params:
        model: "bedrock/anthropic.claude-3-haiku-20240307-v1:0"
        aws_region_name: "us-east-1"
```

```
helm upgrade litellm ./litellm-helm \
  --namespace litellm \
  -f values.yaml
```

### 13.3 方式三：Partial values.yaml + --reuse-values（推荐）

只写需要变更的部分，用 --reuse-values 保留其他配置：

```
# override-models.yaml（只含 model_list）
proxy_config:
  model_list:
    - model_name: "claude-sonnet-4-6"
      litellm_params:
        model: "bedrock/us.anthropic.claude-sonnet-4-6"
        aws_region_name: "us-east-1"
    - model_name: "claude-opus-4-6"
      litellm_params:
        model: "bedrock/us.anthropic.claude-opus-4-6-v1"
        aws_region_name: "us-east-1"
    - model_name: "claude-haiku-3"
      litellm_params:
        model: "bedrock/anthropic.claude-3-haiku-20240307-v1:0"
        aws_region_name: "us-east-1"
    - model_name: claude-opus-4-6-team-c
        litellm_params:
          aws_region_name: us-east-1
          max_parallel_requests: 3
          model: bedrock/converse/arn:aws:bedrock:us-east-1:476114114317:application-inference-profile/id
          rpm: 10
          tpm: 50000
        model_info:
          base_model: anthropic.claude-opus-4-6-v1
```

```
helm upgrade litellm ./litellm-helm \
  --namespace litellm \
  --reuse-values \
  -f override-models.yaml
```

> ⚠️ proxy_config.model_list 是数组，Helm merge 会整体替换而非追加。partial values 里写 model_list 时，原有模型也要带上。

### 13.4 验证模型是否生效

```
curl https://<YOUR_CLOUDFRONT_DOMAIN>/v1/models \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}"
```

**场景推荐：**

- 临时测试新模型 → UI 操作（即时，无需重启）

- 正式上线新模型 → 改 values.yaml + helm upgrade（持久化）

- 只改模型配置，保留其他设置 → --reuse-values + partial yaml


### 13.4 App inference profile


**格式一定是bedrock/converse/ app inference profile ARN**

![image](TV9Vb9VtXoGGFfxT8qpcfzndnZb)


### 13.5 新模型没有 thinking block（reasoning 被静默丢弃）

**现象：** 新模型（如 `claude-opus-4-8`）正文正常返回，但**没有 thinking block**；而老模型（opus-4-7、sonnet-4-6 等）thinking 正常。日志里没有任何报错。

**原因：** 镜像是 pin 死的（`v1.83.14`）且设了 `LITELLM_LOCAL_MODEL_COST_MAP=True`，所以 LiteLLM 只认识打包进**那个镜像**的成本表里的模型。比镜像更新的模型不在表里 → `get_model_info` 抛 "not mapped yet" → `supports_reasoning=False`。再叠加 `drop_params: true`，LiteLLM 会**静默删掉** thinking/reasoning 参数——于是模型只返回正文，没有 thinking，且不报错、日志里也看不出（`set_verbose: false` 不记请求体）。

这是结构性问题，不是某个模型独有：**任何比 pin 镜像更新的模型都会中招**。已经在成本表里的模型（opus-4-7、sonnet-4-6…）自带 `supports_reasoning=True`，不受影响。

**修复（不升级镜像）：** 在该模型的 `model_info` 里加 `supports_reasoning: true`，覆盖缺失的成本表条目，然后重新部署：

```yaml
  - model_name: claude-opus-4-8
    litellm_params:
      model: bedrock/global.anthropic.claude-opus-4-8
      aws_region_name: __BEDROCK_REGION__
    model_info:
      supports_reasoning: true   # 覆盖镜像成本表里缺失的条目
      input_cost_per_token: 0.000005
      # ...
```

镜像升级到收录了该模型的版本后即可移除此 override（opus-4-8 在 litellm ≥ v1.88.0 才进成本表）。验证要走**完整 proxy 链路**，别只看文件：

```bash
kubectl exec -n litellm deploy/litellm -c litellm -- python -c 'import os,json,urllib.request; \
  r=urllib.request.urlopen(urllib.request.Request("http://localhost:4000/v1/chat/completions", \
  data=json.dumps({"model":"claude-opus-4-8","messages":[{"role":"user","content":"2+2? think"}],"max_tokens":1024,"thinking":{"type":"adaptive"}}).encode(), \
  headers={"Authorization":"Bearer "+os.environ["LITELLM_MASTER_KEY"],"Content-Type":"application/json"})); \
  print(bool(json.loads(r.read())["choices"][0]["message"].get("thinking_blocks")))'
# True = thinking block 正常返回
```


### 13.6 客户端发了 Claude 不支持的参数 → 400

**现象：** 一些客户端 / SDK 发来的请求会 400,报错类似:

- `enable_thinking: Extra inputs are not permitted`
- `provider: Extra inputs are not permitted`
- `` `temperature` is deprecated for this model `` (opus-4-7/4-8)
- `` `temperature` and `top_p` cannot both be specified `` (opus-4-6 / sonnet / haiku)

**原因:**

1. **`enable_thinking`**、**`provider`** 等字段**不是** Anthropic/Bedrock 的标准参数。`drop_params: true` 只丢弃"它认识、但目标模型不支持"的标准参数,对这种**不认识的非标准字段**会原样透传 → Bedrock 严格校验直接拒收。
2. **`temperature` / `top_p`** 单独发都没问题(litellm 会按需丢弃),但**两个同时出现**会 400:opus-4-7/4-8 上采样参数已废弃,4-6/sonnet/haiku 则不允许两者并存。

**修复(服务端兜底,客户不用改):** 在模型的 `litellm_params` 里加 `additional_drop_params`,主动剥掉这些字段。注意要 **per-model**——`litellm_settings` 层的 `additional_drop_params` 在 bedrock 路径上不生效(本镜像版本)。

按模型分两档,避免误伤真正在用 temperature 的客户:

```yaml
  # opus-4-7 / 4-8:采样参数已废弃,temp/top_p 一并 drop
  - model_name: claude-opus-4-8
    litellm_params:
      model: bedrock/global.anthropic.claude-opus-4-8
      aws_region_name: __BEDROCK_REGION__
      drop_params: true
      additional_drop_params: ["enable_thinking", "provider", "frequency_penalty", "presence_penalty", "temperature", "top_p"]
    # ...

  # opus-4-6 / sonnet-4-6 / haiku-4-5:支持 temperature,只 drop 非标准字段
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: bedrock/global.anthropic.claude-sonnet-4-6
      aws_region_name: __BEDROCK_REGION__
      drop_params: true
      additional_drop_params: ["enable_thinking", "provider", "frequency_penalty", "presence_penalty"]
    # ...
```

> 注意:对支持 temperature 的模型(4-6/sonnet/haiku)**不要** drop `temperature`/`top_p`,否则会静默吞掉正常客户的采样设置。它们的 `temperature+top_p` 组合 400 属于客户端发了非法组合,应让客户端二选一,而非服务端兜底。`enable_thinking` / `provider` 这类非标准字段才适合全系列 drop。
