"""Pydantic schemas for material collection endpoints."""

from datetime import datetime
from .common import UTCTimestamp

from pydantic import BaseModel, Field


# ── Material Collection ─────────────────────────────────────────────────────


class MaterialCollectionCreate(BaseModel):
    name: str = Field(default="Materials", min_length=1, max_length=255)


class MaterialCollectionUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)


class MaterialCollectionResponse(BaseModel):
    id: int
    project_id: int
    name: str
    display_order: int
    created_at: UTCTimestamp
    material_count: int = 0


class MaterialCollectionListResponse(BaseModel):
    collections: list[MaterialCollectionResponse]


# ── Materials ───────────────────────────────────────────────────────────────


class MaterialCreate(BaseModel):
    material_type: str = Field(..., min_length=1, max_length=50)
    config: dict
    auto_name: str = Field(..., min_length=1, max_length=500)
    custom_name: str | None = Field(None, max_length=255)
    source_tab: str = Field(default="descriptives", max_length=40)


class MaterialUpdate(BaseModel):
    custom_name: str | None = Field(None, max_length=255)
    config: dict | None = None


class MaterialReorderRequest(BaseModel):
    material_ids: list[int] = Field(..., min_length=1)


class MaterialResponse(BaseModel):
    id: int
    collection_id: int
    material_type: str
    config: dict
    auto_name: str
    custom_name: str | None = None
    display_order: int
    source_tab: str
    created_at: UTCTimestamp
    # #296: stale-on-load detection. The material's config can reference
    # column / domain / grouping IDs that have since been deleted; the
    # canvas embed re-runs quickCompute on render so the values themselves
    # don't go stale, but a deleted reference makes the embed silently
    # render with reduced data. Surface the missing refs so the frontend
    # can show a clear "Sources missing" warning instead of a quiet empty.
    has_missing_refs: bool = False
    missing_refs: list[dict] = Field(default_factory=list)


class MaterialCollectionDetailResponse(BaseModel):
    id: int
    project_id: int
    name: str
    display_order: int
    created_at: UTCTimestamp
    materials: list[MaterialResponse]
