"""Intent classifier — decides if a transcript is a canvas command."""

import logging

import openai

from agent.prompts import CLASSIFIER_SYSTEM
from config import get_settings

logger = logging.getLogger(__name__)

_client: openai.OpenAI | None = None


def _get_client() -> openai.OpenAI:
    global _client
    if _client is None:
        s = get_settings()
        _client = openai.OpenAI(api_key=s.llm_api_key, base_url=s.llm_base_url)
    return _client


def is_canvas_command(transcript: str) -> bool:
    """Return True if the transcript looks like a canvas command."""
    response = _get_client().chat.completions.create(
        model=get_settings().classifier_model,
        max_tokens=5,
        messages=[
            {"role": "system", "content": CLASSIFIER_SYSTEM},
            {"role": "user", "content": transcript},
        ],
    )
    result = response.choices[0].message.content.strip().upper().startswith("YES")
    logger.debug("classifier '%s' → %s", transcript[:60], result)
    return result
