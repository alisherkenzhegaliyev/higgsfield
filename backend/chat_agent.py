"""
Chat agent API router.

Exposes POST /api/chat/stream — a streaming SSE endpoint that takes a message
and the current canvas snapshot, then streams back canvas actions + a message
reply.
"""

import json
import logging
from typing import Any, AsyncIterator, Iterator

import anthropic
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from agent.prompts import ACTION_SCHEMA, CHAT_AGENT_SYSTEM
from agent.tools import format_canvas
from config import get_settings
from context.graph import run_context_agent

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
# Streaming generators
# ---------------------------------------------------------------------------


def _stream_legacy_agent(message: str, canvas_state: list[dict]) -> Iterator[str]:
    """Fallback path using the original prompt-only chat agent."""
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

    start = buffer.find("{")
    if start != -1:
        parsed = _close_and_parse_json(buffer[start:])
        if parsed:
            actions = parsed.get("actions", [])
            while len(actions) > cursor:
                yield f"data: {json.dumps({'type': 'action', 'action': actions[cursor]})}\n\n"
                cursor += 1

    yield f"data: {json.dumps({'type': 'done'})}\n\n"


async def _stream_agent(
    message: str,
    canvas_snapshot: dict[str, Any],
    room_id: str,
) -> AsyncIterator[str]:
    try:
        actions = await run_context_agent(
            message=message,
            canvas_snapshot=canvas_snapshot,
            room_id=room_id,
        )
    except Exception:
        logger.exception(
            "context-aware chat failed for room=%s; falling back to legacy prompt",
            room_id,
        )
        for event in _stream_legacy_agent(message, canvas_snapshot.get("shapes", [])):
            yield event
        return

    for action in actions:
        yield f"data: {json.dumps({'type': 'action', 'action': action})}\n\n"

    yield f"data: {json.dumps({'type': 'done'})}\n\n"


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    message: str
    canvas_state: list[dict[str, Any]] = Field(default_factory=list)
    canvas_snapshot: dict[str, Any] = Field(default_factory=dict)
    room_id: str = "main"


def _coerce_canvas_snapshot(body: ChatRequest) -> dict[str, Any]:
    snapshot = dict(body.canvas_snapshot)
    shapes = snapshot.get("shapes")

    if not isinstance(shapes, list) or (not shapes and body.canvas_state):
        snapshot["shapes"] = list(body.canvas_state)

    selected_ids = snapshot.get("selected_ids")
    if not isinstance(selected_ids, list):
        snapshot["selected_ids"] = []

    viewport = snapshot.get("viewport")
    if viewport is not None and not isinstance(viewport, dict):
        snapshot.pop("viewport", None)

    return snapshot


@router.post("/api/chat/stream")
async def chat_stream(body: ChatRequest):
    canvas_snapshot = _coerce_canvas_snapshot(body)
    return StreamingResponse(
        _stream_agent(body.message, canvas_snapshot, body.room_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
