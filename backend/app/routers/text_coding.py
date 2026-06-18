"""Router for text coding — coding open-ended text responses."""

import json
import io
import csv
from datetime import datetime, timezone
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import get_db
from ..models.user import User
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from ..models.code_application import CodeApplication
from ..models.code import Code
from ..models.note import Note
from ..models.text_coding_config import TextCodingConfig, DEFAULT_TREAT_AS_EMPTY
from ..models.excerpt import Excerpt
from ..models.speaker import Speaker
from ..models.conversation import Conversation
from ..models.participant import Participant
from ..auth import get_current_user
from .helpers import _get_project_or_404, parse_int_list, sanitize_csv_filename, TEXT_TYPES
from .export_helpers import csv_safe
from ..schemas.text_coding import (
    TextCodeRequest, BulkCodeRequest, BulkRemoveCodeRequest,
    TextNoteCreate, TextNoteUpdate,
    TextCodingConfigUpdate,
    TextsListResponse, TextResponse, RecordsListResponse, RecordResponse,
    RecordContextResponse, LinkedConversationResponse, ColumnValueResponse,
    NonTextValueResponse, TextValueResponse, ColumnPositionResponse,
    TextColumnsListResponse, TextColumnResponse,
    CodingProgressResponse, ColumnProgressResponse,
    TextCodingConfigResponse,
    TextCodeResponse, BulkCodeResponse, BulkRemoveCodeResponse,
)
from ..schemas.note import NoteResponse

router = APIRouter(
    prefix="/api/projects/{project_id}/text-coding",
    tags=["text-coding"],
)



def _get_text_value_or_404(db: Session, project_id: int, dataset_value_id: int) -> DatasetValue:
    """Validate DatasetValue exists, belongs to text column, in this project."""
    dv = (
        db.query(DatasetValue)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            DatasetValue.id == dataset_value_id,
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
        .first()
    )
    if not dv:
        raise HTTPException(
            status_code=400,
            detail=f"DatasetValue {dataset_value_id} not found or not a text column in this project"
        )
    return dv


def _get_config(db: Session, project_id: int) -> TextCodingConfig:
    """Get or create TextCodingConfig for project."""
    config = db.query(TextCodingConfig).filter(
        TextCodingConfig.project_id == project_id
    ).first()
    if not config:
        config = TextCodingConfig(project_id=project_id)
        db.add(config)
        db.flush()
    return config


def _get_treat_as_empty(config: TextCodingConfig) -> list[str]:
    """Get treat_as_empty list from config or defaults."""
    if config.treat_as_empty:
        try:
            return json.loads(config.treat_as_empty)
        except (json.JSONDecodeError, TypeError):
            pass
    return DEFAULT_TREAT_AS_EMPTY


def _is_empty(value_text: str | None, treat_as_empty: list[str]) -> bool:
    """Check if a value is considered empty."""
    if not value_text or not value_text.strip():
        return True
    return value_text.strip() in treat_as_empty


# ── 1. GET /texts ───────────────────────────────────────────────────────────

