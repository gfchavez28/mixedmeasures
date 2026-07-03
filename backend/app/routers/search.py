from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func

from ..database import get_db
from ..models.user import User
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.segment import Segment
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.note import Note
from ..models.memo import Memo
from ..models.code_category import CodeCategory
from ..models.materials import Material
from ..models.excerpt import Excerpt
from ..services.coding_layers import (
    code_usage_count_expr,
    non_consensus_filter,
    visible_target_filter,
)
from ..schemas.search import (
    SearchResponse,
    SegmentSearchResult,
    SegmentSearchResults,
    CodeSearchResult,
    CodeSearchResults,
    ConversationSearchResult,
    ConversationSearchResults,
    NoteSearchResult,
    NoteSearchResults,
    MemoSearchResult,
    MemoSearchResults,
    DocumentSearchResult,
    DocumentSearchResults,
    TextSearchResult,
    TextSearchResults,
    CanvasSearchResult,
    CanvasSearchResults,
)
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.canvas import Canvas, CanvasTheme
from .helpers import _get_project_or_404, TEXT_TYPES
from ..auth import get_current_user

router = APIRouter(tags=["search"])


@router.get("/api/projects/{project_id}/search", response_model=SearchResponse)
async def search_study(
    project_id: int,
    q: str = Query(..., min_length=2, description="Search query (min 2 characters)"),
    types: str = Query("segments,codes", description="Comma-separated entity types to search"),
    limit: int = Query(5, ge=1, le=50, description="Max results per type"),
    full_type: str | None = Query(None, description="If set, return all results for this type only"),
    quoted: bool | None = Query(None, description="If true, only return quoted (excerpted) segments"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Search across multiple entity types within a project.

    Searches: segments (text), codes (name, description), conversations (name, subject_id, summary),
    notes (content), memos (title, content).

    Returns top `limit` results per type, with total counts for "show all" expansion.
    Use `full_type` to get all results for a single type.
    """
    # Verify project exists and ownership
    _get_project_or_404(db, project_id, user.id)

    # Parse requested types
    requested_types = set(t.strip().lower() for t in types.split(","))
    valid_types = {"segments", "codes", "conversations", "notes", "memos", "documents", "text", "canvases"}
    requested_types = requested_types & valid_types

    # If full_type is specified, only search that type
    if full_type:
        full_type = full_type.strip().lower()
        if full_type not in valid_types:
            raise HTTPException(status_code=400, detail=f"Invalid type: {full_type}")
        requested_types = {full_type}
        limit = 500  # Cap for full type expansion

    search_pattern = f"%{q}%"
    response = SearchResponse(query=q)

    # Get conversation IDs for this project (needed for segments, notes)
    conversation_ids = [c.id for c in db.query(Conversation.id).filter(Conversation.project_id == project_id).all()]

    # Search segments (conversations + documents)
    if "segments" in requested_types:
        all_segment_items = []

        # Conversation segments
        if conversation_ids:
            segment_query = (
                db.query(Segment)
                .options(joinedload(Segment.conversation), joinedload(Segment.speaker))
                .filter(
                    Segment.conversation_id.in_(conversation_ids),
                    Segment.merged_into_id.is_(None),
                    Segment.split_into_id.is_(None),
                    Segment.text.ilike(search_pattern)
                )
            )

            if quoted:
                quoted_seg_subq = (
                    db.query(Excerpt.segment_id)
                    .filter(
                        Excerpt.project_id == project_id,
                        Excerpt.segment_id.isnot(None),
                        Excerpt.start_offset.is_(None),
                    )
                )
                segment_query = segment_query.filter(Segment.id.in_(quoted_seg_subq))

            segment_query = segment_query.order_by(
                Segment.conversation_id,
                Segment.sequence_order
            )

            conv_segments = segment_query.limit(limit).all()

            seg_ids = [s.id for s in conv_segments]
            quoted_seg_ids: set[int] = set()
            if seg_ids:
                quoted_seg_ids = set(
                    eid for (eid,) in db.query(Excerpt.segment_id).filter(
                        Excerpt.segment_id.in_(seg_ids),
                        Excerpt.start_offset.is_(None),
                    ).all()
                )

            for s in conv_segments:
                all_segment_items.append(
                    SegmentSearchResult(
                        id=s.id,
                        conversation_id=s.conversation_id,
                        conversation_name=s.conversation.name if s.conversation else "Unknown",
                        speaker_name=s.speaker.name if s.speaker else None,
                        is_facilitator=s.speaker.is_facilitator if s.speaker else False,
                        start_time=s.start_time,
                        text=s.text,
                        sequence_order=s.sequence_order,
                        is_quoted=s.id in quoted_seg_ids
                    )
                )

        # Document segments
        document_ids = [d.id for d in db.query(Document.id).filter(Document.project_id == project_id).all()]
        if document_ids:
            doc_seg_query = (
                db.query(Segment)
                .options(joinedload(Segment.document))
                .filter(
                    Segment.document_id.in_(document_ids),
                    Segment.merged_into_id.is_(None),
                    Segment.split_into_id.is_(None),
                    Segment.text.ilike(search_pattern)
                )
            )

            if quoted:
                quoted_seg_subq = (
                    db.query(Excerpt.segment_id)
                    .filter(
                        Excerpt.project_id == project_id,
                        Excerpt.segment_id.isnot(None),
                        Excerpt.start_offset.is_(None),
                    )
                )
                doc_seg_query = doc_seg_query.filter(Segment.id.in_(quoted_seg_subq))

            doc_seg_query = doc_seg_query.order_by(
                Segment.document_id,
                Segment.sequence_order
            )

            doc_segments = doc_seg_query.limit(limit).all()

            doc_seg_ids = [s.id for s in doc_segments]
            doc_quoted_seg_ids: set[int] = set()
            if doc_seg_ids:
                doc_quoted_seg_ids = set(
                    eid for (eid,) in db.query(Excerpt.segment_id).filter(
                        Excerpt.segment_id.in_(doc_seg_ids),
                        Excerpt.start_offset.is_(None),
                    ).all()
                )

            for s in doc_segments:
                all_segment_items.append(
                    SegmentSearchResult(
                        id=s.id,
                        conversation_id=s.document_id,
                        conversation_name=s.document.name if s.document else "Unknown",
                        speaker_name=None,
                        is_facilitator=False,
                        start_time=None,
                        text=s.text,
                        sequence_order=s.sequence_order,
                        is_quoted=s.id in doc_quoted_seg_ids,
                        source_type="document",
                    )
                )

        total_segments = len(all_segment_items)
        response.segments = SegmentSearchResults(
            count=total_segments,
            items=all_segment_items[:limit],
        )

    # Search codes
    if "codes" in requested_types:
        code_query = (
            db.query(Code)
            .filter(
                Code.project_id == project_id,
                Code.is_active == True,
                (Code.name.ilike(search_pattern) | Code.description.ilike(search_pattern))
            )
            .order_by(Code.numeric_id)
        )

        total_codes = code_query.count()
        codes = code_query.limit(limit).all()

        # Get usage counts
        usage_counts = {}
        if codes:
            code_ids = [c.id for c in codes]
            counts = (
                db.query(CodeApplication.code_id, code_usage_count_expr())
                .outerjoin(Segment, CodeApplication.segment_id == Segment.id)
                .filter(
                    CodeApplication.code_id.in_(code_ids),
                    non_consensus_filter(),
                    visible_target_filter(),  # #500
                )
                .group_by(CodeApplication.code_id)
                .all()
            )
            usage_counts = dict(counts)

        response.codes = CodeSearchResults(
            count=total_codes,
            items=[
                CodeSearchResult(
                    id=c.id,
                    numeric_id=c.numeric_id,
                    name=c.name,
                    description=c.description,
                    usage_count=usage_counts.get(c.id, 0),
                    is_active=c.is_active
                )
                for c in codes
            ]
        )

    # Search conversations
    if "conversations" in requested_types:
        conversation_query = (
            db.query(Conversation)
            .filter(
                Conversation.project_id == project_id,
                (
                    Conversation.name.ilike(search_pattern) |
                    Conversation.subject_id.ilike(search_pattern) |
                    Conversation.summary.ilike(search_pattern)
                )
            )
            .order_by(Conversation.name)
        )

        total_conversations = conversation_query.count()
        conversations = conversation_query.limit(limit).all()

        # Get segment counts
        segment_counts = {}
        if conversations:
            conv_ids = [c.id for c in conversations]
            counts = (
                db.query(Segment.conversation_id, func.count(Segment.id))
                .filter(
                    Segment.conversation_id.in_(conv_ids),
                    Segment.merged_into_id.is_(None),
                    Segment.split_into_id.is_(None)
                )
                .group_by(Segment.conversation_id)
                .all()
            )
            segment_counts = dict(counts)

        response.conversations = ConversationSearchResults(
            count=total_conversations,
            items=[
                ConversationSearchResult(
                    id=c.id,
                    name=c.name,
                    subject_id=c.subject_id,
                    conversation_date=c.conversation_date,
                    status=c.status.value if hasattr(c.status, 'value') else str(c.status),
                    summary=c.summary,
                    segment_count=segment_counts.get(c.id, 0)
                )
                for c in conversations
            ]
        )

    # Search notes (conversation + document)
    if "notes" in requested_types:
        note_items = []

        # Conversation notes
        if conversation_ids:
            conv_note_query = (
                db.query(Note)
                .options(joinedload(Note.conversation), joinedload(Note.segment))
                .filter(
                    Note.conversation_id.in_(conversation_ids),
                    Note.is_archived == False,
                    Note.content.ilike(search_pattern)
                )
                .order_by(Note.conversation_id, Note.sequence_number)
            )
            conv_notes = conv_note_query.limit(limit).all()

            for n in conv_notes:
                note_items.append(
                    NoteSearchResult(
                        id=n.id,
                        conversation_id=n.conversation_id,
                        conversation_name=n.conversation.name if n.conversation else "Unknown",
                        segment_id=n.segment_id,
                        segment_text_preview=(
                            n.segment.text[:100] + "..." if n.segment and len(n.segment.text) > 100
                            else n.segment.text if n.segment else None
                        ),
                        content=n.content,
                        sequence_number=n.sequence_number,
                        source_type="conversation",
                    )
                )

        # Document notes
        doc_note_query = (
            db.query(Note)
            .options(joinedload(Note.document), joinedload(Note.segment))
            .filter(
                Note.document_id.isnot(None),
                Note.is_archived == False,
                Note.content.ilike(search_pattern)
            )
            .join(Document, Note.document_id == Document.id)
            .filter(Document.project_id == project_id)
            .order_by(Note.document_id, Note.id)
        )
        doc_notes = doc_note_query.limit(limit).all()

        for n in doc_notes:
            note_items.append(
                NoteSearchResult(
                    id=n.id,
                    conversation_id=n.document_id,
                    conversation_name=n.document.name if n.document else "Unknown",
                    segment_id=n.segment_id,
                    segment_text_preview=(
                        n.segment.text[:100] + "..." if n.segment and len(n.segment.text) > 100
                        else n.segment.text if n.segment else None
                    ),
                    content=n.content,
                    sequence_number=n.sequence_number,
                    source_type="document",
                )
            )

        response.notes = NoteSearchResults(
            count=len(note_items),
            items=note_items[:limit],
        )

    # Search memos
    if "memos" in requested_types:
        memo_query = (
            db.query(Memo)
            .filter(
                Memo.project_id == project_id,
                Memo.is_archived == False,
                (Memo.title.ilike(search_pattern) | Memo.content.ilike(search_pattern))
            )
            .order_by(Memo.updated_at.desc())
        )

        total_memos = memo_query.count()
        memos = memo_query.limit(limit).all()

        # Batch resolve entity names (avoid N+1)
        code_ids = [m.entity_id for m in memos if m.entity_type == "code"]
        conv_ids = [m.entity_id for m in memos if m.entity_type == "conversation"]
        cat_ids = [m.entity_id for m in memos if m.entity_type == "code_category"]
        analysis_ids = [m.entity_id for m in memos if m.entity_type == "analysis"]
        code_names = {}
        conv_names = {}
        cat_names = {}
        analysis_names = {}
        if code_ids:
            code_names = dict(db.query(Code.id, Code.name).filter(Code.id.in_(code_ids)).all())
        if conv_ids:
            conv_names = dict(db.query(Conversation.id, Conversation.name).filter(Conversation.id.in_(conv_ids)).all())
        if cat_ids:
            cat_names = dict(db.query(CodeCategory.id, CodeCategory.name).filter(CodeCategory.id.in_(cat_ids)).all())
        if analysis_ids:
            analysis_names = dict(
                db.query(Material.id, Material.auto_name)
                .filter(Material.id.in_(analysis_ids))
                .all()
            )

        memo_items = []
        for m in memos:
            entity_name = None
            if m.entity_type == "code":
                entity_name = code_names.get(m.entity_id)
            elif m.entity_type == "conversation":
                entity_name = conv_names.get(m.entity_id)
            elif m.entity_type == "code_category":
                entity_name = cat_names.get(m.entity_id)
            elif m.entity_type == "analysis":
                entity_name = analysis_names.get(m.entity_id)

            memo_items.append(
                MemoSearchResult(
                    id=m.id,
                    numeric_id=m.numeric_id,
                    entity_type=m.entity_type,
                    entity_id=m.entity_id,
                    entity_name=entity_name,
                    title=m.title,
                    content=m.content
                )
            )

        response.memos = MemoSearchResults(
            count=total_memos,
            items=memo_items
        )

    # Search documents (by name)
    if "documents" in requested_types:
        doc_query = (
            db.query(Document)
            .filter(
                Document.project_id == project_id,
                Document.name.ilike(search_pattern),
            )
            .order_by(Document.name)
        )

        total_docs = doc_query.count()
        docs = doc_query.limit(limit).all()

        # Get visible segment counts
        doc_seg_counts = {}
        if docs:
            doc_ids = [d.id for d in docs]
            counts = (
                db.query(Segment.document_id, func.count(Segment.id))
                .filter(
                    Segment.document_id.in_(doc_ids),
                    Segment.merged_into_id.is_(None),
                    Segment.split_into_id.is_(None),
                )
                .group_by(Segment.document_id)
                .all()
            )
            doc_seg_counts = dict(counts)

        response.documents = DocumentSearchResults(
            count=total_docs,
            items=[
                DocumentSearchResult(
                    id=d.id,
                    name=d.name,
                    segment_count=doc_seg_counts.get(d.id, 0),
                    source_format=d.source_format,
                )
                for d in docs
            ],
        )

    # Search comments (open-ended dataset values)
    if "text" in requested_types:
        text_query = (
            db.query(DatasetValue, DatasetColumn.column_name, DatasetColumn.id.label("col_id"), DatasetRow.row_identifier)
            .join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .join(DatasetRow, DatasetValue.row_id == DatasetRow.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.column_type.in_(TEXT_TYPES),
                DatasetValue.value_text.isnot(None),
                DatasetValue.value_text != "",
                DatasetValue.value_text.ilike(search_pattern),
            )
            .order_by(DatasetValue.id)
        )

        total_text = text_query.count()
        text_rows = text_query.limit(limit).all()

        # Batch lookup: quoted status and code counts
        dv_ids = [row[0].id for row in text_rows]
        quoted_dv_ids: set[int] = set()
        code_count_map: dict[int, int] = {}
        if dv_ids:
            quoted_dv_ids = set(
                eid for (eid,) in db.query(Excerpt.dataset_value_id).filter(
                    Excerpt.dataset_value_id.in_(dv_ids),
                ).all()
            )
            code_counts = (
                db.query(
                    CodeApplication.dataset_value_id,
                    func.count(func.distinct(CodeApplication.code_id)),
                )
                .filter(CodeApplication.dataset_value_id.in_(dv_ids), non_consensus_filter())
                .group_by(CodeApplication.dataset_value_id)
                .all()
            )
            code_count_map = dict(code_counts)

        response.text = TextSearchResults(
            count=total_text,
            items=[
                TextSearchResult(
                    id=dv.id,
                    value_text=dv.value_text or "",
                    column_name=col_name or "",
                    column_id=col_id,
                    row_identifier=resp_id,
                    is_quoted=dv.id in quoted_dv_ids,
                    applied_code_count=code_count_map.get(dv.id, 0),
                )
                for dv, col_name, col_id, resp_id in text_rows
            ],
        )

    # Search canvases (theme names/descriptions + theme content searchable_text)
    if "canvases" in requested_types:
        canvas_items: list[CanvasSearchResult] = []

        # Get canvas IDs for this project
        canvas_rows = db.query(Canvas.id, Canvas.name).filter(Canvas.project_id == project_id).all()
        canvas_name_map = {cid: cname for cid, cname in canvas_rows}
        canvas_ids = list(canvas_name_map.keys())

        if canvas_ids:
            seen_theme_ids: set[int] = set()

            # Theme name/description matches
            theme_query = (
                db.query(CanvasTheme)
                .filter(
                    CanvasTheme.canvas_id.in_(canvas_ids),
                    (CanvasTheme.name.ilike(search_pattern) | CanvasTheme.description.ilike(search_pattern))
                )
                .order_by(CanvasTheme.canvas_id, CanvasTheme.doc_order)
                .limit(limit)
            )
            for t in theme_query.all():
                match_text = t.name
                if t.description and search_pattern.strip('%').lower() in (t.description or '').lower():
                    match_text = t.description[:120]
                canvas_items.append(CanvasSearchResult(
                    id=t.canvas_id * 100000 + t.id,
                    canvas_id=t.canvas_id,
                    canvas_name=canvas_name_map.get(t.canvas_id, ""),
                    match_type="theme",
                    match_text=match_text,
                    theme_id=t.id,
                    theme_name=t.name,
                ))
                seen_theme_ids.add(t.id)

            # Theme content (searchable_text) matches — replaces block-level search
            content_query = (
                db.query(CanvasTheme)
                .filter(
                    CanvasTheme.canvas_id.in_(canvas_ids),
                    CanvasTheme.searchable_text.isnot(None),
                    CanvasTheme.searchable_text != "",
                    CanvasTheme.searchable_text.ilike(search_pattern),
                )
                .order_by(CanvasTheme.canvas_id, CanvasTheme.doc_order)
                .limit(limit)
            )
            for t in content_query.all():
                # Skip themes already matched on name/description
                if t.id in seen_theme_ids:
                    continue
                text = t.searchable_text or ""
                if len(text) > 120:
                    text = text[:120] + "..."
                canvas_items.append(CanvasSearchResult(
                    id=t.canvas_id * 100000 + t.id,
                    canvas_id=t.canvas_id,
                    canvas_name=canvas_name_map.get(t.canvas_id, ""),
                    match_type="theme_content",
                    match_text=text,
                    theme_id=t.id,
                    theme_name=t.name,
                ))

        total_canvases = len(canvas_items)
        response.canvases = CanvasSearchResults(
            count=total_canvases,
            items=canvas_items[:limit],
        )

    return response
