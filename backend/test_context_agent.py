import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from chat_agent import router as chat_router
from context.diff import apply_diff_to_registry, diff_canvas
from context.models import ObjectType, Position, SemanticRecord, Size, content_hash_for
from context.preprocessors import preprocess_shape
from context.storage import ContentRegistry


class ContextDiffTests(unittest.TestCase):
    def test_diff_treats_resize_as_layout_change(self) -> None:
        registry = ContentRegistry()
        original = {
            "id": "shape:box",
            "type": "geo",
            "x": 120,
            "y": 240,
            "w": 220,
            "h": 120,
            "text": "Auth service",
            "color": "blue",
            "geo": "rectangle",
        }
        registry.set(
            "shape:box",
            SemanticRecord(
                object_id="shape:box",
                object_type=ObjectType.shape,
                position=Position(x=120, y=240),
                size=Size(w=220, h=120),
                content_summary='rectangle shape: "Auth service"',
                content_hash=content_hash_for(original),
            ),
        )

        resized = dict(original, w=320, h=180)
        diff = diff_canvas([resized], registry)

        self.assertEqual(diff.updated_shapes, [])
        self.assertEqual(len(diff.moved_shapes), 1)

        apply_diff_to_registry(diff, registry)
        updated = registry.get("shape:box")
        self.assertIsNotNone(updated)
        self.assertEqual(updated.size.w, 320)
        self.assertEqual(updated.size.h, 180)

    def test_content_hash_tracks_arrow_endpoints(self) -> None:
        left = {
            "id": "shape:arrow",
            "type": "arrow",
            "x": 0,
            "y": 0,
            "text": "",
            "fromId": "shape:a",
            "toId": "shape:b",
        }
        right = dict(left, toId="shape:c")

        self.assertNotEqual(content_hash_for(left), content_hash_for(right))


class ContextPreprocessorTests(unittest.TestCase):
    def test_preprocess_arrow_preserves_connections(self) -> None:
        record = asyncio.run(
            preprocess_shape(
                {
                    "id": "shape:arrow",
                    "type": "arrow",
                    "x": 10,
                    "y": 20,
                    "text": "depends on",
                    "fromId": "shape:service",
                    "toId": "shape:db",
                }
            )
        )

        self.assertEqual(record.object_type, ObjectType.arrow)
        self.assertEqual(record.connections, ["shape:service", "shape:db"])
        self.assertIn("from:shape:service", record.content_summary)
        self.assertIn("to:shape:db", record.content_summary)


class ChatRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        app = FastAPI()
        app.include_router(chat_router)
        self.client = TestClient(app)

    @patch("chat_agent.run_context_agent", new_callable=AsyncMock)
    def test_chat_stream_uses_canvas_snapshot_payload(
        self,
        mock_run_context_agent: AsyncMock,
    ) -> None:
        snapshot = {
            "shapes": [
                {
                    "id": "shape:note",
                    "type": "note",
                    "x": 50,
                    "y": 80,
                    "text": "Current focus",
                    "color": "yellow",
                }
            ],
            "viewport": {"x": 0, "y": 0, "w": 1200, "h": 800},
            "selected_ids": ["shape:note"],
        }
        mock_run_context_agent.return_value = [{"_type": "message", "text": "Integrated"}]

        response = self.client.post(
            "/api/chat/stream",
            json={
                "message": "Summarize this cluster",
                "room_id": "room-7",
                "canvas_state": [],
                "canvas_snapshot": snapshot,
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn('"type": "action"', response.text)
        self.assertIn('"Integrated"', response.text)
        mock_run_context_agent.assert_awaited_once_with(
            message="Summarize this cluster",
            canvas_snapshot=snapshot,
            room_id="room-7",
        )

    @patch("chat_agent.run_context_agent", new_callable=AsyncMock)
    def test_chat_stream_wraps_legacy_canvas_state_when_needed(
        self,
        mock_run_context_agent: AsyncMock,
    ) -> None:
        canvas_state = [
            {
                "id": "shape:box",
                "type": "geo",
                "x": 100,
                "y": 120,
                "text": "Fallback canvas",
                "color": "blue",
                "geo": "rectangle",
            }
        ]
        mock_run_context_agent.return_value = [{"_type": "message", "text": "Fallback works"}]

        response = self.client.post(
            "/api/chat/stream",
            json={"message": "Use fallback", "canvas_state": canvas_state},
        )

        self.assertEqual(response.status_code, 200)
        mock_run_context_agent.assert_awaited_once_with(
            message="Use fallback",
            canvas_snapshot={"shapes": canvas_state, "selected_ids": []},
            room_id="main",
        )


if __name__ == "__main__":
    unittest.main()
