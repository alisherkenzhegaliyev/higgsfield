import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from chat_agent import router as chat_router
from db import init_db
from ws_handler import handle_websocket

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    logger.info("Database ready")
    yield


app = FastAPI(title="Higgsfield API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat_router)


@app.websocket("/ws/{room_id}/{username}")
async def websocket_endpoint(ws: WebSocket, room_id: str, username: str):
    await handle_websocket(ws, room_id, username)


@app.get("/health")
def health():
    return {"status": "ok"}
