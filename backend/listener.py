import os
import json
import anthropic
from agent import format_canvas  # reuse canvas formatter

client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

SYSTEM = """\
You are Higgs, an AI assistant embedded in a collaborative whiteboard canvas. \
You were just invoked by name ("Higgs") in a voice conversation between collaborators.

{canvas_description}

RULES:
- The speakers have explicitly called your name, so ALWAYS act on their request.
- Make a reasonable interpretation of what they want and do it immediately.
- NEVER ask clarifying questions — just act.
- Spread items across canvas: x 50-1100, y 50-700.
- Use at most 15 actions total.
- Do NOT include a "message" action.

HOW TO RENDER SHAPES:
- For UML classes, flowchart nodes, or any box with content: use create_shape with ALL text inside the "text" field using newlines.
  Example: {{"_type": "create_shape", "shapeId": "user_class", "geo": "rectangle", "text": "User\\n---\\n- id: int\\n- name: string\\n---\\n+ login()\\n+ logout()", "x": 200, "y": 150, "w": 200, "h": 160, "color": "blue"}}
- NEVER use create_text to annotate inside or on top of a shape — put everything in the shape's text field.
- create_text is only for standalone labels (titles, section headers) that float above a group.
- For arrows between shapes: create_arrow with fromId/toId referencing the shapeId you assigned.

SPATIAL LAYOUT:
- Plan ALL positions BEFORE emitting actions. Never place two shapes that overlap.
- Shapes must NOT overlap. Leave at least 80px horizontal and 80px vertical gap between shapes.
- For UML diagrams: use a row layout. Set w=220, h=280 for every class box (tall enough for content). Place boxes in a single row: x = 80 + (i * 320), y = 150. This guarantees no overlap.
- For flowcharts: arrange top-to-bottom, centered horizontally, 120px vertical gap between nodes.
- For mind maps: center node at x=550 y=350, branches radiate outward with 200px radius.
- Do NOT use move_shape — set correct x/y coordinates directly in create_shape from the start.

Output ONLY a valid JSON object: {{"actions": [...]}}\
"""


def listener_agent(transcript: str, canvas_state: list[dict]) -> list[dict]:
    """
    Given a conversation transcript and current canvas state,
    returns a (possibly empty) list of canvas actions.
    """
    canvas_description = format_canvas(canvas_state)
    system = SYSTEM.format(canvas_description=canvas_description)

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=2048,
        system=system,
        messages=[
            {"role": "user", "content": f"Command: {transcript}"},
            {"role": "assistant", "content": '{"actions": ['},
        ],
    )

    raw = '{"actions": [' + response.content[0].text.strip()
    try:
        data = json.loads(raw)
        actions = data.get("actions", [])
        return actions if isinstance(actions, list) else []
    except Exception:
        # Try closing incomplete JSON
        from agent import close_and_parse_json
        data = close_and_parse_json(raw)
        if data:
            actions = data.get("actions", [])
            return actions if isinstance(actions, list) else []
        return []
