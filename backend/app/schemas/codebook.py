from __future__ import annotations
from datetime import datetime
from .common import UTCTimestamp
from pydantic import BaseModel


class CodebookCodeNode(BaseModel):
    id: int
    numeric_id: int
    name: str
    description: str | None = None
    color: str | None = None
    is_active: bool
    is_universal: bool
    segment_count: int = 0
    source_count: int = 0
    excerpt_count: int = 0
    category_id: int | None = None
    # #501: typed source identities ("conv:1", "col:13", "doc:2") so the peek
    # panel's multi-select can UNION sources across codes — Σ of per-code
    # source_counts double-counts shared sources (it exceeded the project's
    # source universe on the audit corpus).
    source_keys: list[str] = []


class CodebookCategoryNode(BaseModel):
    id: int
    name: str
    color: str | None = None
    display_order: int
    parent_id: int | None = None
    depth: int = 0
    created_at: UTCTimestamp | None = None
    code_count: int = 0
    total_code_count: int = 0
    total_segments: int = 0
    total_sources: int = 0
    children: list[CodebookCategoryNode] = []
    codes: list[CodebookCodeNode] = []


class CodebookTreeResponse(BaseModel):
    universal_codes: list[CodebookCodeNode] = []
    tree: list[CodebookCategoryNode] = []
    uncategorized_codes: list[CodebookCodeNode] = []
