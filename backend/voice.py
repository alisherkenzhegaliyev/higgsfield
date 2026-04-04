import asyncio
import json
import time
from typing import Any
from fastapi import WebSocket, WebSocketDisconnect


class ConversationBuffer:
    SILENCE_THRESHOLD_SEC = 3.0
    MIN_EXCHANGES = 1

    def __init__(self):
        self._entries: list[dict] = []  # {username, text, ts}
        self._triggered = False

    def add(self, username: str, text: str):
        self._entries.append({"username": username, "text": text, "ts": time.time()})
        self._triggered = False  # new speech resets trigger guard

    def should_trigger(self) -> bool:
        if self._triggered:
            return False
        if len(self._entries) < self.MIN_EXCHANGES:
            return False
        elapsed = time.time() - self._entries[-1]["ts"]
        return elapsed >= self.SILENCE_THRESHOLD_SEC

    def mark_triggered(self):
        self._triggered = True

    def format(self) -> str:
        return "\n".join(f"{e['username']}: {e['text']}" for e in self._entries)

    def clear(self):
        self._entries.clear()
        self._triggered = False


class RoomManager:
    def __init__(self):
        # room_id → {username: WebSocket}
        self._rooms: dict[str, dict[str, WebSocket]] = {}
        # room_id → ConversationBuffer
        self._buffers: dict[str, ConversationBuffer] = {}
        # room_id → canvas_state (last known, sent by any client)
        self._canvas: dict[str, list[dict]] = {}
        # room_id → pending wake word command being accumulated
        self._pending_command: dict[str, str] = {}
        # room_id → asyncio task waiting to flush the command
        self._pending_task: dict[str, asyncio.Task] = {}

    def _ensure_room(self, room_id: str):
        if room_id not in self._rooms:
            self._rooms[room_id] = {}
            self._buffers[room_id] = ConversationBuffer()
            self._canvas[room_id] = []

    def get_buffer(self, room_id: str) -> ConversationBuffer:
        self._ensure_room(room_id)
        return self._buffers[room_id]

    def get_canvas(self, room_id: str) -> list[dict]:
        return self._canvas.get(room_id, [])

    def set_canvas(self, room_id: str, canvas_state: list[dict]):
        self._canvas[room_id] = canvas_state

    async def join(self, room_id: str, username: str, ws: WebSocket):
        self._ensure_room(room_id)
        self._rooms[room_id][username] = ws
        await self._broadcast_room_update(room_id)

    async def leave(self, room_id: str, username: str):
        room = self._rooms.get(room_id, {})
        room.pop(username, None)
        if not room:
            self._rooms.pop(room_id, None)
            self._buffers.pop(room_id, None)
            self._canvas.pop(room_id, None)
        else:
            await self._broadcast_room_update(room_id)

    async def relay(self, room_id: str, to: str, msg: dict):
        room = self._rooms.get(room_id, {})
        ws = room.get(to)
        if ws:
            await ws.send_text(json.dumps(msg))

    async def broadcast(self, room_id: str, msg: dict, exclude: str | None = None):
        room = self._rooms.get(room_id, {})
        dead = []
        for username, ws in room.items():
            if username == exclude:
                continue
            try:
                await ws.send_text(json.dumps(msg))
            except Exception:
                dead.append(username)
        for u in dead:
            room.pop(u, None)

    async def _broadcast_room_update(self, room_id: str):
        room = self._rooms.get(room_id, {})
        users = [{"username": u} for u in room]
        await self.broadcast(room_id, {"type": "room_update", "users": users})

    def users_in_room(self, room_id: str) -> list[str]:
        return list(self._rooms.get(room_id, {}).keys())


room_manager = RoomManager()


async def _handle_audio(room_id: str, username: str, audio_b64: str):
    """Transcribe an audio chunk via Whisper and process the result."""
    from whisper_transcribe import transcribe
    try:
        text = await asyncio.to_thread(transcribe, audio_b64)
    except Exception as e:
        print(f"Whisper error for {username}: {e}")
        return
    if not text:
        return
    print(f"[transcript] {username}: {text}")
    # Broadcast to all in room so everyone sees the transcript
    await room_manager.broadcast(
        room_id,
        {"type": "transcript", "username": username, "text": text},
    )
    room_manager.get_buffer(room_id).add(username, text)

    if room_id in room_manager._pending_command:
        # Already triggered — append continuation chunk and reset flush timer
        room_manager._pending_command[room_id] += " " + text
        existing = room_manager._pending_task.get(room_id)
        if existing and not existing.done():
            existing.cancel()
        room_manager._pending_task[room_id] = asyncio.create_task(_flush_command(room_id))
        return

    import re
    words = set(re.sub(r"[^a-z ]", "", text.lower()).split())

    # Fast path: wake word variants (free, instant)
    HIGGS_VARIANTS = {"higgs", "higs", "highs", "hicks", "fix", "hix", "higg", "his", "hex",
                      "хиггс", "хигс", "хикс", "хиг"}
    if any(w in HIGGS_VARIANTS for w in words) or any(w in HIGGS_VARIANTS for w in text.lower().split()):
        room_manager._pending_command[room_id] = text
        existing = room_manager._pending_task.get(room_id)
        if existing and not existing.done():
            existing.cancel()
        room_manager._pending_task[room_id] = asyncio.create_task(_flush_command(room_id))
        return

    # Fallback: only run classifier if transcript has strong command keywords
    COMMAND_KEYWORDS = {
        # English
        "create", "draw", "make", "add", "build", "show", "generate",
        "diagram", "flowchart", "mindmap", "uml", "chart", "note", "sticky",
        # Russian
        "создай", "создать", "нарисуй", "нарисовать", "добавь", "добавить",
        "сделай", "сделать", "покажи", "построй", "диаграмму", "диаграмма",
        "схему", "схема", "заметку", "заметка", "граф",
    }
    text_words = set(text.lower().split())
    if any(w in COMMAND_KEYWORDS for w in text_words):
        asyncio.create_task(_classify_and_maybe_trigger(room_id, text))


