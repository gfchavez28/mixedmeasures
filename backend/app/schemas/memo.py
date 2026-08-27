from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from ..models.memo import MEMO_ENTITY_TYPES
from .common import UTCTimestamp

#: DERIVED from the model's vocabulary, never re-typed (#780). The literal that
#: used to live here was one of five hand-maintained copies; this one cannot
#: drift from `MEMO_ENTITY_TYPES` because it is built from it.
_ENTITY_TYPE_PATTERN = rf'^({"|".join(MEMO_ENTITY_TYPES)})$'


class MemoCreate(BaseModel):
    entity_type: str = Field(..., pattern=_ENTITY_TYPE_PATTERN)
    entity_id: int
    title: str | None = Field(None, max_length=255)
    content: str = ""


class MemoUpdate(BaseModel):
    title: str | None = Field(None, max_length=255)
    content: str | None = None
    is_archived: bool | None = None


class MemoResponse(BaseModel):
    id: int
    project_id: int
    numeric_id: int  # Human-friendly ID (M-1, M-2, etc.)
    entity_type: str
    entity_id: int
    title: str | None
    content: str
    is_archived: bool
    created_at: UTCTimestamp
    updated_at: UTCTimestamp

    model_config = ConfigDict(from_attributes=True)


class MemoListResponse(BaseModel):
    memos: list[MemoResponse]
    total: int
