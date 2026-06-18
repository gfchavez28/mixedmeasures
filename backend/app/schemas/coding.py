from pydantic import BaseModel, field_validator
from datetime import datetime
from .common import UTCTimestamp


class ApplyCodeRequest(BaseModel):
    attribution: str | None = None


class BulkCodeRequest(BaseModel):
    segment_ids: list[int]
    code_id: int
    action: str = "apply"
    attribution: str | None = None

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        if v not in ("apply", "remove"):
            raise ValueError("action must be 'apply' or 'remove'")
        return v


class CodeApplicationResponse(BaseModel):
    segment_id: int | None = None
    dataset_value_id: int | None = None
    code_id: int
    applied: bool
    created_at: UTCTimestamp | None = None


class BulkCodeResponse(BaseModel):
    results: list[CodeApplicationResponse]
    success_count: int
    error_count: int


class CodingProgressResponse(BaseModel):
    conversation_id: int
    total_segments: int
    coded_segments: int
    participant_segments: int
    participant_coded: int
    progress_percent: float
