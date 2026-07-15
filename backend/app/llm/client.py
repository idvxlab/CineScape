"""LLM client — async wrapper around the OpenAI-compatible API.

Uses DeepSeek V4 Flash (dev) or Claude/Qwen (prod) via the OpenAI SDK.
Configuration comes from environment variables via pydantic-settings.
"""

from __future__ import annotations

import contextvars
from functools import lru_cache
from typing import Callable

from openai import AsyncOpenAI
from pydantic_settings import BaseSettings

# When set (by a streaming endpoint), chat() streams and calls this with each
# reasoning_content delta — so the model's thinking can be shown live while waiting.
reasoning_stream_cb: contextvars.ContextVar[Callable[[str], None] | None] = contextvars.ContextVar(
    "reasoning_stream_cb", default=None
)


class LLMSettings(BaseSettings):
    llm_api_key: str = ""
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_model: str = "deepseek-chat"
    # "chat_completions" for legacy compatible providers; "responses" for
    # reasoning models that expose summary streaming through /v1/responses.
    llm_api_style: str = "chat_completions"
    # 视觉模型(描述用户上传的基底图);留空则尝试主模型,失败优雅降级
    llm_vision_model: str = ""
    # 图像编辑模型(逐镜渲染关键帧, ADR-0012)
    image_model: str = "qwen-image-2.0"
    embedding_model: str = "text-embedding-3-small"
    embedding_api_key: str = ""
    embedding_base_url: str = "https://api.openai.com/v1"
    embedding_dim: int = 768

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


@lru_cache
def get_llm_settings() -> LLMSettings:
    return LLMSettings()


