"""Schemas for code-equivalence groups (Track J · J2-3, Slab 6).

Codes grouped as one "effective code" for agreement/consensus. Mirrors the
dataset-column `equivalence.py` schemas but simpler — a code belongs to at most
one group via a single FK, so there is no per-dataset cardinality concept.
"""
from pydantic import BaseModel, ConfigDict, Field

from .common import UTCTimestamp


class CodeEquivalenceMemberInfo(BaseModel):
    """A member code, enriched for the reconciliation UI (J2-5).

    `description` carries the code definition (added J3-2b · B0) so the
    reconciliation member rows can show what each grouped code means.
    `model_validate(c)` populates it directly from `Code.description`.
    (Category name + usage count are NOT on this schema — they belong on the
    J3-2b merge-code preview candidates, populated by explicit query logic.)
    """
    id: int
    numeric_id: int
    name: str
    description: str | None = None
    color: str | None = None
    is_active: bool
    is_universal: bool

    model_config = ConfigDict(from_attributes=True)


class CodeEquivalenceGroupResponse(BaseModel):
    id: int
    project_id: int
    label: str
    description: str | None = None
    canonical_code_id: int | None = None
    origin: str
    members: list[CodeEquivalenceMemberInfo] = []
    created_at: UTCTimestamp
    updated_at: UTCTimestamp

    model_config = ConfigDict(from_attributes=True)


class CodeEquivalenceGroupListResponse(BaseModel):
    groups: list[CodeEquivalenceGroupResponse]
    total: int


class CodeEquivalenceGroupCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    code_ids: list[int] = []
    canonical_code_id: int | None = None


class CodeEquivalenceGroupUpdate(BaseModel):
    label: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    canonical_code_id: int | None = None


class CodeEquivalenceGroupAddCodes(BaseModel):
    code_ids: list[int] = Field(..., min_length=1)


class CodeEquivalenceGroupRemoveCodes(BaseModel):
    code_ids: list[int] = Field(..., min_length=1)


class CodeEquivalenceGroupRemoveCodesResponse(BaseModel):
    group: CodeEquivalenceGroupResponse | None = None
    dissolved: bool = False
