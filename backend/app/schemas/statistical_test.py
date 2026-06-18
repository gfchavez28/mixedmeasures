"""Pydantic schemas for statistical test endpoints."""

from datetime import datetime
from .common import UTCTimestamp

from pydantic import BaseModel, Field, field_validator


# ═══════════════════════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════════════════════

VALID_TEST_TYPES = {"cronbachs_alpha", "independent_t_test", "one_way_anova", "split_half"}
VALID_TARGET_TYPES = {"analysis_domain", "metric_definition"}


# ═══════════════════════════════════════════════════════════════════════════════
# Request schemas
# ═══════════════════════════════════════════════════════════════════════════════


class StatisticalTestCreate(BaseModel):
    test_type: str
    target_type: str
    target_id: int
    config: dict = Field(default_factory=dict)

    @field_validator("test_type")
    @classmethod
    def validate_test_type(cls, v: str) -> str:
        if v not in VALID_TEST_TYPES:
            raise ValueError(f"test_type must be one of {sorted(VALID_TEST_TYPES)}")
        return v

    @field_validator("target_type")
    @classmethod
    def validate_target_type(cls, v: str) -> str:
        if v not in VALID_TARGET_TYPES:
            raise ValueError(f"target_type must be one of {sorted(VALID_TARGET_TYPES)}")
        return v


class StatisticalTestUpdate(BaseModel):
    config: dict | None = None


class ComputeAllTestsRequest(BaseModel):
    stale_only: bool = False


# ═══════════════════════════════════════════════════════════════════════════════
# Response schemas
# ═══════════════════════════════════════════════════════════════════════════════


class StatisticalTestResponse(BaseModel):
    id: int
    project_id: int
    test_type: str
    config: dict
    target_type: str
    target_id: int
    target_label: str | None = None
    result_data: dict | None = None
    valid_n: int | None = None
    stale: bool
    computed_at: UTCTimestamp | None = None
    origin: str
    origin_context: str | None = None
    created_at: UTCTimestamp
    updated_at: UTCTimestamp


class StatisticalTestListResponse(BaseModel):
    tests: list[StatisticalTestResponse]
    total: int


class ComputeAllTestsResponse(BaseModel):
    computed: int
    errors: list[dict] = []