class LLMClient:
    """Async LLM client wrapping OpenAI SDK."""

    def __init__(self, settings: LLMSettings | None = None) -> None:
        s = settings or get_llm_settings()
        self.api_key = s.llm_api_key
        self.base_url = s.llm_base_url
        self.model = s.llm_model
        self.api_style = s.llm_api_style
        self._client: AsyncOpenAI | None = None

    def _ensure_client(self) -> AsyncOpenAI:
        """Lazy-init the OpenAI client. Don't fail on empty key here -
        actual API call will fail with a clearer error via try/except."""
        if self._client is None:
            self._client = AsyncOpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
            )
        return self._client

    async def chat(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        json_mode: bool = True,
        return_reasoning: bool = False,
        enable_thinking: bool = True,
    ) -> "str | tuple[str, str]":
        """Send a chat completion request.

        Returns the assistant message text. When ``return_reasoning`` is True,
        returns ``(content, reasoning)`` — reasoning is the model's thinking trace
        (``reasoning_content``), already produced by the thinking model so it costs
        no extra tokens; trimmed for display.
        When json_mode=True, automatically uses response_format={"type": "json_object"}.

        ``enable_thinking``: qwen3.7-plus is a thinking model that emits thousands of
        chars of reasoning_content per call (~5.7× slower). Structured-judgement nodes
        (align/convergence/strategy/critic/edit) don't need a thinking chain — pass
        ``enable_thinking=False`` to forward ``extra_body={"enable_thinking": False}``
        to the Aliyun maas compatible-mode endpoint and skip thinking. Only generate
        keeps it on. Trade-off: no live "grey reasoning" stream while thinking is off.
        """
        if self.api_style == "responses":
            return await self._responses_chat(
                system_prompt,
                user_prompt,
                max_tokens=max_tokens,
                json_mode=json_mode,
                return_reasoning=return_reasoning,
                enable_thinking=enable_thinking,
            )

        kwargs = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        if not enable_thinking:
            kwargs["extra_body"] = {"enable_thinking": False}

        cb = reasoning_stream_cb.get()
        # With thinking off there is no reasoning_content to stream — skip the
        # streaming path (no grey-text trace) and take the faster non-streaming call.
        if cb is not None and enable_thinking:
            # streaming: forward each reasoning_content delta live, accumulate content + reasoning
            kwargs["stream"] = True
            stream = await self._ensure_client().chat.completions.create(**kwargs)
            content = ""
            reasoning = ""
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                rc = getattr(delta, "reasoning_content", None)
                if rc:
                    reasoning += rc
                    try:
                        cb(rc)
                    except Exception:
                        pass
                if delta.content:
                    content += delta.content
        else:
            response = await self._ensure_client().chat.completions.create(**kwargs)
            msg = response.choices[0].message
            content = msg.content or ""
            reasoning = (getattr(msg, "reasoning_content", None) or "") if return_reasoning else ""

        if return_reasoning:
            if len(reasoning) > 600:  # 只取一小段思考过程展示
                reasoning = reasoning[:600].rstrip() + "…"
            return content, reasoning
        return content

    async def _responses_chat(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        max_tokens: int,
        json_mode: bool,
        return_reasoning: bool,
        enable_thinking: bool,
    ) -> "str | tuple[str, str]":
        """Call /v1/responses and forward its reasoning-summary deltas."""
        responses_input = user_prompt
        if json_mode:
            # Responses providers validate the user input itself (not only
            # `instructions`) for an explicit JSON-output request.
            responses_input += "\n\nReturn the response as a valid JSON object."

        kwargs = {
            "model": self.model,
            "instructions": system_prompt,
            "input": responses_input,
            "max_output_tokens": max_tokens,
            "reasoning": {
                "effort": "medium" if enable_thinking else "none",
                "summary": "detailed" if enable_thinking else None,
            },
        }
        if json_mode:
            kwargs["text"] = {"format": {"type": "json_object"}}

        cb = reasoning_stream_cb.get()
        if cb is not None and enable_thinking:
            stream = await self._ensure_client().responses.create(**kwargs, stream=True)
            content = ""
            reasoning = ""
            async for event in stream:
                event_type = getattr(event, "type", "")
                delta = getattr(event, "delta", "") or ""
                if event_type in {
                    "response.reasoning_summary_text.delta",
                    "response.reasoning_text.delta",
                }:
                    reasoning += delta
                    try:
                        cb(delta)
                    except Exception:
                        pass
                elif event_type == "response.output_text.delta":
                    content += delta
        else:
            response = await self._ensure_client().responses.create(**kwargs)
            content = response.output_text or ""
            reasoning = ""
            if return_reasoning:
                for item in response.output:
                    if getattr(item, "type", "") != "reasoning":
                        continue
                    for part in getattr(item, "summary", []) or []:
                        reasoning += getattr(part, "text", "") or ""

        if return_reasoning:
            if len(reasoning) > 600:
                reasoning = reasoning[:600].rstrip() + "…"
            return content, reasoning
        return content

    async def describe_image(self, image_path: str) -> str | None:
        """Describe an uploaded reference image for the design pipeline.

        Uses ``llm_vision_model`` if configured, otherwise tries the main
        model.  Returns None on any failure — the pipeline degrades to
        text-only gracefully.
        """
        import base64
        import mimetypes
        from pathlib import Path

        s = get_llm_settings()
        model = s.llm_vision_model or self.model

        path = Path(image_path)
        mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
        data = base64.b64encode(path.read_bytes()).decode()

        try:
            response = await self._ensure_client().chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    "用一段话客观描述这张画面,供镜头设计参考:"
                                    "主体与动作、环境与空间、光线与色调、构图与机位感、"
                                    "画面中可辨认的情绪线索。不要展开解读,只描述可见内容。"
                                ),
                            },
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:{mime};base64,{data}"},
                            },
                        ],
                    }
                ],
                temperature=0.3,
                max_tokens=512,
            )
            return response.choices[0].message.content or None
        except Exception:
            import logging

            logging.getLogger(__name__).warning(
                "Vision description failed (model=%s), degrading to text-only", model
            )
            return None

    async def get_embedding(self, text: str) -> list[float]:
        """Get embedding vector for a text string using the configured embedding model."""
        s = get_llm_settings()
        client = AsyncOpenAI(
            api_key=s.embedding_api_key or self.api_key,
            base_url=s.embedding_base_url,
        )
        response = await client.embeddings.create(
            model=s.embedding_model,
            input=text,
        )
        return response.data[0].embedding


# Singleton
_client: LLMClient | None = None


def get_llm_client() -> LLMClient:
    global _client
    if _client is None:
        _client = LLMClient()
    return _client
