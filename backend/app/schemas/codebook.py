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


class CodebookCooccurrenceNode(BaseModel):
    id: int
    name: str
    color: str | None = None
    segment_count: int = 0
    source_count: int = 0
    category_path: list[str] = []


class CodebookCooccurrenceEdge(BaseModel):
    source: int
    target: int
    weight: int


class CodebookCooccurrenceResponse(BaseModel):
    nodes: list[CodebookCooccurrenceNode] = []
    edges: list[CodebookCooccurrenceEdge] = []
    max_weight: int = 0
    hierarchy_level: int = -1
    # #354: total non-universal codes in the codebook regardless of filters.
    # The network endpoint silently drops codes with `seg_count == 0` (after
    # the `exclude_facilitator=True` default), so `len(nodes)` can be much
    # smaller than the tree's code count. Surface the total here so the
    # frontend can render a "Showing N of M" affordance instead of leaving
    # the discrepancy unexplained. Universal codes (numeric_id 0/1) are
    # excluded from the network anyway, so they're excluded from this count
    # too — making M directly comparable to N. Respects the `include_inactive`
    # query param so the denominator matches the eligible-codes universe.
    total_codes_in_project: int = 0
