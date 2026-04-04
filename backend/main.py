import asyncio
import base64
import io
import json
import os
import ssl
import urllib.request

import httpx
from PIL import Image

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel
from typing import Any
from agent import stream_agent, _detect_moodboard
from pinterest import fetch_pinterest_images
from higgsfield import (
    submit_image_generation, submit_flux_generation,
    submit_video_generation, submit_dop_turbo_generation, submit_kling_generation,
    get_request_status,
)

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
    type: str          # "image" or "video"
    prompt: str
    x: float = 200
    y: float = 200
    image_url: str | None = None
    model: str = "seedream"   # image: "seedream" | "flux" / video: "dop_standard" | "dop_turbo"
    resolution: str = "2K"    # "1K" | "2K" | "4K"
    aspect_ratio: str = "16:9"
    duration: int = 3          # seconds (video only)


@app.post("/api/chat/stream")
def chat_stream(body: ChatRequest):
    pinterest_images = []
    if _detect_moodboard(body.message):
        pinterest_images = fetch_pinterest_images(body.message, max_results=5)

    return StreamingResponse(
        stream_agent(body.message, body.canvas_state, pinterest_images),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


async def _poll_loop(request_id: str):
    """Poll Higgsfield until terminal status, updating _generations dict."""
    for i in range(180):  # 180 × 2s = ~6 min max
        await asyncio.sleep(2)
        try:
            status = await get_request_status(request_id)
            s = status.get("status", "")
            if i % 10 == 0:
                print(f"[poll] {request_id} tick={i} status={s}")
            if s == "completed":
                print(f"[poll] completed response for {request_id}: {status}")
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
            if body.model == "dop_turbo":
                result = await submit_dop_turbo_generation(body.image_url, body.prompt, body.duration, webhook_url=webhook)
            elif body.model == "kling":
                result = await submit_kling_generation(body.image_url, body.prompt, body.duration, webhook_url=webhook)
            else:
                result = await submit_video_generation(body.image_url, body.prompt, body.duration, webhook_url=webhook)
        else:
            if body.model == "flux":
                result = await submit_flux_generation(body.prompt, body.aspect_ratio, body.resolution)
            else:
                result = await submit_image_generation(body.prompt, body.aspect_ratio, body.resolution)
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


@app.get("/api/proxy-image")
async def proxy_image(url: str = Query(...)):
    """Proxy Pinterest images to avoid CORS issues."""
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            return Response(
                content=r.content,
                media_type=r.headers.get("content-type", "image/jpeg"),
            )
    except Exception:
        return Response(status_code=404)


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


def _preprocess_image(image_bytes: bytes) -> tuple[bytes, str, str]:
    """Resize to max 1920px, strip alpha, convert to JPEG — ensures model compatibility."""
    img = Image.open(io.BytesIO(image_bytes))
    img = img.convert("RGB")  # remove alpha channel (PNG transparency)
    if img.width > 1920 or img.height > 1920:
        img.thumbnail((1920, 1920), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=92)
    return out.getvalue(), "image/jpeg", "jpg"


async def _upload_to_public_host(image_bytes: bytes, mime: str, ext: str) -> str:
    """Try catbox.moe then transfer.sh. Returns public URL or raises."""
    filename = f"image.{ext}"
    async with httpx.AsyncClient(timeout=30) as client:
        # 1. catbox.moe — permanent, no auth needed
        try:
            res = await client.post(
                "https://catbox.moe/user/api.php",
                data={"reqtype": "fileupload"},
                files={"fileToUpload": (filename, image_bytes, mime)},
            )
            if res.status_code == 200 and res.text.strip().startswith("https://"):
                return res.text.strip()
            print(f"[upload] catbox.moe failed ({res.status_code}): {res.text[:100]}")
        except Exception as e:
            print(f"[upload] catbox.moe error: {e}")

        # 2. transfer.sh — fallback
        try:
            res = await client.put(
                f"https://transfer.sh/{filename}",
                content=image_bytes,
                headers={"Content-Type": mime, "Max-Days": "1"},
            )
            if res.status_code == 200 and res.text.strip().startswith("https://"):
                return res.text.strip()
            print(f"[upload] transfer.sh failed ({res.status_code}): {res.text[:100]}")
        except Exception as e:
            print(f"[upload] transfer.sh error: {e}")

    raise RuntimeError("All upload services failed")


@app.post("/api/upload-image")
async def upload_image(request: Request):
    """Upload a local data-URL image to a public host and return the public URL."""
    cors = {"Access-Control-Allow-Origin": "*"}
    try:
        body = await request.json()
        data_url: str = body.get("data_url", "")
        if not data_url.startswith("data:"):
            return Response(content=b"Expected data URL", status_code=400, headers=cors)

        header, b64data = data_url.split(",", 1)
        mime = header.split(":")[1].split(";")[0]   # e.g. "image/png"
        ext = mime.split("/")[-1].split("+")[0]     # "png", "jpeg", "webp"
        image_bytes = base64.b64decode(b64data)
        image_bytes, mime, ext = _preprocess_image(image_bytes)

        public_url = await _upload_to_public_host(image_bytes, mime, ext)
        return Response(
            content=json.dumps({"url": public_url}).encode(),
            media_type="application/json",
            headers=cors,
        )
    except Exception as e:
        print(f"[upload] error: {e}")
        return Response(
            content=json.dumps({"error": str(e)}).encode(),
            status_code=500,
            media_type="application/json",
            headers=cors,
        )


@app.get("/health")
def health():
    return {"status": "ok"}
