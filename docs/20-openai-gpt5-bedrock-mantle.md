# 20 — OpenAI GPT-5.5 / GPT-5.4 via Bedrock Mantle

How to expose OpenAI's frontier models (GPT-5.5, GPT-5.4) through this LiteLLM
proxy on Amazon Bedrock. These models behave differently from the Claude models
configured elsewhere in this guide, so they need extra wiring.

## Why they are special

1. **Responses API only.** On Bedrock, GPT-5.x is served *only* at the
   `/openai/v1/responses` path on the **bedrock-mantle** endpoint. It does not
   support `/v1/chat/completions`, `/v1/responses` (without the `openai` prefix),
   nor the Converse/Invoke APIs.
2. **Region.** Available in `us-east-2` (Ohio) at launch (also `us-east-1`).
   Global cross-Region inference for OpenAI models is not yet available, so pin
   the endpoint to a supported region.
3. **Auth is a Bedrock API key (bearer token), not SigV4 AKSK.** Generate a
   long-term Bedrock API key and store it as `BEDROCK_MANTLE_API_KEY` in your
   secret store (alongside the AKSK pairs used by the Claude models).
4. **Model IDs:** `openai.gpt-5.5`, `openai.gpt-5.4`.

## The litellm gap (and the fix)

litellm's `bedrock_mantle` provider does **not** register a Responses API config.
When a `bedrock_mantle/openai.gpt-5.x` request arrives, litellm falls back to its
responses→chat/completions transformation handler, which:

- trips `functools.partial() got multiple values for keyword argument 'acompletion'`, and
- sends a chat/completions request to a model that only accepts the responses protocol.

The result is a 500 / protocol-mismatch even though the model, key, and endpoint
are all correct.

### Fix: a `sitecustomize.py` monkey-patch (no image rebuild)

Rather than forking/rebuilding the litellm image, inject a small
`sitecustomize.py` that registers a `BedrockMantleResponsesConfig` at interpreter
startup. Python auto-imports `sitecustomize` from any directory on `PYTHONPATH`,
so mounting it and setting `PYTHONPATH=/opt/inject` is enough — it applies to
every gunicorn worker, before litellm finishes importing.

The patch wraps `ProviderConfigManager._get_python_responses_api_config` so that
the `bedrock_mantle` provider returns a config whose `get_complete_url` points at
`/openai/v1/responses`. The full script lives at
`cdk/lib/manifests/bedrock-mantle-sitecustomize.py` and is mounted as a ConfigMap.

In this CDK stack (`cdk/lib/cluster-stack.ts`) the wiring is:

- a `litellm-bedrock-mantle-patch` ConfigMap holding `sitecustomize.py`;
- the litellm Deployment mounts it at `/opt/inject` and sets `PYTHONPATH=/opt/inject`.

## Model entries

Added to `cdk/lib/manifests/litellm-config.yaml` (pricing per AWS Bedrock official
rates; update if AWS changes them):

```yaml
  - model_name: gpt-5.5
    litellm_params:
      model: bedrock_mantle/openai.gpt-5.5
      api_key: os.environ/BEDROCK_MANTLE_API_KEY
      api_base: "https://bedrock-mantle.us-east-2.api.aws/v1"
    model_info:
      mode: responses
      supports_reasoning: true
      input_cost_per_token: 0.0000055    # $5.50 / 1M
      output_cost_per_token: 0.000033    # $33.00 / 1M

  - model_name: gpt-5.4
    litellm_params:
      model: bedrock_mantle/openai.gpt-5.4
      api_key: os.environ/BEDROCK_MANTLE_API_KEY
      api_base: "https://bedrock-mantle.us-east-2.api.aws/v1"
    model_info:
      mode: responses
      supports_reasoning: true
      input_cost_per_token: 0.00000275   # $2.75 / 1M
      output_cost_per_token: 0.0000165   # $16.50 / 1M
```

> Use the dotted names (`gpt-5.5` / `gpt-5.4`) so external clients using the
> OpenAI SDK can call them without surprises, matching OpenAI/Bedrock conventions.

## Verify

After deploy, confirm the patch loaded and the models answer. Replace
`<PROXY_URL>` with your proxy endpoint and `<KEY>` with a litellm virtual/master key.

Patch loaded (pod log should contain):

```
[sitecustomize] bedrock_mantle Responses API monkey-patch applied
```

Chat Completions entrypoint (litellm bridges it to responses internally):

```bash
curl -s "$PROXY_URL/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"hi"}],"max_tokens":50}'
```

Native Responses entrypoint (supports `reasoning.effort`):

```bash
curl -s "$PROXY_URL/v1/responses" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","input":"hi","reasoning":{"effort":"low"}}'
```

Both should return HTTP 200 with `"model":"gpt-5.5"`.

## Notes

- The `bedrock_mantle` open-weight models (`gpt-oss-*`) use the normal
  chat/completions path and are unaffected by this patch.
- The patch is defensive (`try/except`, never breaks interpreter startup) and is
  a no-op for any provider other than `bedrock_mantle`.
- Retirement: once litellm ships native bedrock_mantle responses support, bump
  the image and remove the ConfigMap, the `/opt/inject` mount, and the
  `PYTHONPATH` env.
