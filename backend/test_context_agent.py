"""
Quick integration tests for the context-aware agent endpoint.

Usage (server must be running):
    python test_context_agent.py

Or against a specific host:
    python test_context_agent.py --host http://localhost:8000

Each test prints the SSE actions the agent returns.
"""

import argparse
import json
import sys
import httpx

BASE = "http://localhost:8000"


# ---------------------------------------------------------------------------
# Canvas fixtures
# ---------------------------------------------------------------------------

def _note(id, text, x, y, color="yellow"):
    return {"id": id, "type": "note", "x": x, "y": y, "w": 160, "h": 100,
            "text": text, "color": color}

def _image(id, url, x, y):
    return {"id": id, "type": "image", "x": x, "y": y, "w": 200, "h": 150,
            "url": url}

def _geo(id, label, x, y, geo="rectangle", color="blue"):
    return {"id": id, "type": "geo", "x": x, "y": y, "w": 180, "h": 80,
            "text": label, "geo": geo, "color": color}

def _arrow(id, from_id, to_id, x=300, y=300):
    return {"id": id, "type": "arrow", "x": x, "y": y,
            "fromId": from_id, "toId": to_id}


# --- 10 sticky notes for a product brainstorm ---
NOTES_10 = [
    _note("n1",  "User authentication via OAuth",          100, 100, "blue"),
    _note("n2",  "Drag-and-drop canvas interactions",      300, 100, "yellow"),
    _note("n3",  "Real-time collaboration with WebSockets",500, 100, "yellow"),
    _note("n4",  "AI-powered layout suggestions",          700, 100, "green"),
    _note("n5",  "Export to PDF / PNG",                    100, 250, "orange"),
    _note("n6",  "Performance bottleneck: large canvases", 300, 250, "red"),
    _note("n7",  "Mobile touch support is broken",         500, 250, "red"),
    _note("n8",  "Infinite scroll feels weird on tablets", 700, 250, "red"),
    _note("n9",  "Users love the color coding system",     100, 400, "green"),
    _note("n10", "Should we support dark mode?",           300, 400, "violet"),
]

