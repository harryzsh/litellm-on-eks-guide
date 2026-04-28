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
