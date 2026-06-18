from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from .common import UTCTimestamp


class MemoCreate(BaseModel):
    entity_type: str = Field(..., pattern=r'^(project|conversation|document|code|code_category|analysis|dataset|dataset_row|dataset_column|canvas)$')
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
