"""Schemas for code sets — a mutually exclusive group of codes (queue row 48).

Mirrors `code_equivalence.py`, which is the right shape for the wrong relation:
a code belongs to at most one set through a single FK, so there is no
cardinality concept — but the members are ALTERNATIVES rather than synonyms, and
exactly one of them may be chosen per unit.
"""
from pydantic import BaseModel, ConfigDict, Field

from .common import UTCTimestamp


class CodeSetMemberInfo(BaseModel):
    """One VALUE the set's variable can take."""
    id: int
    numeric_id: int
    name: str
    description: str | None = None
    color: str | None = None
    is_active: bool
    is_universal: bool

    model_config = ConfigDict(from_attributes=True)


class CodeSetResponse(BaseModel):
    id: int
    project_id: int
    label: str
    description: str | None = None
    #: 🔴 Whether a unit with no member chosen is MISSING DATA (True) or took the
    #: real value "none of these" (False). Not cosmetic — it changes the
    #: denominator of the set's α, and the coverage a partially-coded round owes.
    exhaustive: bool = False
    members: list[CodeSetMemberInfo] = []
    #: `code_sets.SET_BASIS_*` for this set's `exhaustive` — carried so a surface
    #: describing the set uses the same vocabulary the α payload states.
    set_basis: str
    #: Members whose selections would silently leave the set, as sentences.
    #: Empty is the normal state. A member grouped with an OUTSIDE code as one
    #: effective code cannot be chosen through this set, and the refusal at the
    #: set's own door cannot close the equivalence-side route into that state.
    composition_warnings: list[str] = []
    created_at: UTCTimestamp
    updated_at: UTCTimestamp

    model_config = ConfigDict(from_attributes=True)


class CodeSetListResponse(BaseModel):
    sets: list[CodeSetResponse]
    total: int


class CodeSetCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    exhaustive: bool = False
    code_ids: list[int] = []


class CodeSetUpdate(BaseModel):
    label: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    exhaustive: bool | None = None


class CodeSetAddCodes(BaseModel):
    code_ids: list[int] = Field(..., min_length=1)


class CodeSetRemoveCodes(BaseModel):
    code_ids: list[int] = Field(..., min_length=1)


class CodeSetRemoveCodesResponse(BaseModel):
    code_set: CodeSetResponse | None = None
    dissolved: bool = False


class CodeSetSelectionRequest(BaseModel):
    """Choose ONE member of a set on one target, or clear the selection.

    🔴 ``code_id = None`` CLEARS, and on an exhaustive set that is legal — a
    coder may un-decide. It is not the same act as choosing "none of these" on an
    inclusive set, where `null` simply IS that value by definition, which is why
    the sentinel lives in the α matrix and never on the wire.
    """
    code_id: int | None = None


class TextCodeSetSelectionRequest(CodeSetSelectionRequest):
    """The text-coding sibling — same act, and the cell rides the BODY.

    ⚠️ Kept beside its segment twin rather than in `schemas/text_coding.py`,
    because the pair's whole claim is that they differ in the target column and
    nothing else; splitting them across two files is where that stops being
    checkable by reading.
    """
    dataset_value_id: int


class CodeSetSelectionResponse(BaseModel):
    set_id: int
    #: The member now selected, or None when the selection was cleared.
    code_id: int | None = None
    #: Applications removed to make the selection exclusive — across a segment
    #: GROUP this counts every sibling's row, not just the addressed one.
    removed: int = 0
