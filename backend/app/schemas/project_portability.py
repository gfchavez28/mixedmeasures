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
    # Track J · J3-1: stable cross-instance identity. Optional — files exported before
    # J3-1 lack it (None → import-as-new, the legacy behavior).
    project_uuid: str | None = None


class ExistingProjectInfo(BaseModel):
    """Track J · J3-1: a local project that shares the incoming file's project_uuid."""
    id: int
    name: str


class MergeCoderMatch(BaseModel):
    """A local roster coder the merge could map an incoming coder onto."""
    id: int
    username: str
    archived: bool
    local_app_count: int


class MergeCoderPreview(BaseModel):
    """Track J · J3-2: one coder in an incoming merge file, with its local
    name-match candidate (if any) so the UI can confirm/override the mapping
    before committing (D8). System coders (Unattributed/Consensus) are excluded."""
    original_id: int
    username: str
    coder_type: str
    archived: bool
    file_app_count: int
    local_match: MergeCoderMatch | None = None


class MergeCodeCandidate(BaseModel):
    """A local code the reconcile UI could collapse-onto / link-with, ranked by
    name similarity to a divergent file code. ``confident`` flags similarity ≥ 0.70."""
    code_id: int
    name: str
    description: str | None = None
    usage: int
    similarity: float
    confident: bool


class MergeCodePreview(BaseModel):
    """Track J · J3-2b: one DIVERGENT code in an incoming merge file (its uuid is not
    in the local codebook), with file-side usage + ranked local candidates so the
    reconcile step can map it to collapse / link / new. Populated only when a merge is
    possible (existing_project set) AND the codebook diverges; empty when shared-frozen.
    ``category_name`` is shown for context only (R5: categories are never matched on)."""
    uuid: str
    name: str
    description: str | None = None
    color: str | None = None
    category_name: str | None = None
    file_app_count: int
    candidates: list[MergeCodeCandidate] = []


class ImportValidationResult(BaseModel):
    manifest: ProjectExportManifest
    warnings: list[str]
    # Track J · J3-1: set when an existing local project matches the file's
    # project_uuid, so the import UI can offer "overwrite" vs "import as new copy".
    existing_project: ExistingProjectInfo | None = None
    # Track J · J3-2: the incoming file's coders + their local match candidates,
    # populated only when a merge is possible (existing_project set). Drives the
    # coder-confirm step.
    merge_coders: list[MergeCoderPreview] | None = None
    # Track J · J3-2b: divergent codes in the incoming file (uuid not local) + ranked
    # local reconcile candidates. Populated by validate-import (B3) when a merge is
    # possible AND the codebook diverges; None/[] when shared-frozen (the common case).
    # Drives the code-reconcile step.
    merge_codes_preview: list[MergeCodePreview] | None = None


class MergeReport(BaseModel):
    """Track J · J3-2: what a merge actually did (returned on import_mode='merge')."""
    sources_matched: int
    applications_added: int
    duplicates_skipped: int
    coders_created: int
    coders_matched: int
    # Track J · J3-2b: divergent-code reconciliation outcomes.
    codes_collapsed: int = 0
    codes_linked: int = 0
    codes_created: int = 0


class ProjectImportResult(BaseModel):
    project_id: int
    project_name: str
    # Track J · J3-2: populated only for import_mode='merge'.
    merge_report: MergeReport | None = None


class CodebookImportResult(BaseModel):
    categories_created: int
    categories_skipped: int
    codes_created: int
    codes_skipped: int
    codes_uncategorized: int