@router.get("/texts", response_model=TextsListResponse)
async def list_texts(
    project_id: int,
    column_ids: str = Query(..., description="Comma-separated DatasetColumn IDs"),
    dataset_ids: str | None = Query(None, description="Comma-separated Dataset IDs to filter"),
    hide_empty: bool = Query(True),
    record_id: int | None = Query(None, description="Single DatasetRow ID for record filter"),
    search: str | None = Query(None, description="Text search within value_text"),
    sort_by: str = Query("column_asc"),
    random_seed: int | None = Query(None),
    quoted_only: bool = Query(False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id, user.id)
    parsed_column_ids = parse_int_list(column_ids)
    if not parsed_column_ids:
        raise HTTPException(status_code=400, detail="column_ids is required")
    parsed_dataset_ids = parse_int_list(dataset_ids)

    config = _get_config(db, project_id)
    treat_as_empty = _get_treat_as_empty(config)

    # Base query: DatasetValue joined to column/dataset/row/participant
    query = (
        db.query(
            DatasetValue.id,
            DatasetValue.value_text,
            DatasetValue.row_id,
            DatasetColumn.id.label("col_id"),
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            DatasetColumn.sequence_order,
            Dataset.id.label("ds_id"),
            Dataset.name.label("ds_name"),
            DatasetRow.id.label("row_id"),
            DatasetRow.row_identifier,
            DatasetRow.participant_id,
            Participant.display_name.label("participant_display_name"),
            Participant.identifier.label("participant_identifier_name"),
        )
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .outerjoin(Participant, DatasetRow.participant_id == Participant.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
            DatasetColumn.id.in_(parsed_column_ids),
        )
    )

    if parsed_dataset_ids:
        query = query.filter(Dataset.id.in_(parsed_dataset_ids))

    if record_id:
        query = query.filter(DatasetRow.id == record_id)

    if search:
        escaped_search = search.replace("%", r"\%").replace("_", r"\_")
        query = query.filter(DatasetValue.value_text.ilike(f"%{escaped_search}%", escape="\\"))

    rows = query.all()

    # Get code applications for all matching values
    value_ids = [r[0] for r in rows]

    # Batch-fetch quoted excerpts scoped to result values
    if value_ids:
        quoted_excerpts = dict(
            db.query(Excerpt.dataset_value_id, Excerpt.id)
            .filter(Excerpt.project_id == project_id, Excerpt.dataset_value_id.in_(value_ids))
            .all()
        )
    else:
        quoted_excerpts = {}

    code_apps = {}
    if value_ids:
        ca_query = (
            db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
            .filter(
                CodeApplication.dataset_value_id.in_(value_ids),
                CodeApplication.dataset_value_id.isnot(None),
            )
            .all()
        )
        for dv_id, code_id in ca_query:
            if dv_id not in code_apps:
                code_apps[dv_id] = []
            code_apps[dv_id].append(code_id)

    # Get note counts
    note_counts = {}
    if value_ids:
        nc_query = (
            db.query(Note.dataset_value_id, func.count(Note.id))
            .filter(
                Note.dataset_value_id.in_(value_ids),
                Note.is_archived == False,
            )
            .group_by(Note.dataset_value_id)
            .all()
        )
        note_counts = {dv_id: cnt for dv_id, cnt in nc_query}

    # Apply in-memory filtering and build response
    texts = []
    coded_value_ids = set()
    coded_record_ids = set()
    non_empty_count = 0
    all_record_ids = set()

    for r in rows:
        value_text = r.value_text
        is_empty = _is_empty(value_text, treat_as_empty)

        if hide_empty and is_empty:
            continue

        if not is_empty:
            non_empty_count += 1

        dv_id = r[0]
        is_quoted = dv_id in quoted_excerpts

        if quoted_only and not is_quoted:
            continue

        applied_codes = code_apps.get(dv_id, [])
        nc = note_counts.get(dv_id, 0)
        word_count = len(value_text.split()) if value_text and value_text.strip() else 0

        all_record_ids.add(r.row_id)
        if applied_codes:
            coded_value_ids.add(dv_id)
            coded_record_ids.add(r.row_id)

        texts.append(TextResponse(
            dataset_value_id=dv_id,
            dataset_id=r.ds_id,
            dataset_name=r.ds_name,
            dataset_row_id=r.row_id,
            row_identifier=r.row_identifier,
            participant_id=r.participant_id,
            participant_name=(r.participant_display_name or r.participant_identifier_name) if r.participant_id else None,
            column_id=r.col_id,
            column_name=r.column_name,
            column_text=r.column_text,
            column_sequence_order=r.sequence_order,
            value_text=value_text,
            word_count=word_count,
            is_quoted=is_quoted,
            excerpt_id=quoted_excerpts.get(dv_id),
            applied_code_ids=applied_codes,
            note_count=nc,
        ))

    # Sort
    if random_seed is not None:
        texts.sort(key=lambda t: abs((t.dataset_value_id * random_seed) % 2147483647))
    elif sort_by == "record_asc":
        texts.sort(key=lambda t: (t.row_identifier or "", t.column_sequence_order))
    elif sort_by == "record_desc":
        texts.sort(key=lambda t: (t.row_identifier or "", t.column_sequence_order), reverse=True)
    elif sort_by == "column_desc":
        texts.sort(key=lambda t: (t.column_sequence_order, t.row_identifier or ""), reverse=True)
    else:  # column_asc (default)
        texts.sort(key=lambda t: (t.column_sequence_order, t.row_identifier or ""))

    return TextsListResponse(
        texts=texts,
        total_texts=len(texts),
        non_empty_texts=non_empty_count,
        coded_texts=len(coded_value_ids),
        total_rows=len(all_record_ids),
        coded_rows=len(coded_record_ids),
    )


# ── 2. GET /records ─────────────────────────────────────────────────────

@router.get("/records", response_model=RecordsListResponse)
async def list_records(
    project_id: int,
    column_ids: str = Query(..., description="Comma-separated DatasetColumn IDs"),
    dataset_ids: str | None = Query(None),
    hide_empty: bool = Query(True),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id, user.id)
    parsed_column_ids = parse_int_list(column_ids)
    if not parsed_column_ids:
        raise HTTPException(status_code=400, detail="column_ids is required")
    parsed_dataset_ids = parse_int_list(dataset_ids)

    config = _get_config(db, project_id)
    treat_as_empty = _get_treat_as_empty(config)

    # Get all texts for these columns
    query = (
        db.query(
            DatasetValue.id,
            DatasetValue.value_text,
            DatasetRow.id.label("row_id"),
            DatasetRow.row_identifier,
            DatasetRow.participant_id,
            Dataset.id.label("ds_id"),
            Dataset.name.label("ds_name"),
        )
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
            DatasetColumn.id.in_(parsed_column_ids),
        )
    )

    if parsed_dataset_ids:
        query = query.filter(Dataset.id.in_(parsed_dataset_ids))

    rows = query.all()

    # Get all code applications in one query
    value_ids = [r[0] for r in rows]
    coded_values = set()
    if value_ids:
        coded_dv_ids = (
            db.query(func.distinct(CodeApplication.dataset_value_id))
            .filter(CodeApplication.dataset_value_id.in_(value_ids))
            .all()
        )
        coded_values = {dv_id for (dv_id,) in coded_dv_ids}

    # Group by record (DatasetRow)
    record_data = {}
    for r in rows:
        is_empty = _is_empty(r.value_text, treat_as_empty)
        if hide_empty and is_empty:
            continue

        row_id = r.row_id
        if row_id not in record_data:
            record_data[row_id] = {
                "row_id": row_id,
                "row_identifier": r.row_identifier,
                "participant_id": r.participant_id,
                "ds_id": r.ds_id,
                "ds_name": r.ds_name,
                "text_count": 0,
                "coded_text_count": 0,
            }
        if not is_empty:
            record_data[row_id]["text_count"] += 1
            if r[0] in coded_values:
                record_data[row_id]["coded_text_count"] += 1

    # Get linked conversation IDs via Participant → Speaker → Conversation
    participant_ids = set(
        rd["participant_id"] for rd in record_data.values() if rd["participant_id"]
    )
    linked_convs = defaultdict(list)
    if participant_ids:
        from ..models.segment import Segment
        conv_links = (
            db.query(Speaker.participant_id, func.distinct(Segment.conversation_id))
            .join(Segment, Segment.speaker_id == Speaker.id)
            .filter(Speaker.participant_id.in_(participant_ids))
            .group_by(Speaker.participant_id, Segment.conversation_id)
            .all()
        )
        for pid, conv_id in conv_links:
            linked_convs[pid].append(conv_id)

    # Get participant names
    participant_names = {}
    if participant_ids:
        parts = db.query(Participant.id, Participant.display_name, Participant.identifier).filter(
            Participant.id.in_(participant_ids)
        ).all()
        participant_names = {p.id: p.display_name or p.identifier for p in parts}

    records = []
    for rd in record_data.values():
        pid = rd["participant_id"]
        records.append(RecordResponse(
            dataset_row_id=rd["row_id"],
            row_identifier=rd["row_identifier"],
            participant_id=pid,
            participant_name=participant_names.get(pid) if pid else None,
            dataset_id=rd["ds_id"],
            dataset_name=rd["ds_name"],
            text_count=rd["text_count"],
            coded_text_count=rd["coded_text_count"],
            linked_conversation_ids=linked_convs.get(pid, []) if pid else [],
        ))

    records.sort(key=lambda r: r.row_identifier or "")

    return RecordsListResponse(
        records=records,
        total=len(records),
    )


