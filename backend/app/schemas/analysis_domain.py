"""Pydantic schemas for analysis domain endpoints."""

from datetime import datetime
from .common import UTCTimestamp

import re
from pydantic import BaseModel, Field, field_validator


# ═══════════════════════════════════════════════════════════════════════════════
# Request schemas
# ═══════════════════════════════════════════════════════════════════════════════


class DomainMemberInput(BaseModel):
    member_type: str = Field(..., pattern=r'^column$')
    member_id: int


_HEX_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{6}$')


def _validate_hex_color(v: str | None) -> str | None:
    if v is not None and not _HEX_COLOR_RE.match(v):
        raise ValueError("color must be a hex string like #RRGGBB")
    return v


class EquivalenceGroupCreateInline(BaseModel):
    """Inline equivalence-group spec for the bulk-create-domains payload (Phase 4).

    When supplied on `AnalysisDomainCreate`, each entry creates one
    EquivalenceGroup with the listed columns BEFORE the domain members are
    inserted, so #290 cross-dataset pairing is satisfied in a single
    transaction. Used by Tier 3 Suggest accept to scaffold EGs alongside the
    domain that wraps them. Member columns must also appear in the domain's
    `members` list (the router enforces this).
    """
    column_ids: list[int] = Field(..., min_length=2)
    label: str | None = None


class AnalysisDomainCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    color: str | None = None
    members: list[DomainMemberInput] = Field(default_factory=list)
    # Phase 4: optional scaffold of equivalence groups created in the same
    # transaction. Empty by default — backwards-compatible with existing
    # callers (frontend createDomain, legacy bulk paths).
    equivalence_groups: list[EquivalenceGroupCreateInline] = Field(default_factory=list)

    _validate_color = field_validator("color", mode="before")(_validate_hex_color)


class AnalysisDomainUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    color: str | None = None

    _validate_color = field_validator("color", mode="before")(_validate_hex_color)


class AnalysisDomainAddMembers(BaseModel):
    members: list[DomainMemberInput] = Field(..., min_length=1)


class AnalysisDomainRemoveMembers(BaseModel):
    members: list[DomainMemberInput] = Field(..., min_length=1)


class AnalysisDomainBulkCreate(BaseModel):
    domains: list[AnalysisDomainCreate]


class DomainReorderRequest(BaseModel):
    domain_ids: list[int] = Field(..., min_length=1)


class DomainMemberReorderRequest(BaseModel):
    """Reorder members within a single analysis domain.

    The ordered list of AnalysisDomainMember.id values defines the new
    sequence_order — position 0 becomes sequence_order=0, position 1 becomes
    sequence_order=1, etc. All current members must appear exactly once.
    """
    member_ids: list[int] = Field(..., min_length=1)


# ═══════════════════════════════════════════════════════════════════════════════
# Response schemas
# ═══════════════════════════════════════════════════════════════════════════════


class DomainMemberInfo(BaseModel):
    id: int  # AnalysisDomainMember.id
    member_type: str
    member_id: int
    label: str
    dataset_id: int | None = None
    dataset_name: str | None = None
    column_code: str | None = None
    column_type: str | None = None
    scale_points: int | None = None
    scale_labels: list[str] | None = None
    equivalence_group_id: int | None = None


class AnalysisDomainResponse(BaseModel):
    id: int
    project_id: int
    name: str
    description: str | None = None
    color: str | None = None
    sequence_order: int | None = None
    origin: str
    member_count: int
    members: list[DomainMemberInfo]
    created_at: UTCTimestamp
    updated_at: UTCTimestamp


class AnalysisDomainListResponse(BaseModel):
    domains: list[AnalysisDomainResponse]
    total: int


class BulkDomainCreateResult(BaseModel):
    created: int
    domains: list[AnalysisDomainResponse]


# ═══════════════════════════════════════════════════════════════════════════════
# Suggest schemas
# ═══════════════════════════════════════════════════════════════════════════════


class DomainSuggestedItem(BaseModel):
    member_type: str
    member_id: int
    label: str
    dataset_id: int | None = None
    dataset_name: str | None = None
    column_type: str | None = None
    reason: str | None = None


class DomainSuggestion(BaseModel):
    name: str
    members: list[DomainSuggestedItem]
    # Phase 4: pre-computed equivalence pairings for cross-dataset clusters.
    # Each inner list = column IDs that should belong to one EquivalenceGroup.
    # Single-dataset suggestions return [] (no pairing needed). Cross-dataset
    # clusters where pairing was inconclusive return [] AND set unpaired=True.
    members_paired: list[list[int]] = Field(default_factory=list)
    unpaired: bool = False
    pairing_reason: str | None = None  # e.g. "text_match:0.85", null if unpaired


class DomainSuggestResponse(BaseModel):
    suggestions: list[DomainSuggestion]
