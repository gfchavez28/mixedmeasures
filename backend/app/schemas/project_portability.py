"""Pydantic schemas for project portability (export/import) endpoints."""

from pydantic import BaseModel


class ProjectSummary(BaseModel):
    conversation_count: int
    dataset_count: int
    document_count: int
    code_count: int
    category_count: int
    memo_count: int
    participant_count: int
    excerpt_count: int


class ProjectExportManifest(BaseModel):
    format_version: int
    format_type: str
    app_version: str
    created_at: str
    project_name: str
    project_summary: ProjectSummary


class ImportValidationResult(BaseModel):
    manifest: ProjectExportManifest
    warnings: list[str]


class ProjectImportResult(BaseModel):
    project_id: int
    project_name: str


class CodebookImportResult(BaseModel):
    categories_created: int
    categories_skipped: int
    codes_created: int
    codes_skipped: int
    codes_uncategorized: int
