"""
Chat agent API router.

Exposes POST /api/chat/stream — a streaming SSE endpoint that takes a message
and the current canvas state, then streams back canvas actions + a message reply.
"""

import json
import logging
from typing import Any

import anthropic
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agent.prompts import ACTION_SCHEMA, CHAT_AGENT_SYSTEM
from agent.tools import format_canvas
from chat_streaming import _detect_moodboard, stream_agent
from config import get_settings
from pinterest import fetch_pinterest_images

logger = logging.getLogger(__name__)

router = APIRouter()

_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=get_settings().anthropic_api_key)
    return _client


# ---------------------------------------------------------------------------
# JSON streaming helper
# ---------------------------------------------------------------------------


def _close_and_parse_json(s: str) -> dict | None:
    """Parse a potentially incomplete JSON string by closing open brackets."""
    stack: list[str] = []
    i = 0
    while i < len(s):
        char = s[i]
        last = stack[-1] if stack else None
        if char == '"':
            if i > 0 and s[i - 1] == "\\":
                i += 1
                continue
            if last == '"':
                stack.pop()
            else:
                stack.append('"')
        if last == '"':
            i += 1
            continue
        if char in ("{", "["):
            stack.append(char)
        elif char == "}" and last == "{":
            stack.pop()
        elif char == "]" and last == "[":
            stack.pop()
        i += 1

    result = s
    for opening in reversed(stack):
        result += {"{": "}", "[": "]", '"': '"'}[opening]

    try:
        return json.loads(result)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Streaming generator
# ---------------------------------------------------------------------------


def _stream_agent(message: str, canvas_state: list[dict]) -> Any:
    """Sync generator yielding SSE-formatted events."""
    settings = get_settings()
    system = CHAT_AGENT_SYSTEM.format(
        canvas=format_canvas(canvas_state),
        schema=ACTION_SCHEMA,
    )
    buffer = ""
    cursor = 0

    with _get_client().messages.stream(
        model=settings.chat_agent_model,
        max_tokens=4096,
        system=system,
        messages=[{"role": "user", "content": message}],
    ) as stream:
        for text in stream.text_stream:
            buffer += text
            start = buffer.find("{")
            if start == -1:
                continue
            parsed = _close_and_parse_json(buffer[start:])
            if not parsed:
                continue
            actions = parsed.get("actions")
            if not isinstance(actions, list):
                continue
            while len(actions) > cursor + 1:
                yield f"data: {json.dumps({'type': 'action', 'action': actions[cursor]})}\n\n"
                cursor += 1

    # Emit any remaining actions after stream closes.
    start = buffer.find("{")
    if start != -1:
        parsed = _close_and_parse_json(buffer[start:])
        if parsed:
            actions = parsed.get("actions", [])
            while len(actions) > cursor:
                yield f"data: {json.dumps({'type': 'action', 'action': actions[cursor]})}\n\n"
                cursor += 1

    yield f"data: {json.dumps({'type': 'done'})}\n\n"


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    message: str
    canvas_state: list[dict[str, Any]] = []


@router.post("/api/chat/stream")
def chat_stream(body: ChatRequest):
    pinterest_images = []
    if _detect_moodboard(body.message):
        pinterest_images = fetch_pinterest_images(body.message, max_results=5)

    generator = (
        stream_agent(body.message, body.canvas_state, pinterest_images)
        if pinterest_images
        else _stream_agent(body.message, body.canvas_state)
    )
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
