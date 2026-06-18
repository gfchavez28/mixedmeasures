from pydantic import BaseModel, ConfigDict, Field, field_validator
from datetime import datetime
from .common import UTCTimestamp
from ..models.project import ProjectStatus


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    status: ProjectStatus | None = None
    category_level_names: dict[str, str] | None = None

    @field_validator('category_level_names')
    @classmethod
    def validate_category_level_names(cls, v: dict[str, str] | None) -> dict[str, str] | None:
        if v is None:
            return None
        for key, val in v.items():
            try:
                depth = int(key)
            except ValueError:
                raise ValueError(f'Key "{key}" must be a stringified non-negative integer')
            if depth < 0:
                raise ValueError(f'Key "{key}" must be a non-negative integer')
            if not isinstance(val, str) or len(val) < 1 or len(val) > 50:
                raise ValueError(f'Value for key "{key}" must be a string of 1-50 characters')
        return v


class ProjectResponse(BaseModel):
    id: int
    user_id: int
    name: str
    description: str | None
    status: ProjectStatus
    created_at: UTCTimestamp
    updated_at: UTCTimestamp
    conversation_count: int = 0
    code_count: int = 0
    dataset_count: int = 0
    document_count: int = 0
    participant_count: int = 0
    category_level_names: dict[str, str] | None = None

    model_config = ConfigDict(from_attributes=True)


class ProjectListResponse(BaseModel):
    projects: list[ProjectResponse]
    total: int


class RecentConversation(BaseModel):
    id: int
    name: str
    updated_at: UTCTimestamp
    segment_count: int = 0
    coded_segment_count: int = 0


class RecentDataset(BaseModel):
    id: int
    name: str
    created_at: UTCTimestamp
    row_count: int = 0
    column_count: int = 0


class RecentDocument(BaseModel):
    id: int
    name: str
    updated_at: UTCTimestamp
    segment_count: int = 0
    coded_segment_count: int = 0


class ProjectSummaryResponse(BaseModel):
    conversations: int = 0
    datasets: int = 0
    documents: int = 0
    participants: int = 0
    codes: int = 0
    categories: int = 0
    coded_segments: int = 0
    document_segments: int = 0
    materials: int = 0
    statistical_tests: int = 0
    memos: int = 0
    total_records: int = 0
    total_variables: int = 0
    open_ended_columns: int = 0
    notes_count: int = 0
    canvas_count: int = 0
    recent_conversations: list[RecentConversation] = []
    recent_datasets: list[RecentDataset] = []
    recent_documents: list[RecentDocument] = []
