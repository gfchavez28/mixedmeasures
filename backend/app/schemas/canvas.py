"""Pydantic schemas for canvas endpoints."""

from datetime import datetime
from typing import Any
from .common import UTCTimestamp

from pydantic import BaseModel, ConfigDict, Field


# ── Canvas ──────────────────────────────────────────────────────────────────


class CanvasExportDocxRequest(BaseModel):
    """Optional chart images and tables for docx export, keyed by chart-embed materialId.

    ``chart_images`` values are base64-encoded PNGs (data-URL prefix tolerated).
    ``chart_tables`` values are ``{"headers": [str], "rows": [[str]]}`` — the
    table the client's Markdown and HTML exports print (#1406 D5), used when a
    chart has no image. Both are validated by the router, which DROPS a
    malformed entry rather than refusing the request, so they are typed loosely
    here. Empty/omitted is valid — such a chart reads "Chart data unavailable".
    """
    chart_images: dict[str, str] = Field(default_factory=dict)
    chart_tables: dict[str, Any] = Field(default_factory=dict)
    #: A joint display's REPORT table (D174), keyed by the node's ``displayKey``:
    #: ``{"title", "message", "headers", "rows", "span_rows", "note", "appendix"}`` —
    #: the one `lib/joint-display-report.ts` builds for every format. Loosely typed for
    #: the same reason as ``chart_tables``: the router drops a malformed entry.
    display_tables: dict[str, Any] = Field(default_factory=dict)


class CanvasCreate(BaseModel):
    name: str = Field(default="Untitled canvas", min_length=1, max_length=255)
    introduction: dict | None = None


class CanvasUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    display_order: int | None = None
    introduction: dict | None = None
    is_archived: bool | None = None


class CanvasListItem(BaseModel):
    id: int
    name: str
    display_order: int
    theme_count: int
    is_archived: bool
    updated_at: UTCTimestamp


# ── Theme ───────────────────────────────────────────────────────────────────


class ThemeCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    section_type: str = Field(default="theme", max_length=10)
    description: str | None = Field(None, max_length=5000)
    color: str | None = Field(None, max_length=7, pattern=r"^#[0-9A-Fa-f]{6}$")
    viz_x: float | None = None
    viz_y: float | None = None
    after_theme_id: int | None = None
    parent_theme_id: int | None = None


class ThemeUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    section_type: str | None = Field(None, max_length=10)
    description: str | None = Field(None, max_length=5000)
    color: str | None = Field(None, max_length=7, pattern=r"^#[0-9A-Fa-f]{6}$")
    viz_x: float | None = None
    viz_y: float | None = None
    content: dict | None = None
    parent_theme_id: int | None = None


class ThemeRelationshipRestore(BaseModel):
    """One link a theme delete cascaded away (#1301) — the response row's shape."""
    id: int | None = None
    source_theme_id: int
    target_theme_id: int
    relationship_type: str = Field(..., min_length=1, max_length=30)
    label: str | None = Field(None, max_length=255)
    weight: int = Field(1, ge=1, le=100)
    is_bidirectional: bool = False
    line_style: str | None = Field(None, max_length=20)
    line_color: str | None = Field(None, max_length=7)


class ThemeRestore(BaseModel):
    """What deleting a theme destroyed (#1301): `services/canvas.py::theme_restore_record`,
    handed out by the delete and sent back by its undo. Bounded as `ThemeCreate` is."""
    id: int | None = None
    name: str = Field(..., min_length=1, max_length=255)
    section_type: str = Field(default="theme", max_length=10)
    description: str | None = Field(None, max_length=5000)
    color: str | None = Field(None, max_length=7, pattern=r"^#[0-9A-Fa-f]{6}$")
    doc_order: int
    table_column_order: int | None = None
    viz_x: float | None = None
    viz_y: float | None = None
    parent_theme_id: int | None = None
    content: dict | None = None
    child_ids: list[int] = Field(default_factory=list, max_length=10_000)
    relationships: list[ThemeRelationshipRestore] = Field(default_factory=list, max_length=10_000)
    #: The delete's own audit entry, set by the delete endpoint — the withdrawal gate measures
    #: "since" from it (absent → fails closed).
    deleted_audit_id: int | None = None


