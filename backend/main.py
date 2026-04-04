from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any
from agent import stream_agent
from voice import handle_websocket

app = FastAPI(title="AI Brainstorm Canvas API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    canvas_state: list[dict[str, Any]] = []


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


@app.websocket("/ws/{room_id}/{username}")
async def websocket_endpoint(ws: WebSocket, room_id: str, username: str):
    await handle_websocket(ws, room_id, username)


@app.get("/health")
def health():
    return {"status": "ok"}
