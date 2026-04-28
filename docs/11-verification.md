# 基础验证

### 11.1 基础连通性

```
curl https://<YOUR_CLOUDFRONT_DOMAIN>/health/liveliness
# 期望：{"status":"healthy"}
```

### 11.2 模型调用

```
# 建议用环境变量引用 master key，避免明文出现在命令历史
export LITELLM_MASTER_KEY="<YOUR_MASTER_KEY>"

curl https://<YOUR_CLOUDFRONT_DOMAIN>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 11.3 查看可用模型

```
curl https://<YOUR_CLOUDFRONT_DOMAIN>/v1/models \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}"
```
