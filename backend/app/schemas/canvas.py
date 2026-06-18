"""Pydantic schemas for canvas endpoints."""

from datetime import datetime
from .common import UTCTimestamp

from pydantic import BaseModel, ConfigDict, Field


# ── Canvas ──────────────────────────────────────────────────────────────────


class CanvasExportDocxRequest(BaseModel):
    """Optional chart images for docx export, keyed by chart-embed materialId.

    Values are base64-encoded PNGs (data-URL prefix tolerated). Empty/omitted is
    valid — the export then falls back to data tables for charts.
    """
    chart_images: dict[str, str] = Field(default_factory=dict)


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