# ── 3. GET /record-context/{dataset_row_id} ─────────────────────────────

@router.get("/record-context/{dataset_row_id}", response_model=RecordContextResponse)
async def record_context(
    project_id: int,
    dataset_row_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id, user.id)

    result = (
        db.query(DatasetRow, Dataset)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(DatasetRow.id == dataset_row_id, Dataset.project_id == project_id)
        .first()
    )
    if not result:
        raise HTTPException(status_code=404, detail="Record not found in this project")

    row, dataset = result

    # Get all columns for this dataset
    columns = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.dataset_id == row.dataset_id)
        .order_by(DatasetColumn.sequence_order)
        .all()
    )

    # Get all values for this row
    values = (
        db.query(DatasetValue)
        .filter(DatasetValue.row_id == dataset_row_id)
        .all()
    )
    value_map = {v.column_id: v.value_text for v in values}

    demographics = []
    texts = []
    other_columns = []
    column_positions = []

    for col in columns:
        val = value_map.get(col.id)
        col_name = col.column_name or (col.column_text[:50] if col.column_text else "")
        col_type = col.column_type.value if hasattr(col.column_type, 'value') else str(col.column_type)

        column_positions.append(ColumnPositionResponse(
            column_id=col.id,
            column_name=col_name,
            sequence_order=col.sequence_order,
            column_type=col_type,
        ))

        if col.column_type == ColumnType.DEMOGRAPHIC:
            demographics.append(ColumnValueResponse(
                column_id=col.id,
                column_name=col_name,
                value=val,
            ))
        elif col.column_type in TEXT_TYPES:
            texts.append(TextValueResponse(
                column_id=col.id,
                column_name=col_name,
                value=val,
                sequence_order=col.sequence_order,
            ))
        elif col.column_type != ColumnType.SKIP:
            other_columns.append(NonTextValueResponse(
                column_id=col.id,
                column_name=col_name,
                value=val,
                column_type=col_type,
                sequence_order=col.sequence_order,
            ))

    # Linked conversations
    linked_conversations = []
    if row.participant_id:
        from ..models.segment import Segment
        conv_rows = (
            db.query(Conversation.id, Conversation.name)
            .join(Segment, Segment.conversation_id == Conversation.id)
            .join(Speaker, Segment.speaker_id == Speaker.id)
            .filter(Speaker.participant_id == row.participant_id)
            .distinct()
            .all()
        )
        linked_conversations = [
            LinkedConversationResponse(id=cid, name=cname)
            for cid, cname in conv_rows
        ]

    return RecordContextResponse(
        row_identifier=row.row_identifier,
        participant_id=row.participant_id,
        dataset_id=dataset.id,
        dataset_name=dataset.name,
        linked_conversations=linked_conversations,
        demographics=demographics,
        texts=texts,
        other_columns=other_columns,
        column_positions=column_positions,
    )


