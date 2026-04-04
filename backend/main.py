import asyncio
import json
import os
import ssl
import urllib.request

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel
from typing import Any
from agent import stream_agent
from higgsfield import submit_image_generation, submit_video_generation, get_request_status

app = FastAPI(title="AI Brainstorm Canvas API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory store for generation status: request_id -> {status, url, error}
_generations: dict[str, dict] = {}


class ChatRequest(BaseModel):
    message: str
    canvas_state: list[dict[str, Any]] = []


class GenerateRequest(BaseModel):
    type: str  # "image" or "video"
    prompt: str
    x: float = 200
    y: float = 200
    image_url: str | None = None


@app.post("/api/chat/stream")
def chat_stream(body: ChatRequest):
    return StreamingResponse(
        stream_agent(body.message, body.canvas_state),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


async def _poll_loop(request_id: str):
    """Poll Higgsfield until terminal status, updating _generations dict."""
    for _ in range(90):  # 90 × 2s = ~3 min max
        await asyncio.sleep(2)
        try:
            status = await get_request_status(request_id)
            s = status.get("status", "")
            if s == "completed":
                url = None
                images = status.get("images")
                if images and len(images) > 0:
                    url = images[0].get("url")
                if not url:
                    video = status.get("video")
                    if video:
                        url = video.get("url")
                _generations[request_id] = {"status": "completed", "url": url}
                return
            if s in ("failed", "nsfw", "cancelled"):
                _generations[request_id] = {"status": "failed", "error": s}
                return
        except Exception as e:
            print(f"[poll] error for {request_id}: {e}")
    # Timed out
    _generations[request_id] = {"status": "failed", "error": "timeout"}


def _extract_url(status: dict) -> str | None:
    images = status.get("images")
    if images:
        return images[0].get("url")
    video = status.get("video")
    if video:
        return video.get("url")
    return None


@app.post("/api/generation-webhook")
async def generation_webhook(request: Request):
    """Higgsfield POSTs here on completion when PUBLIC_URL is configured."""
    try:
        body = await request.json()
    except Exception:
        return {"ok": False}
    request_id = body.get("request_id")
    if not request_id:
        return {"ok": False}
    s = body.get("status", "")
    if s == "completed":
        _generations[request_id] = {"status": "completed", "url": _extract_url(body)}
    elif s in ("failed", "nsfw", "cancelled"):
        _generations[request_id] = {"status": "failed", "error": s}
    return {"ok": True}


@app.post("/api/generate")
async def generate(body: GenerateRequest):
    public_url = os.environ.get("PUBLIC_URL", "").rstrip("/")
    webhook = f"{public_url}/api/generation-webhook" if public_url else None
    try:
        if body.type == "video":
            if not body.image_url:
                return {"error": "image_url required for video generation"}, 400
            result = await submit_video_generation(body.image_url, body.prompt, webhook_url=webhook)
        else:
            result = await submit_image_generation(body.prompt)
    except Exception as e:
        return {"error": str(e)}

    request_id = result["request_id"]
    _generations[request_id] = {"status": "generating", "url": None}
    # Poll loop always runs as fallback; webhook (if fired) updates the dict first
    asyncio.create_task(_poll_loop(request_id))
    return {"request_id": request_id}


@app.get("/api/generation-status/{request_id}")
async def generation_status(request_id: str):
    async def stream():
        while True:
            gen = _generations.get(request_id)
            if not gen:
                yield f"data: {json.dumps({'status': 'failed', 'error': 'not found'})}\n\n"
                return
            yield f"data: {json.dumps(gen)}\n\n"
            if gen["status"] in ("completed", "failed"):
                return
            await asyncio.sleep(1)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/proxy-media")
async def proxy_media(url: str):
    """Proxy Higgsfield CDN images/videos to avoid CORS issues."""
    cors = {"Access-Control-Allow-Origin": "*"}

    def _fetch():
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
            content = r.read()
            content_type = r.headers.get("Content-Type", "application/octet-stream")
        return content, content_type

    try:
        loop = asyncio.get_running_loop()
        content, content_type = await loop.run_in_executor(None, _fetch)
        return Response(content=content, media_type=content_type, headers=cors)
    except Exception as e:
        print(f"[proxy] FAILED {url!r}: {type(e).__name__}: {e}")
        return Response(content=str(e).encode(), status_code=502, headers=cors)


@app.get("/health")
def health():
    return {"status": "ok"}