async def _classify_and_maybe_trigger(room_id: str, text: str):
    """Run LLM classifier; if it's a canvas command, start accumulation window."""
    from intent import is_canvas_command
    try:
        is_command = await asyncio.to_thread(is_canvas_command, text)
    except Exception as e:
        print(f"[classifier] error: {e}")
        return
    print(f"[classifier] '{text[:60]}' → {'YES' if is_command else 'NO'}")
    if is_command:
        room_manager._pending_command[room_id] = text
        existing = room_manager._pending_task.get(room_id)
        if existing and not existing.done():
            existing.cancel()
        room_manager._pending_task[room_id] = asyncio.create_task(_flush_command(room_id))


async def _flush_command(room_id: str):
    """Wait one extra chunk interval, then fire the listener with accumulated command."""
    await asyncio.sleep(3.5)
    command = room_manager._pending_command.pop(room_id, "")
    if command:
        await _run_listener_now(room_id, command)


async def _run_listener_now(room_id: str, command: str):
    """Extract intent then call the canvas agent."""
    canvas_state = room_manager.get_canvas(room_id)
    print(f"[intent] raw: {command}")

    from intent import extract_intent
    try:
        clean_command = await asyncio.to_thread(extract_intent, command)
    except Exception as e:
        print(f"[intent] error: {e}")
        clean_command = command
    print(f"[intent] clean: {clean_command}")

    from listener import listener_agent
    try:
        actions = await asyncio.to_thread(listener_agent, clean_command, canvas_state)
    except Exception as e:
        print(f"[listener] error: {e}")
        return
    COLOR_MAP = {
        "purple": "violet", "pink": "light-violet", "gray": "grey",
        "light-gray": "grey", "lightgray": "grey", "dark-blue": "blue",
        "light-purple": "light-violet", "teal": "green", "cyan": "light-blue",
        "lime": "light-green", "salmon": "light-red", "brown": "orange",
    }
    print(f"[listener] got {len(actions)} actions")
    for action in actions:
        # Normalize: listener may output "type" instead of "_type"
        if "type" in action and "_type" not in action:
            action["_type"] = action.pop("type")
        # Normalize colors to valid tldraw values
        if "color" in action:
            action["color"] = COLOR_MAP.get(action["color"], action["color"])
        await room_manager.broadcast(room_id, {"type": "agent_action", "action": action})


async def _maybe_run_listener(room_id: str, username: str):
    """Wait for silence threshold, then trigger listener agent if needed."""
    await asyncio.sleep(ConversationBuffer.SILENCE_THRESHOLD_SEC + 0.1)
    buf = room_manager.get_buffer(room_id)
    if not buf.should_trigger():
        return
    buf.mark_triggered()
    transcript = buf.format()
    canvas_state = room_manager.get_canvas(room_id)

    # Import here to avoid circular imports
    from listener import listener_agent
    actions = await asyncio.to_thread(listener_agent, transcript, canvas_state)
    for action in actions:
        await room_manager.broadcast(room_id, {"type": "agent_action", "action": action})


async def handle_websocket(ws: WebSocket, room_id: str, username: str):
    await ws.accept()
    await room_manager.join(room_id, username, ws)

    # Notify the new user of existing peers so they can initiate offers
    existing = [u for u in room_manager.users_in_room(room_id) if u != username]
    await ws.send_text(json.dumps({"type": "existing_peers", "peers": existing}))

    try:
        while True:
            raw = await ws.receive_text()
            msg: dict[str, Any] = json.loads(raw)
            t = msg.get("type")

            if t in ("offer", "answer", "ice"):
                to = msg.get("to")
                if to:
                    await room_manager.relay(room_id, to, {**msg, "from": username})

            elif t == "audio_chunk":
                audio_b64 = msg.get("data", "")
                if audio_b64:
                    asyncio.create_task(_handle_audio(room_id, username, audio_b64))

            elif t == "canvas_state":
                # Clients can push their canvas snapshot so listener has context
                room_manager.set_canvas(room_id, msg.get("state", []))

    except WebSocketDisconnect:
        pass
    finally:
        await room_manager.leave(room_id, username)
