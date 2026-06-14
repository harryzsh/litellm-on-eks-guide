"""
Runtime monkey-patch injecting bedrock_mantle Responses API support into litellm
WITHOUT modifying any official source file under /app/litellm.

Why: litellm's bedrock_mantle provider has no Responses API config registered,
so OpenAI frontier models (GPT-5.5 / GPT-5.4), which are responses-only on
Bedrock, get downgraded to the responses->chat/completions transformation path.
That path both trips a `functools.partial() got multiple values for keyword
argument 'acompletion'` error and sends chat/completions to a model that only
accepts the responses protocol. This patch registers a BedrockMantleResponsesConfig
so the request is routed natively to /openai/v1/responses.

How it loads: this file is named `sitecustomize.py` and its directory is placed
on PYTHONPATH (see the litellm Deployment env + /opt/inject volume mount), so the
Python interpreter imports it automatically at startup, for every gunicorn worker.

Retirement: once litellm ships native bedrock_mantle responses support and the
image is bumped, remove the ConfigMap, the mount, and the PYTHONPATH entry.
"""
import sys


def _apply_patch():
    import litellm
    from litellm.types.utils import LlmProviders
    from litellm.secret_managers.main import get_secret_str
    from litellm.llms.openai.responses.transformation import (
        OpenAIResponsesAPIConfig,
    )

    class BedrockMantleResponsesConfig(OpenAIResponsesAPIConfig):
        """OpenAI-compatible Responses API config for the bedrock_mantle provider."""

        @property
        def custom_llm_provider(self):
            return LlmProviders.BEDROCK_MANTLE

        def validate_environment(self, headers, model, litellm_params=None):
            from litellm.types.router import GenericLiteLLMParams

            litellm_params = litellm_params or GenericLiteLLMParams()
            api_key = getattr(litellm_params, "api_key", None) or get_secret_str(
                "BEDROCK_MANTLE_API_KEY"
            )
            headers.update({"Authorization": f"Bearer {api_key}"})
            return headers

        def get_complete_url(self, api_base, litellm_params):
            # litellm_params may be a dict here
            region = "us-east-2"
            if isinstance(litellm_params, dict):
                region = (
                    litellm_params.get("aws_region_name")
                    or litellm_params.get("region_name")
                    or region
                )
            api_base = (
                api_base
                or get_secret_str("BEDROCK_MANTLE_API_BASE")
                or f"https://bedrock-mantle.{region}.api.aws/v1"
            )
            api_base = api_base.rstrip("/")
            # Normalize to the host root, stripping any already-present responses
            # endpoint suffix, so we always append exactly one /openai/v1/responses.
            for suffix in (
                "/openai/v1/responses",
                "/openai/v1",
                "/v1/responses",
                "/responses",
                "/v1",
            ):
                if api_base.endswith(suffix):
                    api_base = api_base[: -len(suffix)]
                    break
            api_base = api_base.rstrip("/")
            return f"{api_base}/openai/v1/responses"

    # Expose the class on the litellm namespace (parity with native configs)
    litellm.BedrockMantleResponsesConfig = BedrockMantleResponsesConfig

    from litellm.utils import ProviderConfigManager

    _orig = ProviderConfigManager._get_python_responses_api_config

    def _patched_get_python_responses_api_config(provider, model=None):
        if provider == LlmProviders.BEDROCK_MANTLE:
            return BedrockMantleResponsesConfig()
        return _orig(provider, model)

    # _orig is a staticmethod-bound plain function; assign as staticmethod
    ProviderConfigManager._get_python_responses_api_config = staticmethod(
        _patched_get_python_responses_api_config
    )

    print(
        "[sitecustomize] bedrock_mantle Responses API monkey-patch applied",
        file=sys.stderr,
        flush=True,
    )


try:
    _apply_patch()
except Exception as e:  # never break interpreter startup
    print(f"[sitecustomize] patch FAILED: {e!r}", file=sys.stderr, flush=True)
