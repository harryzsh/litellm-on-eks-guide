# 运维与已知问题

本章收纳升级流程和已知上游问题的应对。Hotfix 的完整 values.yaml 片段见第 14 章 [Prompt Caching 策略](./14-prompt-caching.md)。

## 18.1 升级 LiteLLM

### 常规升级流程

```bash
# 1. 查看当前版本
helm list -n litellm

# 2. 查看可用版本
helm search repo litellm --versions | head -5

# 3. 执行升级（保留当前 values.yaml）
helm upgrade litellm oci://ghcr.io/berriai/litellm-helm \
  --version <NEW_VERSION> \
  -n litellm \
  -f values.yaml

# 4. 等 rollout
kubectl rollout status deployment litellm -n litellm --timeout=180s

# 5. 验证
kubectl logs -n litellm -l app.kubernetes.io/name=litellm --tail=50 | grep -i "started\|error"
```

### 升级前 checklist

- [ ] 备份当前 values.yaml
- [ ] 备份 RDS（预期升级会自动跑 migration）
- [ ] 查 [LiteLLM CHANGELOG](https://github.com/BerriAI/litellm/releases) 看有没有 breaking change
- [ ] 确认没有你依赖的 deprecated 字段（比如 `litellm_settings.cache` 旧字段）
- [ ] 如果启用了 prompt cache hotfix（见 14 章），检查新版是否已包含 [PR #26627](https://github.com/BerriAI/litellm/pull/26627)，合入后可移除 hotfix

### 回滚

```bash
helm rollback litellm <REVISION_NUMBER> -n litellm
```

## 18.2 App inference profile 无法启用 prompt cache 的问题

**问题**：使用 [Application Inference Profile](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html) (以 ARN 形式指定模型，如 `arn:aws:bedrock:us-east-1:<ACCOUNT_ID>:application-inference-profile/xxx`) 调用 `/v1/messages` 时，LiteLLM 不会把 `cache_control` 透传给 Bedrock，导致 prompt cache 完全失效。

**根因**：LiteLLM 的 Anthropic adapter 在 `_add_cache_control_if_applicable()` 里只对 `is_anthropic_claude_model(model)` 返回 True 的情况保留 `cache_control`。ARN 形式的 model 字符串不匹配这个判断，于是 cache_control 被 strip 掉。

**上游 issue / PR**：

- Issue: [BerriAI/litellm#26625](https://github.com/BerriAI/litellm/issues/26625)
- PR: [BerriAI/litellm#26627](https://github.com/BerriAI/litellm/pull/26627)

**Hotfix**：在 LiteLLM 未合并并发版前，使用 Helm `command:` override 在容器启动时 patch 库文件。完整 YAML 见第 14 章末尾 "Hotfix: Bedrock ARN models + prompt caching"。
**何时可以移除**：upstream PR 合入并发布版本后，直接升级到该版本，然后从 values.yaml 里移除 `command:` 块，`helm upgrade` 部署，验证 cache 仍然工作即可。

## 18.3 App inference profile 显示cost 0 得问题

litellm有个bug 就是如果看到app inference profile, 会认不出这个model， 所以需要手动设置base_model这样cost就能显示出来

```bash
- model_name: claude-opus-4-6-team-c
        litellm_params:
          aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID
          aws_region_name: us-east-1
          aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY
          max_parallel_requests: 3
          model: bedrock/converse/arn:aws:bedrock:us-east-1:476114114317:application-inference-profile/slyg9mj0honl
          rpm: 10
          tpm: 50000
        model_info:
          base_model: anthropic.claude-opus-4-6-v1
          id: claude-opus-4-6-team-c-app
```