class ThemeRestoreLost(BaseModel):
    """What could not come back because the canvas changed after the delete (#1301)."""
    parent: bool = False
    children: int = 0
    relationships: int = 0


class ThemeReorderRequest(BaseModel):
    theme_ids: list[int] = Field(..., min_length=1)


class CanvasThemeRelationshipResponse(BaseModel):
    id: int
    source_theme_id: int
    target_theme_id: int
    relationship_type: str
    label: str | None = None
    weight: int
    is_bidirectional: bool
    line_style: str | None = None
    line_color: str | None = None


class CanvasThemeResponse(BaseModel):
    id: int
    name: str
    section_type: str = "theme"
    description: str | None = None
    color: str | None = None
    doc_order: int
    viz_x: float | None = None
    viz_y: float | None = None
    parent_theme_id: int | None = None
    content: dict | None = None
    searchable_text: str | None = None
    referenced_source_ids: list | None = None
    relationships_out: list[CanvasThemeRelationshipResponse] = []
    relationships_in: list[CanvasThemeRelationshipResponse] = []


# ── Relationship schemas ────────────────────────────────────────────────────


class ThemeRestoreResponse(BaseModel):
    theme: CanvasThemeResponse
    not_restored: ThemeRestoreLost


class ThemeRelationshipCreate(BaseModel):
    source_theme_id: int
    target_theme_id: int
    relationship_type: str = Field(..., min_length=1, max_length=30)
    label: str | None = Field(None, max_length=255)
    weight: int = Field(1, ge=1, le=100)
    is_bidirectional: bool = False
    line_style: str | None = Field(None, max_length=20)
    line_color: str | None = Field(None, max_length=7)


class ThemeRelationshipUpdate(BaseModel):
    relationship_type: str | None = Field(None, min_length=1, max_length=30)
    label: str | None = Field(None, max_length=255)
    weight: int | None = Field(None, ge=1, le=100)
    is_bidirectional: bool | None = None
    line_style: str | None = Field(None, max_length=20)
    line_color: str | None = Field(None, max_length=7)


# ── Pending Items ──────────────────────────────────────────────────────────


class PendingItemCreate(BaseModel):
    item_type: str = Field(..., min_length=1, max_length=30)
    source_id: int


class PendingItemResponse(BaseModel):
    id: int
    canvas_id: int
    item_type: str
    source_id: int
    created_at: UTCTimestamp
    # #823(j): what this item IS. The inbox rendered `"Chart #5"` — a type word
    # and a raw primary key — because the payload carried nothing else, while
    # the Materials drawer beside it showed the real name. The client cannot
    # derive this: the three item types are three different entities, so a
    # client-side lookup would need three queries all loaded and would still
    # show the id until they landed. Same reason `#749`'s participant_count
    # rides its payload. `None` when the source row is gone.
    source_label: str | None = None


# ── Snapshots ─────────────────────────────────────────────────────────────


class SnapshotCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)


class SnapshotResponse(BaseModel):
    id: int
    name: str
    theme_count: int
    created_at: UTCTimestamp

    model_config = ConfigDict(from_attributes=True)


class SnapshotDetailResponse(BaseModel):
    id: int
    name: str
    theme_count: int
    snapshot_data: dict
    created_at: UTCTimestamp


# ── Canvas Detail ───────────────────────────────────────────────────────────


class CanvasDetailResponse(BaseModel):
    id: int
    name: str
    display_order: int
    introduction: dict | None = None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp
    themes: list[CanvasThemeResponse]
    pending_items: list[PendingItemResponse] = []
