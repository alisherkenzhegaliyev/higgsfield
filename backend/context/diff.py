"""
context.diff
============

Canvas diff engine.

Compares an incoming simplified canvas snapshot (list[dict]) against the
current ContentRegistry to produce a CanvasDiff that drives which shapes
need preprocessing, position-only updates, or eviction this turn.

Public API
----------
    diff_canvas(snapshot_shapes, registry) → CanvasDiff
"""

from __future__ import annotations

import logging

from context.models import CanvasDiff, SemanticRecord, content_hash_for
from context.storage import ContentRegistry

logger = logging.getLogger(__name__)

# Shapes that move by less than this many px are treated as stationary.
# Avoids re-classifying shapes as "moved" due to floating-point drift
# from tldraw's layout engine.
_POSITION_EPSILON: float = 0.5


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def diff_canvas(
    snapshot_shapes: list[dict],
    registry: ContentRegistry,
) -> CanvasDiff:
    """Compare *snapshot_shapes* against *registry* and return a CanvasDiff.

    Classification rules
    --------------------
    new       — shape ID appears in snapshot but is absent from registry.
    updated   — shape ID exists in both; content_hash changed (text edited,
                URL swapped, color changed, etc.).  Needs full reprocessing.
    moved     — shape ID exists in both; content_hash identical but position
                changed beyond _POSITION_EPSILON.  Only a coord update needed.
    deleted   — shape ID present in registry but absent from snapshot.

    A shape that is both content-changed and moved is classified as *updated*
    (reprocessing will capture the new position anyway).

    Unchanged shapes (same hash, same position) are silently ignored.
    """
    diff = CanvasDiff()

    # Index snapshot by ID for O(1) lookups.
    snapshot_index: dict[str, dict] = {
        s["id"]: s for s in snapshot_shapes if "id" in s
    }
    registry_ids: set[str] = {r.object_id for r in registry.get_all()}

    # ------------------------------------------------------------------ #
    # Pass 1: classify each shape in the snapshot
    # ------------------------------------------------------------------ #
    for shape_id, shape in snapshot_index.items():
        existing: SemanticRecord | None = registry.get(shape_id)

        if existing is None:
            # Shape is new — needs preprocessing.
            diff.new_shapes.append(shape)
            continue

        new_hash = content_hash_for(shape)

        if new_hash != existing.content_hash:
            # Content changed → full reprocessing.
            diff.updated_shapes.append(shape)
        elif _position_changed(shape, existing):
            # Pure move — no reprocessing, just update coordinates.
            diff.moved_shapes.append(shape)
        # else: unchanged — skip.

    # ------------------------------------------------------------------ #
    # Pass 2: deleted shapes
    # ------------------------------------------------------------------ #
    snapshot_ids = set(snapshot_index.keys())
    diff.deleted_ids = sorted(registry_ids - snapshot_ids)

    if any([diff.new_shapes, diff.updated_shapes, diff.moved_shapes, diff.deleted_ids]):
        logger.debug(
            "canvas diff: +%d new  ~%d updated  →%d moved  -%d deleted",
            len(diff.new_shapes),
            len(diff.updated_shapes),
            len(diff.moved_shapes),
            len(diff.deleted_ids),
        )

    return diff


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _position_changed(shape: dict, record: SemanticRecord) -> bool:
    """Return True if the shape's (x, y) differs from the record's position."""
    dx = abs(shape.get("x", 0.0) - record.position.x)
    dy = abs(shape.get("y", 0.0) - record.position.y)
    return dx > _POSITION_EPSILON or dy > _POSITION_EPSILON


def apply_diff_to_registry(diff: CanvasDiff, registry: ContentRegistry) -> None:
    """Apply the position-only and deletion parts of a diff to the registry
    without triggering full preprocessing.

    Call this *after* the preprocessor has already handled new/updated shapes.
    It handles:
      - Updating (x, y) for moved shapes.
      - Evicting deleted shapes.

    New and updated shapes are handled by the preprocessor node, which calls
    registry.set() directly after building the SemanticRecord.
    """
    # Update positions for moved shapes.
    for shape in diff.moved_shapes:
        sid = shape.get("id", "")
        record = registry.get(sid)
        if record is None:
            continue
        updated = record.model_copy(
            update={
                "position": record.position.model_copy(
                    update={
                        "x": float(shape.get("x", record.position.x)),
                        "y": float(shape.get("y", record.position.y)),
                    }
                )
            }
        )
        registry.set(sid, updated)

    # Evict deleted shapes.
    for sid in diff.deleted_ids:
        registry.delete(sid)

    if diff.moved_shapes or diff.deleted_ids:
        logger.debug(
            "registry patched: %d position updates, %d evictions",
            len(diff.moved_shapes),
            len(diff.deleted_ids),
        )
