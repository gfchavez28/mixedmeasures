from pydantic import BaseModel, Field, field_validator
from datetime import datetime
from .common import UTCTimestamp


class ApplyCodeRequest(BaseModel):
    attribution: str | None = None


class BulkCodeRequest(BaseModel):
    # Bounded to match the text-coding sibling (BulkCodeRequest there has carried
    # min/max since it shipped). Unbounded, a single post could ask the server to
    # walk an arbitrary id list and emit a result row per entry.
    segment_ids: list[int] = Field(..., min_length=1, max_length=5000)
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
    # #678: WHICH ids the server could not act on — not just how many.
    #
    # `results[].applied` cannot answer this, because it means different things
    # per action: on an APPLY it is True for success, but on a REMOVE it is False
    # for *success* ("the code is now not applied"), which is the same value a
    # skipped id carries. A client reconciling on `applied` alone would treat
    # every successful bulk-remove as a total failure. Keep this list explicit and
    # leave `applied` untouched — it is load-bearing at the single-apply/remove
    # call sites, so redefining it is a separate and riskier change.
    failed_segment_ids: list[int] = []


class CodingProgressResponse(BaseModel):
    conversation_id: int
    total_segments: int
    coded_segments: int
    participant_segments: int
    participant_coded: int
    progress_percent: float