# --- 20 images (public placeholder images) ---
IMAGES_20 = [
    _image(f"img{i}",
           f"https://picsum.photos/seed/higgsfield{i}/400/300",
           50 + (i % 5) * 220,
           500 + (i // 5) * 180)
    for i in range(1, 21)
]

# --- a few geo shapes as diagram boxes ---
GEOS = [
    _geo("g1", "Frontend (React)",      100, 80,  "rectangle", "blue"),
    _geo("g2", "Backend (FastAPI)",      400, 80,  "rectangle", "blue"),
    _geo("g3", "Database (SQLite)",      700, 80,  "rectangle", "blue"),
    _geo("g4", "Claude API",             400, 220, "ellipse",   "green"),
    _arrow("a1", "g1", "g2", 300, 120),
    _arrow("a2", "g2", "g3", 600, 120),
    _arrow("a3", "g2", "g4", 400, 180),
]

VIEWPORT = {"x": 0, "y": 0, "w": 1200, "h": 800}


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def call_agent(message: str, shapes: list, selected_ids: list = None,
               room_id: str = "test", host: str = BASE):
    body = {
        "message": message,
        "canvas_snapshot": {
            "shapes": shapes,
            "viewport": VIEWPORT,
            "selected_ids": selected_ids or [],
        },
        "room_id": room_id,
    }
    print(f"\n{'='*60}")
    print(f"ROOM: {room_id}")
    print(f"MSG : {message}")
    print(f"SHAPES: {len(shapes)} | SELECTED: {len(selected_ids or [])}")
    print("─" * 60)

    actions = []
    with httpx.stream("POST", f"{host}/api/agent/stream",
                      json=body, timeout=60) as r:
        if r.status_code != 200:
            print(f"ERROR {r.status_code}: {r.text}")
            return []
        for line in r.iter_lines():
            if not line.startswith("data: "):
                continue
            payload = json.loads(line[6:])
            if payload["type"] == "done":
                break
            if payload["type"] == "error":
                print(f"  [ERROR] {payload['message']}")
                break
            action = payload["action"]
            t = action.get("_type", "?")
            if t == "message":
                print(f"  [message] {action.get('text', '')}")
            else:
                detail = (action.get("text") or action.get("url") or
                          action.get("label") or action.get("id") or "")
                print(f"  [{t}] {detail[:80]}")
            actions.append(action)

    print(f"─" * 60)
    print(f"Total actions: {len(actions)}")
    return actions


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

def test_empty_canvas(host):
    """1. Empty canvas — ask for a basic brainstorm start."""
    call_agent(
        "Let's brainstorm ideas for a SaaS dashboard product. Set up the canvas.",
        shapes=[],
        room_id="test_empty",
        host=host,
    )


def test_summarise_notes(host):
    """2. 10 sticky notes — ask for a summary cluster."""
    call_agent(
        "I have a bunch of notes here. Can you cluster them by theme and add a summary?",
        shapes=NOTES_10,
        room_id="test_notes",
        host=host,
    )


def test_fix_problems(host):
    """3. 10 sticky notes — agent should notice the red (problem) notes."""
    call_agent(
        "What are the biggest blockers on the board? How should we prioritize them?",
        shapes=NOTES_10,
        room_id="test_problems",
        host=host,
    )


def test_selected_note(host):
    """4. User selects a specific note — agent focuses on it."""
    call_agent(
        "Expand on this idea with 3 more related sticky notes.",
        shapes=NOTES_10,
        selected_ids=["n4"],  # "AI-powered layout suggestions"
        room_id="test_selected",
        host=host,
    )


def test_big_canvas(host):
    """5. 10 notes + 20 images — heavy canvas, ask for organisation."""
    shapes = NOTES_10 + IMAGES_20
    call_agent(
        "This canvas is getting cluttered. Organise the notes into a clean cluster "
        "and suggest what to do with the images.",
        shapes=shapes,
        room_id="test_big",
        host=host,
    )


def test_images_only(host):
    """6. 20 images — ask agent to label or group them."""
    call_agent(
        "Look at all these images. Can you add a title note above each row "
        "to explain what they represent?",
        shapes=IMAGES_20,
        room_id="test_images",
        host=host,
    )


def test_diagram_canvas(host):
    """7. Architecture diagram — ask a structural question."""
    call_agent(
        "Explain this architecture and suggest where to add a caching layer.",
        shapes=GEOS,
        room_id="test_diagram",
        host=host,
    )


def test_incremental_turns(host):
    """8. Two consecutive turns in the SAME room — tests session memory."""
    shapes = NOTES_10
    room = "test_incremental"

    call_agent(
        "Add 3 action items based on the sticky notes.",
        shapes=shapes,
        room_id=room,
        host=host,
    )
    # Second turn — agent should remember the first turn
    call_agent(
        "Now connect the action items to the relevant problems with arrows.",
        shapes=shapes,
        room_id=room,
        host=host,
    )


def test_wild_card(host):
    """9. Ask something totally off-topic — agent should stay grounded."""
    call_agent(
        "What's the capital of France?",
        shapes=NOTES_10,
        room_id="test_wild",
        host=host,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

TESTS = {
    "1": ("Empty canvas brainstorm",     test_empty_canvas),
    "2": ("Summarise 10 notes",          test_summarise_notes),
    "3": ("Find problems in notes",      test_fix_problems),
    "4": ("Expand selected note",        test_selected_note),
    "5": ("Big canvas (notes+images)",   test_big_canvas),
    "6": ("Images only — add labels",    test_images_only),
    "7": ("Architecture diagram",        test_diagram_canvas),
    "8": ("Incremental turns (memory)",  test_incremental_turns),
    "9": ("Off-topic question",          test_wild_card),
}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=BASE)
    parser.add_argument(
        "tests", nargs="*",
        help="Test numbers to run (e.g. 1 3 5). Default: all."
    )
    args = parser.parse_args()

    to_run = args.tests or list(TESTS.keys())
    for key in to_run:
        if key not in TESTS:
            print(f"Unknown test {key!r}. Choose from: {', '.join(TESTS)}")
            sys.exit(1)
        name, fn = TESTS[key]
        print(f"\n{'#'*60}")
        print(f"# TEST {key}: {name}")
        print(f"{'#'*60}")
        fn(args.host)
