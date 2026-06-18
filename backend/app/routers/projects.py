import logging
import shutil

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from ..config import get_documents_dir, get_media_dir
from ..database import get_db
from ..models.user import User
from ..models.project import Project
from ..models.conversation import Conversation
from ..models.segment import Segment
from ..models.code import Code
from ..models.speaker import Speaker
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from ..models.participant import Participant
from ..models.memo import Memo
from ..models.materials import MaterialCollection, Material
from ..models.statistical_test import StatisticalTest
from ..models.code_category import CodeCategory
from ..models.note import Note
from ..models.document import Document
from ..models.canvas import Canvas
from ..schemas.project import (
    ProjectCreate,
    ProjectUpdate,
    ProjectResponse,
    ProjectListResponse,
    ProjectSummaryResponse,
    RecentConversation,
    RecentDataset,
    RecentDocument,
)
from .helpers import visible_segment_filter, _get_project_or_404
from ..schemas.segment import SpeakerResponse, SpeakerColorUpdateRequest
from ..auth import get_current_user
from ..services.audit import log_action
from ..services.coding_counts import (
    coded_segment_counts,
    coded_segment_count_for_project,
    participant_segment_counts,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects", tags=["projects"])


def project_to_response(project: Project, db: Session) -> ProjectResponse:
    """Convert a Project model to response with counts."""
    conversation_count = db.query(func.count(Conversation.id)).filter(
        Conversation.project_id == project.id
    ).scalar() or 0

    code_count = db.query(func.count(Code.id)).filter(
        Code.project_id == project.id,
        Code.is_active == True
    ).scalar() or 0

    dataset_count = db.query(func.count(Dataset.id)).filter(
        Dataset.project_id == project.id
    ).scalar() or 0

    participant_count = db.query(func.count(Participant.id)).filter(
        Participant.project_id == project.id
    ).scalar() or 0

    document_count = db.query(func.count(Document.id)).filter(
        Document.project_id == project.id
    ).scalar() or 0

    return ProjectResponse(
        id=project.id,
        user_id=project.user_id,
        name=project.name,
        description=project.description,
        status=project.status,
        created_at=project.created_at,
        updated_at=project.updated_at,
        conversation_count=conversation_count,
        code_count=code_count,
        dataset_count=dataset_count,
        document_count=document_count,
        participant_count=participant_count,
        category_level_names=project.category_level_names,
    )


@router.get("", response_model=ProjectListResponse)
async def list_projects(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List all projects."""
    projects = db.query(Project).filter(Project.user_id == user.id).order_by(Project.updated_at.desc()).all()

    if not projects:
        return ProjectListResponse(projects=[], total=0)

    # B1: Batch count queries instead of N+1
    project_ids = [p.id for p in projects]

    conv_counts = dict(
        db.query(Conversation.project_id, func.count(Conversation.id))
        .filter(Conversation.project_id.in_(project_ids))
        .group_by(Conversation.project_id)
        .all()
    )

    code_counts = dict(
        db.query(Code.project_id, func.count(Code.id))
        .filter(Code.project_id.in_(project_ids), Code.is_active == True)
        .group_by(Code.project_id)
        .all()
    )

    dataset_counts = dict(
        db.query(Dataset.project_id, func.count(Dataset.id))
        .filter(Dataset.project_id.in_(project_ids))
        .group_by(Dataset.project_id)
        .all()
    )

    participant_counts = dict(
        db.query(Participant.project_id, func.count(Participant.id))
        .filter(Participant.project_id.in_(project_ids))
        .group_by(Participant.project_id)
        .all()
    )

    document_counts = dict(
        db.query(Document.project_id, func.count(Document.id))
        .filter(Document.project_id.in_(project_ids))
        .group_by(Document.project_id)
        .all()
    )

    return ProjectListResponse(
        projects=[
            ProjectResponse(
                id=p.id,
                user_id=p.user_id,
                name=p.name,
                description=p.description,
                status=p.status,
                created_at=p.created_at,
                updated_at=p.updated_at,
                conversation_count=conv_counts.get(p.id, 0),
                code_count=code_counts.get(p.id, 0),
                dataset_count=dataset_counts.get(p.id, 0),
                document_count=document_counts.get(p.id, 0),
                participant_count=participant_counts.get(p.id, 0),
                category_level_names=p.category_level_names,
            )
            for p in projects
        ],
        total=len(projects)
    )


@router.post("", response_model=ProjectResponse)
async def create_project(
    data: ProjectCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create a new project."""
    project = Project(
        name=data.name,
        description=data.description,
        user_id=user.id,
    )
    db.add(project)
    db.flush()

    # Auto-create default material collection
    collection = MaterialCollection(project_id=project.id, name="Materials", display_order=0)
    db.add(collection)

    log_action(
        db,
        action="created",
        entity_type="project",
        entity_id=project.id,
        user_id=user.id,
        project_id=project.id,
        details={"name": project.name}
    )
    db.commit()

    return project_to_response(project, db)


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get a project by ID."""
    project = _get_project_or_404(db, project_id, user.id)
    return project_to_response(project, db)


@router.get("/{project_id}/summary", response_model=ProjectSummaryResponse)
async def get_project_summary(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get summary counts for a project."""
    _get_project_or_404(db, project_id, user.id)

    conversations = db.query(func.count(Conversation.id)).filter(
        Conversation.project_id == project_id
    ).scalar() or 0

    datasets = db.query(func.count(Dataset.id)).filter(
        Dataset.project_id == project_id
    ).scalar() or 0

    participants = db.query(func.count(Participant.id)).filter(
        Participant.project_id == project_id
    ).scalar() or 0

    codes = db.query(func.count(Code.id)).filter(
        Code.project_id == project_id,
        Code.is_active == True
    ).scalar() or 0

    categories = db.query(func.count(CodeCategory.id)).filter(
        CodeCategory.project_id == project_id
    ).scalar() or 0

    # Coded PARTICIPANT segments (#351/#352) via the shared source of truth
    # (invariant J-A). Conversation segments only; documents are counted
    # separately (coded_doc_segments below) and summed into the response.
    coded_segments = coded_segment_count_for_project(
        db, project_id, source="conversation"
    )

    materials_count = db.query(func.count(Material.id)).join(
        MaterialCollection, Material.collection_id == MaterialCollection.id
    ).filter(
        MaterialCollection.project_id == project_id
    ).scalar() or 0

    statistical_tests = db.query(func.count(StatisticalTest.id)).filter(
        StatisticalTest.project_id == project_id
    ).scalar() or 0

    memos = db.query(func.count(Memo.id)).filter(
        Memo.project_id == project_id
    ).scalar() or 0

    # Dataset-level aggregates via join
    dataset_ids_subq = db.query(Dataset.id).filter(
        Dataset.project_id == project_id
    ).subquery()

    total_records = db.query(func.count(DatasetRow.id)).filter(
        DatasetRow.dataset_id.in_(db.query(dataset_ids_subq))
    ).scalar() or 0

    total_variables = db.query(func.count(DatasetColumn.id)).filter(
        DatasetColumn.dataset_id.in_(db.query(dataset_ids_subq)),
        DatasetColumn.column_type.notin_([ColumnType.DEMOGRAPHIC.value, ColumnType.SKIP.value])
    ).scalar() or 0

    open_ended_columns = db.query(func.count(DatasetColumn.id)).filter(
        DatasetColumn.dataset_id.in_(db.query(dataset_ids_subq)),
        DatasetColumn.column_type.in_([ColumnType.OPEN_TEXT.value])
    ).scalar() or 0

    # Notes count: conversation notes + comment notes
    conv_notes_count = db.query(func.count(Note.id)).join(
        Conversation, Note.conversation_id == Conversation.id
    ).filter(
        Conversation.project_id == project_id,
        Note.is_archived == False
    ).scalar() or 0

    comment_notes_count = db.query(func.count(Note.id)).join(
        DatasetValue, Note.dataset_value_id == DatasetValue.id
    ).join(
        DatasetColumn, DatasetValue.column_id == DatasetColumn.id
    ).join(
        Dataset, DatasetColumn.dataset_id == Dataset.id
    ).filter(
        Dataset.project_id == project_id,
        Note.is_archived == False
    ).scalar() or 0

    # Recent conversations (4 most recently updated)
    recent_convs = db.query(Conversation).filter(
        Conversation.project_id == project_id
    ).order_by(Conversation.updated_at.desc()).limit(4).all()

    recent_conversations = []
    if recent_convs:
        conv_ids = [c.id for c in recent_convs]
        # Recent-conversations cards: participant denominator + coded numerator
        # via the shared source of truth (invariant J-A), so they match the
        # conversations-list and overview gauges (#351/#352 + universal exclusion).
        seg_counts = participant_segment_counts(db, Segment.conversation_id, conv_ids)
        coded_counts = coded_segment_counts(
            db, Segment.conversation_id, conv_ids, participant_only=True
        )
        recent_conversations = [
            RecentConversation(
                id=c.id,
                name=c.name,
                updated_at=c.updated_at,
                segment_count=seg_counts.get(c.id, 0),
                coded_segment_count=coded_counts.get(c.id, 0),
            )
            for c in recent_convs
        ]

    # Recent datasets (4 most recently created, matching conversations/documents)
    recent_ds = db.query(Dataset).filter(
        Dataset.project_id == project_id
    ).order_by(Dataset.created_at.desc()).limit(4).all()

    recent_datasets = []
    if recent_ds:
        ds_ids = [d.id for d in recent_ds]
        row_counts = dict(
            db.query(DatasetRow.dataset_id, func.count(DatasetRow.id))
            .filter(DatasetRow.dataset_id.in_(ds_ids))
            .group_by(DatasetRow.dataset_id)
            .all()
        )
        col_counts = dict(
            db.query(DatasetColumn.dataset_id, func.count(DatasetColumn.id))
            .filter(DatasetColumn.dataset_id.in_(ds_ids))
            .group_by(DatasetColumn.dataset_id)
            .all()
        )
        recent_datasets = [
            RecentDataset(
                id=d.id,
                name=d.name,
                created_at=d.created_at,
                row_count=row_counts.get(d.id, 0),
                column_count=col_counts.get(d.id, 0),
            )
            for d in recent_ds
        ]

    # Document counts
    document_count = db.query(func.count(Document.id)).filter(
        Document.project_id == project_id
    ).scalar() or 0

    document_segments = db.query(func.count(Segment.id)).join(
        Document, Segment.document_id == Document.id
    ).filter(
        Document.project_id == project_id,
        *visible_segment_filter(),
    ).scalar() or 0

    # Recent documents (4 most recently updated)
    recent_docs = db.query(Document).filter(
        Document.project_id == project_id
    ).order_by(Document.updated_at.desc()).limit(4).all()

    recent_documents = []
    if recent_docs:
        rd_ids = [d.id for d in recent_docs]
        doc_seg_counts = dict(
            db.query(Segment.document_id, func.count(Segment.id))
            .filter(
                Segment.document_id.in_(rd_ids),
                *visible_segment_filter(),
            )
            .group_by(Segment.document_id)
            .all()
        )
        # Coded counts via the shared source of truth (invariant J-A). Documents
        # have no speaker (participant_only=False); the universal-code exclusion
        # (#398) now applies here, matching the conversation surfaces.
        doc_coded_counts = coded_segment_counts(
            db, Segment.document_id, rd_ids, participant_only=False
        )
        recent_documents = [
            RecentDocument(
                id=d.id,
                name=d.name,
                updated_at=d.updated_at,
                segment_count=doc_seg_counts.get(d.id, 0),
                coded_segment_count=doc_coded_counts.get(d.id, 0),
            )
            for d in recent_docs
        ]

    # Document notes count
    doc_notes_count = db.query(func.count(Note.id)).join(
        Document, Note.document_id == Document.id
    ).filter(
        Document.project_id == project_id,
        Note.is_archived == False,
    ).scalar() or 0

    notes_count = conv_notes_count + comment_notes_count + doc_notes_count

    canvas_count = db.query(func.count(Canvas.id)).filter(
        Canvas.project_id == project_id
    ).scalar() or 0

    # Coded segments: also count document segments (invariant J-A; #398 applies
    # the universal-code exclusion here too).
    coded_doc_segments = coded_segment_count_for_project(
        db, project_id, source="document"
    )

    return ProjectSummaryResponse(
        conversations=conversations,
        datasets=datasets,
        documents=document_count,
        participants=participants,
        codes=codes,
        categories=categories,
        coded_segments=coded_segments + coded_doc_segments,
        document_segments=document_segments,
        materials=materials_count,
        statistical_tests=statistical_tests,
        memos=memos,
        total_records=total_records,
        total_variables=total_variables,
        open_ended_columns=open_ended_columns,
        notes_count=notes_count,
        canvas_count=canvas_count,
        recent_conversations=recent_conversations,
        recent_datasets=recent_datasets,
        recent_documents=recent_documents,
    )


@router.patch("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: int,
    data: ProjectUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update a project."""
    project = _get_project_or_404(db, project_id, user.id)

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(project, field, value)

    log_action(
        db,
        action="updated",
        entity_type="project",
        entity_id=project.id,
        user_id=user.id,
        project_id=project.id,
        details=update_data
    )
    db.commit()
    db.refresh(project)

    return project_to_response(project, db)


@router.delete("/{project_id}")
async def delete_project(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Delete a project and all associated data."""
    project = _get_project_or_404(db, project_id, user.id)

    project_name = project.name

    log_action(
        db,
        action="deleted",
        entity_type="project",
        entity_id=project.id,
        user_id=user.id,
        details={"name": project_name}
    )

    db.delete(project)
    db.commit()

    # Clean up document files on disk
    project_docs_dir = get_documents_dir() / str(project_id)
    try:
        if project_docs_dir.is_dir():
            shutil.rmtree(project_docs_dir)
    except Exception:
        logger.warning("Failed to clean up project document files at %s", project_docs_dir)

    # Clean up media files on disk
    project_media_dir = get_media_dir() / str(project_id)
    try:
        if project_media_dir.is_dir():
            shutil.rmtree(project_media_dir)
    except Exception:
        logger.warning("Failed to clean up project media files at %s", project_media_dir)

    return {"status": "ok", "deleted_id": project_id}


@router.get("/{project_id}/speakers", response_model=list[SpeakerResponse])
async def list_speakers(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List all speakers for a project."""
    _get_project_or_404(db, project_id, user.id)

    speakers = db.query(Speaker).filter(
        Speaker.project_id == project_id
    ).order_by(Speaker.name).all()

    return [
        SpeakerResponse(
            id=s.id,
            name=s.name,
            is_facilitator=bool(s.is_facilitator),
            color_index=s.color_index or 0,
            color=s.color,
        )
        for s in speakers
    ]


@router.patch("/{project_id}/speakers/{speaker_id}", response_model=SpeakerResponse)
async def update_speaker_color(
    project_id: int,
    speaker_id: int,
    data: SpeakerColorUpdateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update a speaker's custom color."""
    _get_project_or_404(db, project_id, user.id)
    speaker = db.query(Speaker).filter(
        Speaker.id == speaker_id,
        Speaker.project_id == project_id,
    ).first()
    if not speaker:
        raise HTTPException(status_code=404, detail="Speaker not found")

    speaker.color = data.color
    db.commit()
    db.refresh(speaker)

    return SpeakerResponse(
        id=speaker.id,
        name=speaker.name,
        is_facilitator=bool(speaker.is_facilitator),
        color_index=speaker.color_index or 0,
        color=speaker.color,
    )