# ── 4. GET /text-columns ─────────────────────────────────────────────────

@router.get("/text-columns", response_model=TextColumnsListResponse)
async def text_columns(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id, user.id)

    cols = (
        db.query(
            DatasetColumn.id,
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            DatasetColumn.column_type,
            DatasetColumn.sequence_order,
            Dataset.id.label("ds_id"),
            Dataset.name.label("ds_name"),
        )
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
        .order_by(Dataset.name, DatasetColumn.sequence_order)
        .all()
    )

    # Get row counts per column
    col_ids = [c[0] for c in cols]
    total_counts = {}
    non_empty_counts = {}
    if col_ids:
        # Total rows per column
        totals = (
            db.query(DatasetValue.column_id, func.count(DatasetValue.id))
            .filter(DatasetValue.column_id.in_(col_ids))
            .group_by(DatasetValue.column_id)
            .all()
        )
        total_counts = {cid: cnt for cid, cnt in totals}

        # Non-empty rows (also exclude treat_as_empty values)
        config = _get_config(db, project_id)
        treat_as_empty = _get_treat_as_empty(config)
        non_empty_q = (
            db.query(DatasetValue.column_id, func.count(DatasetValue.id))
            .filter(
                DatasetValue.column_id.in_(col_ids),
                DatasetValue.value_text.isnot(None),
                DatasetValue.value_text != "",
            )
        )
        for val in treat_as_empty:
            non_empty_q = non_empty_q.filter(DatasetValue.value_text != val)
        non_empty = non_empty_q.group_by(DatasetValue.column_id).all()
        non_empty_counts = {cid: cnt for cid, cnt in non_empty}

    # Coded rows per column
    coded_counts = {}
    if col_ids:
        coded = (
            db.query(DatasetValue.column_id, func.count(func.distinct(DatasetValue.id)))
            .join(CodeApplication, CodeApplication.dataset_value_id == DatasetValue.id)
            .filter(DatasetValue.column_id.in_(col_ids))
            .group_by(DatasetValue.column_id)
            .all()
        )
        coded_counts = {cid: cnt for cid, cnt in coded}

    columns = []
    for c in cols:
        col_type = c.column_type.value if hasattr(c.column_type, 'value') else str(c.column_type)
        columns.append(TextColumnResponse(
            column_id=c[0],
            dataset_id=c.ds_id,
            dataset_name=c.ds_name,
            column_name=c.column_name,
            column_text=c.column_text,
            column_type=col_type,
            sequence_order=c.sequence_order,
            total_rows=total_counts.get(c[0], 0),
            non_empty_rows=non_empty_counts.get(c[0], 0),
            coded_rows=coded_counts.get(c[0], 0),
        ))

    return TextColumnsListResponse(columns=columns)


