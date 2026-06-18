"""Pydantic schemas for equivalence group endpoints."""

from datetime import datetime
from .common import UTCTimestamp

from pydantic import BaseModel, Field


# ═══════════════════════════════════════════════════════════════════════════════
# Request schemas
# ═══════════════════════════════════════════════════════════════════════════════


class EquivalenceGroupCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    column_ids: list[int] = Field(default_factory=list)


class EquivalenceGroupBulkCreate(BaseModel):
    groups: list[EquivalenceGroupCreate]


class EquivalenceGroupUpdate(BaseModel):
    label: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None


class EquivalenceGroupAddColumns(BaseModel):
    column_ids: list[int] = Field(..., min_length=1)


class EquivalenceGroupRemoveColumns(BaseModel):
    column_ids: list[int] = Field(..., min_length=1)


class EquivalenceGroupReorderRequest(BaseModel):
    group_ids: list[int]


class ColumnSwap(BaseModel):
    """A single pair of columns to swap equivalence_group assignments."""
    column_id_a: int
    column_id_b: int


class EquivalenceGroupSwapRequest(BaseModel):
    """Tier 3 crosswalk swap endpoint — atomically exchange each pair's
    equivalence_group_id. All pairs must pass validation before any swap
    is applied (all-or-nothing atomicity via the transaction).
    """
    swaps: list[ColumnSwap] = Field(..., min_length=1)


# ═══════════════════════════════════════════════════════════════════════════════
# Response schemas
# ═══════════════════════════════════════════════════════════════════════════════


class EquivalenceGroupColumnDefInfo(BaseModel):
    id: int
    name: str
    recode_type: str
    is_primary: bool


class EquivalenceGroupColumnInfo(BaseModel):
    id: int
    dataset_id: int
    dataset_name: str
    column_code: str | None = None
    column_text: str
    column_type: str
    scale_labels: list[str] | None = None
    scale_points: int | None = None
    recode_definitions: list[EquivalenceGroupColumnDefInfo] = []


class EquivalenceGroupResponse(BaseModel):
    id: int
    project_id: int
    label: str
    description: str | None = None
    origin: str
    columns: list[EquivalenceGroupColumnInfo]
    created_at: UTCTimestamp
    updated_at: UTCTimestamp


class EquivalenceGroupListResponse(BaseModel):
    groups: list[EquivalenceGroupResponse]
    total: int


class EquivalenceGroupSwapResponse(BaseModel):
    """Response: the groups affected by the swap (loaded after the swap
    completes), plus which metric IDs were recomputed synchronously per
    GAP 3.13 Option A.
    """
    updated_groups: list[EquivalenceGroupResponse]
    recomputed_metric_ids: list[int] = Field(default_factory=list)


class EquivalenceGroupRemoveColumnsResponse(BaseModel):
    """Response from `remove_columns`: either the updated group (if columns
    remain) or `dissolved=True` (if the removal emptied the group and the
    backend auto-deleted it).

    Path A (#323): empty equivalence groups are auto-dissolved server-side.
    The frontend reads `dissolved` directly to update its caches; previously
    the bandage in `useCrosswalkMutations.ts::removeColumnFromRowMutation`
    inferred this from `columns.length === 0` and fired a follow-up DELETE.
    """
    group: EquivalenceGroupResponse | None = None
    dissolved: bool = False


class BulkCreateResult(BaseModel):
    created: int
    groups: list[EquivalenceGroupResponse]


# ═══════════════════════════════════════════════════════════════════════════════
# Suggest schemas
# ═══════════════════════════════════════════════════════════════════════════════


class SuggestedGroupColumn(BaseModel):
    id: int
    dataset_id: int
    dataset_name: str
    column_code: str | None = None
    column_text: str
    column_type: str
    similarity_score: float | None = None


class SuggestedGroup(BaseModel):
    label: str
    match_type: str  # "exact_text", "code_match", or "similar_text"
    type_mismatch: bool
    similarity_score: float | None = None
    columns: list[SuggestedGroupColumn]


class EquivalenceSuggestResponse(BaseModel):
    suggestions: list[SuggestedGroup]


# ═══════════════════════════════════════════════════════════════════════════════
# All-columns schemas
# ═══════════════════════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════════════════════
# Find-matches schemas
# ═══════════════════════════════════════════════════════════════════════════════


class FindMatchesRequest(BaseModel):
    column_ids: list[int] = Field(..., min_length=1)
    min_similarity: float = Field(default=0.70, ge=0.0, le=1.0)


class ColumnMatchResult(BaseModel):
    anchor_column_id: int
    target_column_id: int
    target_column_text: str
    target_column_code: str | None = None
    target_dataset_id: int
    target_dataset_name: str
    target_column_type: str
    similarity: float
    already_linked: bool
    # True when the target is itself one of the user's explicitly selected anchor
    # columns (from a different dataset). These candidates bypass the fuzzy-match
    # threshold and are pre-checked in the UI.
    user_selected: bool = False


class FindMatchesResponse(BaseModel):
    matches: list[ColumnMatchResult]


# ═══════════════════════════════════════════════════════════════════════════════
# All-columns schemas
# ═══════════════════════════════════════════════════════════════════════════════


class ProjectColumnInfo(BaseModel):
    id: int
    dataset_id: int
    dataset_name: str
    # Denormalized dataset color (mirrors `dataset_name` denormalization) so
    # crosswalk surfaces resolve dataset visual identity without a second
    # query. Null when the dataset has no user-set color override.
    dataset_color: str | None = None
    column_code: str | None = None
    column_name: str | None = None
    column_text: str
    column_type: str
    scale_points: int | None = None
    # Phase 4.5: enrich the all-columns endpoint so the crosswalk can drive
    # the scale-labels mismatch icon (v2: full label-array comparison) and
    # the type picker's recode-defs pre-flight gate without a second query.
    scale_labels: list[str] | None = None
    recode_def_count: int = 0
    equivalence_group_id: int | None = None
    equivalence_group_label: str | None = None


class ProjectColumnListResponse(BaseModel):
    columns: list[ProjectColumnInfo]
    total: int
