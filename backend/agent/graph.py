"""
LangGraph ReAct canvas agent.

Graph:  START → agent → (tools?) → tools → agent → … → END

The graph is compiled once at import time. room_manager is imported from
room_manager.py — no circular dependency.
"""

import logging
from typing import Any, Literal, TypedDict

from anthropic import AsyncAnthropic
from langgraph.graph import END, StateGraph

from agent.prompts import CANVAS_AGENT_SYSTEM
from agent.tools import TOOLS, COLOR_MAP, apply_optimistic, format_canvas
from config import get_settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Anthropic client (lazy — created on first use to respect env loading order)
# ---------------------------------------------------------------------------

_client: AsyncAnthropic | None = None


def _get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic(api_key=get_settings().anthropic_api_key)
    return _client


# ---------------------------------------------------------------------------
# LangGraph state
# ---------------------------------------------------------------------------


class AgentState(TypedDict):
    messages: list[dict[str, Any]]
    canvas: list[dict]
    room_id: str
    _stop: bool


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


async def agent_node(state: AgentState) -> dict:
    settings = get_settings()
    system_text = CANVAS_AGENT_SYSTEM.format(canvas=format_canvas(state["canvas"]))
    response = await _get_client().messages.create(
        model=settings.canvas_agent_model,
        max_tokens=2048,
        tools=TOOLS,
        system=system_text,
        messages=state["messages"],
    )
    new_messages = state["messages"] + [{"role": "assistant", "content": response.content}]
    tool_uses = [b for b in response.content if b.type == "tool_use"]
    stop = not tool_uses or any(b.name == "finish" for b in tool_uses)
    logger.debug("agent tools=%s", [b.name for b in tool_uses] if tool_uses else "none → done")
    return {"messages": new_messages, "_stop": stop}


async def tool_node(state: AgentState) -> dict:
    # Import here is fine — room_manager is a dedicated module, no circular dep.
    from room_manager import room_manager  # noqa: PLC0415

    last_content = state["messages"][-1]["content"]
    tool_uses = [b for b in last_content if b.type == "tool_use"]
    canvas = list(state["canvas"])
    results: list[dict] = []

    for tu in tool_uses:
        name, args = tu.name, tu.input

        if name == "finish":
            logger.info("finish: %s", args.get("summary", ""))
            results.append({"type": "tool_result", "tool_use_id": tu.id, "content": "Done."})
            continue

        if name == "read_canvas":
            result = format_canvas(canvas)

        elif name == "update_text":
            action = {"_type": "update_text", **args}
            await room_manager.broadcast(state["room_id"], {"type": "agent_action", "action": action})
            sid = args.get("id", "")
            new_text = args.get("text", "")
            for lst in (canvas, room_manager.get_canvas(state["room_id"])):
                for s in lst:
                    if s.get("id") == sid:
                        s["text"] = new_text
            room_manager.schedule_save(state["room_id"])
            result = f"Updated text on '{sid}'."

        elif name == "delete_shape":
            action = {"_type": "delete_shape", **args}
            await room_manager.broadcast(state["room_id"], {"type": "agent_action", "action": action})
            sid = args.get("id") or args.get("shapeId")
            canvas[:] = [s for s in canvas if s.get("id") != sid]
            apply_optimistic(room_manager.get_canvas(state["room_id"]), action)
            room_manager.schedule_save(state["room_id"])
            result = f"Deleted '{sid}'."

        else:
            action = {"_type": name, **args}
            if "color" in action:
                action["color"] = COLOR_MAP.get(action["color"], action["color"])
            await room_manager.broadcast(state["room_id"], {"type": "agent_action", "action": action})
            apply_optimistic(canvas, action)
            apply_optimistic(room_manager.get_canvas(state["room_id"]), action)
            room_manager.schedule_save(state["room_id"])
            result = f"Done. Canvas now has {len(canvas)} shapes."

        results.append({"type": "tool_result", "tool_use_id": tu.id, "content": result})

    new_messages = state["messages"] + [{"role": "user", "content": results}]
    return {"messages": new_messages, "canvas": canvas}


def _route(state: AgentState) -> Literal["tools", "__end__"]:
    return END if state.get("_stop", False) else "tools"


# ---------------------------------------------------------------------------
# Build graph (compiled once at import time)
# ---------------------------------------------------------------------------

_builder = StateGraph(AgentState)
_builder.add_node("agent", agent_node)
_builder.add_node("tools", tool_node)
_builder.set_entry_point("agent")
_builder.add_conditional_edges("agent", _route, {"tools": "tools", END: END})
_builder.add_edge("tools", "agent")

canvas_agent = _builder.compile()


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def run_canvas_agent(command: str, canvas_state: list[dict], room_id: str) -> None:
    logger.info("room=%s cmd='%s'", room_id, command[:80])
    await canvas_agent.ainvoke(
        {
            "messages": [{"role": "user", "content": command}],
            "canvas": list(canvas_state),
            "room_id": room_id,
            "_stop": False,
        }
    )
    logger.info("room=%s agent done", room_id)