# ── 5. POST /code ────────────────────────────────────────────────────────────

@router.post("/code", response_model=TextCodeResponse)
async def apply_code(
    project_id: int,
    data: TextCodeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    dv = _get_text_value_or_404(db, project_id, data.dataset_value_id)

    code = db.query(Code).filter(
        Code.id == data.code_id,
        Code.project_id == project_id,
        Code.is_active == True,
    ).first()
    if not code:
        raise HTTPException(status_code=400, detail="Code not found or inactive")

    # Check for duplicate
    existing = db.query(CodeApplication).filter(
        CodeApplication.dataset_value_id == data.dataset_value_id,
        CodeApplication.code_id == data.code_id,
    ).first()
    if existing:
        return TextCodeResponse(
            dataset_value_id=data.dataset_value_id,
            code_id=data.code_id,
            applied=True,
            created_at=existing.created_at,
        )

    ca = CodeApplication(
        segment_id=None,
        dataset_value_id=data.dataset_value_id,
        code_id=data.code_id,
        user_id=user.id,
        attribution=data.attribution,
    )
    db.add(ca)
    db.commit()
    db.refresh(ca)

    return TextCodeResponse(
        dataset_value_id=data.dataset_value_id,
        code_id=data.code_id,
        applied=True,
        created_at=ca.created_at,
    )


# ── 6. DELETE /code ──────────────────────────────────────────────────────────

@router.delete("/code")
async def remove_code(
    project_id: int,
    dataset_value_id: int = Query(...),
    code_id: int = Query(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_text_value_or_404(db, project_id, dataset_value_id)

    ca = db.query(CodeApplication).filter(
        CodeApplication.dataset_value_id == dataset_value_id,
        CodeApplication.code_id == code_id,
    ).first()
    if not ca:
        raise HTTPException(status_code=404, detail="Code application not found")

    db.delete(ca)
    db.commit()

    return {"status": "ok", "dataset_value_id": dataset_value_id, "code_id": code_id}


# ── 7. POST /bulk-code ──────────────────────────────────────────────────────

@router.post("/bulk-code", response_model=BulkCodeResponse)
async def bulk_code(
    project_id: int,
    data: BulkCodeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)

    code = db.query(Code).filter(
        Code.id == data.code_id,
        Code.project_id == project_id,
        Code.is_active == True,
    ).first()
    if not code:
        raise HTTPException(status_code=400, detail="Code not found or inactive")

    # Batch validate all dataset_value_ids in one query
    valid_dvs = (
        db.query(DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            DatasetValue.id.in_(data.dataset_value_ids),
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
        .all()
    )
    valid_ids = {dv_id for (dv_id,) in valid_dvs}

    # Get existing applications to skip duplicates
    existing = set(
        dv_id for (dv_id,) in db.query(CodeApplication.dataset_value_id).filter(
            CodeApplication.dataset_value_id.in_(data.dataset_value_ids),
            CodeApplication.code_id == data.code_id,
        ).all()
    )

    results = []
    success_count = 0
    error_count = 0

    for dv_id in data.dataset_value_ids:
        if dv_id not in valid_ids:
            results.append(TextCodeResponse(
                dataset_value_id=dv_id, code_id=data.code_id, applied=False
            ))
            error_count += 1
            continue

        if dv_id in existing:
            results.append(TextCodeResponse(
                dataset_value_id=dv_id, code_id=data.code_id, applied=True
            ))
            success_count += 1
            continue

        ca = CodeApplication(
            segment_id=None,
            dataset_value_id=dv_id,
            code_id=data.code_id,
            user_id=user.id,
        )
        db.add(ca)
        results.append(TextCodeResponse(
            dataset_value_id=dv_id, code_id=data.code_id, applied=True
        ))
        success_count += 1

    db.commit()

    return BulkCodeResponse(
        results=results,
        success_count=success_count,
        error_count=error_count,
    )


# ── 7b. POST /bulk-remove-code ─────────────────────────────────────────────

@router.post("/bulk-remove-code", response_model=BulkRemoveCodeResponse)
async def bulk_remove_code(
    project_id: int,
    data: BulkRemoveCodeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)

    code = db.query(Code).filter(
        Code.id == data.code_id,
        Code.project_id == project_id,
    ).first()
    if not code:
        raise HTTPException(status_code=400, detail="Code not found")

    # Validate dataset_value_ids belong to this project
    valid_dvs = (
        db.query(DatasetValue.id)
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            DatasetValue.id.in_(data.dataset_value_ids),
            Dataset.project_id == project_id,
        )
        .all()
    )
    valid_ids = {dv_id for (dv_id,) in valid_dvs}

    deleted_count = (
        db.query(CodeApplication)
        .filter(
            CodeApplication.dataset_value_id.in_(valid_ids),
            CodeApplication.code_id == data.code_id,
        )
        .delete(synchronize_session=False)
    )

    db.commit()

    return BulkRemoveCodeResponse(
        deleted_count=deleted_count,
        code_id=data.code_id,
    )


# ── 8. POST /notes ──────────────────────────────────────────────────────────

@router.post("/notes", response_model=NoteResponse)
async def create_text_note(
    project_id: int,
    data: TextNoteCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_text_value_or_404(db, project_id, data.dataset_value_id)

    note = Note(
        conversation_id=None,
        dataset_value_id=data.dataset_value_id,
        content=data.content,
        sequence_number=0,
    )
    db.add(note)
    db.commit()
    db.refresh(note)

    return NoteResponse.model_validate(note)


# ── 9. GET /notes ────────────────────────────────────────────────────────────

@router.get("/notes", response_model=list[NoteResponse])
async def list_text_notes(
    project_id: int,
    dataset_value_id: int | None = Query(None),
    column_ids: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)

    if dataset_value_id is not None:
        # Single-text mode (original behavior)
        _get_text_value_or_404(db, project_id, dataset_value_id)
        notes = (
            db.query(Note)
            .filter(
                Note.dataset_value_id == dataset_value_id,
                Note.is_archived == False,
            )
            .order_by(Note.id)
            .all()
        )
    elif column_ids is not None:
        # Column-scoped mode: return all notes for texts in the given columns
        col_id_list = [int(c) for c in column_ids.split(",") if c.strip()]
        if not col_id_list:
            return []
        notes = (
            db.query(Note)
            .join(DatasetValue, Note.dataset_value_id == DatasetValue.id)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.id.in_(col_id_list),
                Note.is_archived == False,
            )
            .order_by(Note.id.desc())
            .all()
        )
    else:
        raise HTTPException(status_code=400, detail="Either dataset_value_id or column_ids is required")

    return [NoteResponse.model_validate(n) for n in notes]


# ── 10. PATCH/DELETE /notes/{note_id} ────────────────────────────────────────

@router.patch("/notes/{note_id}", response_model=NoteResponse)
async def update_text_note(
    project_id: int,
    note_id: int,
    data: TextNoteUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note or not note.dataset_value_id:
        raise HTTPException(status_code=404, detail="Text note not found")

    # Verify ownership: DatasetValue → DatasetColumn → Dataset → Project
    _get_text_value_or_404(db, project_id, note.dataset_value_id)

    if data.content is not None:
        note.content = data.content

    db.commit()
    db.refresh(note)
    return NoteResponse.model_validate(note)


@router.delete("/notes/{note_id}")
async def delete_text_note(
    project_id: int,
    note_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    note = db.query(Note).filter(Note.id == note_id).first()
    if not note or not note.dataset_value_id:
        raise HTTPException(status_code=404, detail="Text note not found")

    _get_text_value_or_404(db, project_id, note.dataset_value_id)

    note.is_archived = True
    db.commit()

    return {"status": "ok", "note_id": note_id}


# ── 11. GET/PATCH /config ───────────────────────────────────────────────────

@router.get("/config", response_model=TextCodingConfigResponse)
async def get_config_endpoint(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    config = _get_config(db, project_id)
    db.commit()

    return TextCodingConfigResponse(
        view_mode=config.view_mode or "by_text",
        focal_column_ids=json.loads(config.focal_column_ids) if config.focal_column_ids else [],
        dataset_filter_ids=json.loads(config.dataset_filter_ids) if config.dataset_filter_ids else None,
        random_seed=config.random_seed,
        context_visibility=json.loads(config.context_visibility) if config.context_visibility else {},
        hide_empty=bool(config.hide_empty),
        starred_value_ids=json.loads(config.starred_value_ids) if config.starred_value_ids else [],
        treat_as_empty=_get_treat_as_empty(config),
    )


@router.patch("/config", response_model=TextCodingConfigResponse)
async def update_config(
    project_id: int,
    data: TextCodingConfigUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    config = _get_config(db, project_id)

    provided = data.model_fields_set
    if "view_mode" in provided:
        config.view_mode = data.view_mode
    if "focal_column_ids" in provided:
        config.focal_column_ids = json.dumps(data.focal_column_ids) if data.focal_column_ids is not None else None
    if "dataset_filter_ids" in provided:
        config.dataset_filter_ids = json.dumps(data.dataset_filter_ids) if data.dataset_filter_ids is not None else None
    if "random_seed" in provided:
        config.random_seed = data.random_seed
    if "context_visibility" in provided:
        config.context_visibility = json.dumps(data.context_visibility) if data.context_visibility is not None else None
    if "hide_empty" in provided:
        config.hide_empty = 1 if data.hide_empty else 0
    if "starred_value_ids" in provided:
        config.starred_value_ids = json.dumps(data.starred_value_ids) if data.starred_value_ids is not None else None
    if "treat_as_empty" in provided:
        config.treat_as_empty = json.dumps(data.treat_as_empty) if data.treat_as_empty is not None else None

    db.commit()
    db.refresh(config)

    return TextCodingConfigResponse(
        view_mode=config.view_mode or "by_text",
        focal_column_ids=json.loads(config.focal_column_ids) if config.focal_column_ids else [],
        dataset_filter_ids=json.loads(config.dataset_filter_ids) if config.dataset_filter_ids else None,
        random_seed=config.random_seed,
        context_visibility=json.loads(config.context_visibility) if config.context_visibility else {},
        hide_empty=bool(config.hide_empty),
        starred_value_ids=json.loads(config.starred_value_ids) if config.starred_value_ids else [],
        treat_as_empty=_get_treat_as_empty(config),
    )


# ── 12. GET /coding-progress ────────────────────────────────────────────────

@router.get("/coding-progress", response_model=CodingProgressResponse)
async def coding_progress(
    project_id: int,
    column_ids: str | None = Query(None, description="Comma-separated column IDs (all text columns if omitted)"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id, user.id)
    parsed_column_ids = parse_int_list(column_ids)

    config = _get_config(db, project_id)
    treat_as_empty = _get_treat_as_empty(config)

    # Get all text columns
    col_query = (
        db.query(DatasetColumn.id, DatasetColumn.column_name, DatasetColumn.column_text)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
    )
    if parsed_column_ids:
        col_query = col_query.filter(DatasetColumn.id.in_(parsed_column_ids))
    cols = col_query.all()
    col_ids = [c[0] for c in cols]

    if not col_ids:
        return CodingProgressResponse(
            by_column=[],
            overall_texts={"coded": 0, "total": 0},
            overall_records={"coded": 0, "total": 0},
        )

    # Get non-empty values per column
    values = (
        db.query(DatasetValue.id, DatasetValue.column_id, DatasetValue.value_text, DatasetValue.row_id)
        .filter(DatasetValue.column_id.in_(col_ids))
        .all()
    )

    # Get coded value IDs
    coded_value_ids = set()
    value_ids = [v[0] for v in values]
    if value_ids:
        coded = (
            db.query(func.distinct(CodeApplication.dataset_value_id))
            .filter(CodeApplication.dataset_value_id.in_(value_ids))
            .all()
        )
        coded_value_ids = {dv_id for (dv_id,) in coded}

    # Build per-column stats
    by_column = []
    overall_total = 0
    overall_coded = 0
    all_record_ids = set()
    coded_record_ids = set()

    col_map = {c[0]: (c[1] or c[2][:50]) for c in cols}

    for col_id in col_ids:
        col_values = [v for v in values if v[1] == col_id]
        non_empty = [v for v in col_values if not _is_empty(v[2], treat_as_empty)]
        coded = [v for v in non_empty if v[0] in coded_value_ids]

        by_column.append(ColumnProgressResponse(
            column_id=col_id,
            column_name=col_map.get(col_id),
            coded=len(coded),
            total=len(non_empty),
        ))
        overall_total += len(non_empty)
        overall_coded += len(coded)

        for v in non_empty:
            all_record_ids.add(v[3])
            if v[0] in coded_value_ids:
                coded_record_ids.add(v[3])

    db.commit()

    return CodingProgressResponse(
        by_column=by_column,
        overall_texts={"coded": overall_coded, "total": overall_total},
        overall_records={"coded": len(coded_record_ids), "total": len(all_record_ids)},
    )


# ── 14. GET /export ──────────────────────────────────────────────────────────

@router.get("/export")
async def export_coded_texts(
    project_id: int,
    coded_only: bool = Query(False),
    column_ids: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_project_or_404(db, project_id, user.id)
    parsed_column_ids = parse_int_list(column_ids)

    config = _get_config(db, project_id)
    treat_as_empty = _get_treat_as_empty(config)

    # Excerpt-based quoting (migrated from TextCodingConfig JSON)
    quoted_set = set(
        dv_id for (dv_id,) in
        db.query(Excerpt.dataset_value_id)
        .filter(Excerpt.project_id == project_id, Excerpt.dataset_value_id.isnot(None))
        .all()
    )

    # Get text values
    query = (
        db.query(
            DatasetValue.id,
            DatasetValue.value_text,
            DatasetRow.row_identifier,
            DatasetColumn.column_name,
            DatasetColumn.column_text,
            Dataset.name.label("ds_name"),
        )
        .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
    )

    if parsed_column_ids:
        query = query.filter(DatasetColumn.id.in_(parsed_column_ids))

    query = query.order_by(Dataset.name, DatasetColumn.sequence_order, DatasetRow.row_identifier)
    rows = query.all()

    # Get all code applications
    value_ids = [r[0] for r in rows]
    code_apps = defaultdict(list)
    if value_ids:
        cas = (
            db.query(CodeApplication.dataset_value_id, Code.name)
            .join(Code, CodeApplication.code_id == Code.id)
            .filter(CodeApplication.dataset_value_id.in_(value_ids))
            .all()
        )
        for dv_id, code_name in cas:
            code_apps[dv_id].append(code_name)

    # Get notes
    note_map = defaultdict(list)
    if value_ids:
        notes = (
            db.query(Note.dataset_value_id, Note.content)
            .filter(
                Note.dataset_value_id.in_(value_ids),
                Note.is_archived == False,
            )
            .order_by(Note.id)
            .all()
        )
        for dv_id, content in notes:
            note_map[dv_id].append(content)

    output = io.StringIO()
    writer = csv.writer(output)

    headers = [
        "Record ID", "Dataset", "Column Name", "Text",
        "Applied Codes", "Notes", "Word Count", "Is Quoted",
    ]
    if config.random_seed is not None:
        headers.append("Randomization Seed")
    writer.writerow(headers)

    for r in rows:
        dv_id = r[0]
        value_text = r.value_text
        is_empty = _is_empty(value_text, treat_as_empty)

        codes = code_apps.get(dv_id, [])
        if coded_only and not codes:
            continue

        if is_empty:
            continue

        word_count = len(value_text.split()) if value_text and value_text.strip() else 0
        col_name = r.column_name or (r.column_text[:50] if r.column_text else "")
        notes_text = "; ".join(note_map.get(dv_id, []))
        is_quoted = dv_id in quoted_set

        row_data = [
            csv_safe(r.row_identifier or ""),
            csv_safe(r.ds_name),
            csv_safe(col_name),
            csv_safe(value_text or ""),
            csv_safe("; ".join(codes)),
            csv_safe(notes_text),
            word_count,
            "Yes" if is_quoted else "No",
        ]
        if config.random_seed is not None:
            row_data.append(config.random_seed)
        writer.writerow(row_data)

    output.seek(0)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    filename = sanitize_csv_filename(f"{project.name}_coded_texts_{now.strftime('%Y%m%d')}.csv")

    db.commit()

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
