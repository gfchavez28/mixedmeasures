from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime
from .common import UTCTimestamp


class CodeCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    color: str | None = Field(None, pattern=r'^#[0-9A-Fa-f]{6}$')
    category_id: int | None = None


class CodeUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    color: str | None = Field(None, pattern=r'^#[0-9A-Fa-f]{6}$')
    is_active: bool | None = None
    category_id: int | None = Field(None)


class CodeResponse(BaseModel):
    id: int
    project_id: int
    numeric_id: int
    name: str
    description: str | None
    color: str | None
    is_universal: bool
    is_active: bool
    created_at: UTCTimestamp
    updated_at: UTCTimestamp
    usage_count: int = 0
    category_id: int | None = None
    category_name: str | None = None
    category_color: str | None = None
    category_order: int | None = None

    model_config = ConfigDict(from_attributes=True)


class CodeListResponse(BaseModel):
    codes: list[CodeResponse]
    total: int


class CodeCategoryCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    color: str | None = Field(None, pattern=r'^#[0-9A-Fa-f]{6}$')
    parent_id: int | None = None


class CodeCategoryUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    color: str | None = Field(None, pattern=r'^#[0-9A-Fa-f]{6}$')
    display_order: int | None = None
    parent_id: int | None = Field(None)


class CodeCategoryResponse(BaseModel):
    id: int
    project_id: int
    name: str
    color: str | None
    display_order: int
    parent_id: int | None = None
    created_at: UTCTimestamp
    code_count: int = 0

    model_config = ConfigDict(from_attributes=True)


class CodeCategoryWithCodesResponse(BaseModel):
    id: int
    project_id: int
    name: str
    color: str | None
    display_order: int
    parent_id: int | None = None
    created_at: UTCTimestamp
    code_count: int = 0
    codes: list[CodeResponse] = []

    model_config = ConfigDict(from_attributes=True)


class CategoryReorderRequest(BaseModel):
    ordered_ids: list[int]


class CodeReorderInCategoryRequest(BaseModel):
    category_id: int | None = None
    ordered_code_ids: list[int]


class BulkMoveRequest(BaseModel):
    code_ids: list[int] = Field(..., min_length=1)
    target_category_id: int | None = None


class BulkMoveResponse(BaseModel):
    moved: int


class MergeCodesResponse(BaseModel):
    merged: int
    skipped: int
    source_action: str


class CategoryMergeRequest(BaseModel):
    source_ids: list[int] = Field(..., min_length=1)
    target_id: int


class CategoryMergeResponse(BaseModel):
    merged_codes: int
    reparented_categories: int
    merged_memos: int


class CategoryBulkMoveRequest(BaseModel):
    category_ids: list[int] = Field(..., min_length=1)
    target_parent_id: int | None = None


class CategoryBulkMoveResponse(BaseModel):
    moved: int


class GroupIntoCategoryRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    color: str | None = Field(None, pattern=r'^#[0-9A-Fa-f]{6}$')
    category_ids: list[int] = []
    code_ids: list[int] = []
