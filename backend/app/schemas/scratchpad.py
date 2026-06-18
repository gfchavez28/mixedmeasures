from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from .common import UTCTimestamp


class ScratchpadEntryCreate(BaseModel):
    content: str = Field(..., min_length=1)
    context_hint: str | None = Field(None, max_length=255)


class ScratchpadEntryUpdate(BaseModel):
    content: str | None = Field(None, min_length=1)
    resolved: bool | None = None


class ScratchpadConvertRequest(BaseModel):
    target_type: str = Field(..., pattern=r'^(memo)$')
    entity_type: str = Field(..., pattern=r'^(project|conversation|document|code|code_category|analysis|dataset|dataset_row|dataset_column|canvas)$')
    entity_id: int


class ScratchpadEntryResponse(BaseModel):
    id: int
    project_id: int
    numeric_id: int
    content: str
    context_hint: str | None
    resolved: bool
    resolved_into_type: str | None
    resolved_into_id: int | None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp

    model_config = ConfigDict(from_attributes=True)


class ScratchpadListResponse(BaseModel):
    entries: list[ScratchpadEntryResponse]
    total: int
