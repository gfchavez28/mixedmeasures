from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.user import User
from ..models.project import Project
from ..models.conversation import Conversation
from ..models.code import Code
from ..models.code_category import CodeCategory
from ..models.materials import MaterialCollection, Material
from ..models.memo import Memo
from ..models.dataset import Dataset, DatasetColumn, DatasetRow
from ..schemas.memo import (
    MemoCreate,
    MemoUpdate,
    MemoResponse,
    MemoListResponse
)
from ..auth import get_current_user
from ..services.audit import log_action
from .helpers import _get_project_or_404

router = APIRouter(tags=["memos"])


def memo_to_response(memo: Memo) -> MemoResponse:
    """Convert Memo model to response."""
    return MemoResponse(
        id=memo.id,
        project_id=memo.project_id,
        numeric_id=memo.numeric_id,
        entity_type=memo.entity_type,
        entity_id=memo.entity_id,
        title=memo.title,
        content=memo.content,
        is_archived=memo.is_archived,
        created_at=memo.created_at,
        updated_at=memo.updated_at
    )


@router.get("/api/projects/{project_id}/memos", response_model=MemoListResponse)
async def list_memos(
    project_id: int,
    entity_type: str | None = None,
    entity_id: int | None = None,
    include_archived: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """List memos for a project, optionally filtered by entity."""
    _get_project_or_404(db, project_id, user.id)

    query = db.query(Memo).filter(Memo.project_id == project_id)

    if not include_archived:
        query = query.filter(Memo.is_archived == False)

    if entity_type:
        query = query.filter(Memo.entity_type == entity_type)

    if entity_id is not None:
        query = query.filter(Memo.entity_id == entity_id)

    memos = query.order_by(Memo.updated_at.desc()).all()

    return MemoListResponse(
        memos=[memo_to_response(m) for m in memos],
        total=len(memos)
    )


@router.post("/api/projects/{project_id}/memos", response_model=MemoResponse)
async def create_memo(
    project_id: int,
    data: MemoCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create a new memo."""
    _get_project_or_404(db, project_id, user.id)

    # Validate that entity_id references a real entity in this project
    entity_models = {
        "project": (Project, Project.id == data.entity_id),
        "conversation": (Conversation, Conversation.id == data.entity_id, Conversation.project_id == project_id),
        "code": (Code, Code.id == data.entity_id, Code.project_id == project_id),
        "code_category": (CodeCategory, CodeCategory.id == data.entity_id, CodeCategory.project_id == project_id),
    }
    if data.entity_type == "project":
        if data.entity_id != project_id:
            raise HTTPException(status_code=400, detail="entity_id must match project_id for project memos")
    elif data.entity_type == "analysis":
        elem = db.query(Material).join(MaterialCollection).filter(
            Material.id == data.entity_id,
            MaterialCollection.project_id == project_id,
        ).first()
        if not elem:
            raise HTTPException(status_code=400, detail=f"analysis element {data.entity_id} not found in this project")
    elif data.entity_type == "dataset":
        ds = db.query(Dataset).filter(Dataset.id == data.entity_id, Dataset.project_id == project_id).first()
        if not ds:
            raise HTTPException(status_code=400, detail=f"dataset {data.entity_id} not found in this project")
    elif data.entity_type == "dataset_row":
        row = db.query(DatasetRow).join(Dataset).filter(
            DatasetRow.id == data.entity_id,
            Dataset.project_id == project_id,
        ).first()
        if not row:
            raise HTTPException(status_code=400, detail=f"dataset_row {data.entity_id} not found in this project")
    elif data.entity_type == "dataset_column":
        col = db.query(DatasetColumn).join(Dataset).filter(
            DatasetColumn.id == data.entity_id,
            Dataset.project_id == project_id,
        ).first()
        if not col:
            raise HTTPException(status_code=400, detail=f"dataset_column {data.entity_id} not found in this project")
    elif data.entity_type == "canvas":
        from ..models.canvas import Canvas
        cv = db.query(Canvas).filter(Canvas.id == data.entity_id, Canvas.project_id == project_id).first()
        if not cv:
            raise HTTPException(status_code=400, detail=f"canvas {data.entity_id} not found in this project")
    elif data.entity_type in entity_models:
        model_info = entity_models[data.entity_type]
        model_cls = model_info[0]
        filters = model_info[1:]
        exists = db.query(model_cls.id).filter(*filters).first()
        if not exists:
            raise HTTPException(status_code=400, detail=f"{data.entity_type} with id {data.entity_id} not found in this project")

    # Get next numeric_id for this project
    from sqlalchemy import func
    max_numeric_id = db.query(func.max(Memo.numeric_id)).filter(
        Memo.project_id == project_id
    ).scalar()
    next_numeric_id = (max_numeric_id or 0) + 1

    memo = Memo(
        project_id=project_id,
        numeric_id=next_numeric_id,
        entity_type=data.entity_type,
        entity_id=data.entity_id,
        title=data.title,
        content=data.content
    )
    db.add(memo)
    db.flush()

    log_action(
        db,
        action="created",
        entity_type="memo",
        entity_id=memo.id,
        user_id=user.id,
        project_id=project_id,
        details={
            "entity_type": memo.entity_type,
            "entity_id": memo.entity_id,
            "title": memo.title
        }
    )
    db.commit()

    return memo_to_response(memo)


@router.get("/api/projects/{project_id}/memos/{memo_id}", response_model=MemoResponse)
async def get_memo(
    project_id: int,
    memo_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get a single memo by ID."""
    _get_project_or_404(db, project_id, user.id)
    memo = db.query(Memo).filter(Memo.id == memo_id, Memo.project_id == project_id).first()
    if not memo:
        raise HTTPException(status_code=404, detail="Memo not found")

    return memo_to_response(memo)


@router.patch("/api/projects/{project_id}/memos/{memo_id}", response_model=MemoResponse)
async def update_memo(
    project_id: int,
    memo_id: int,
    data: MemoUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update a memo."""
    _get_project_or_404(db, project_id, user.id)
    memo = db.query(Memo).filter(Memo.id == memo_id, Memo.project_id == project_id).first()
    if not memo:
        raise HTTPException(status_code=404, detail="Memo not found")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(memo, field, value)

    log_action(
        db,
        action="updated",
        entity_type="memo",
        entity_id=memo.id,
        user_id=user.id,
        project_id=project_id,
        details=update_data
    )
    db.commit()
    db.refresh(memo)

    return memo_to_response(memo)


@router.delete("/api/projects/{project_id}/memos/{memo_id}")
async def archive_memo(
    project_id: int,
    memo_id: int,
    permanent: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Archive or permanently delete a memo."""
    _get_project_or_404(db, project_id, user.id)
    memo = db.query(Memo).filter(Memo.id == memo_id, Memo.project_id == project_id).first()
    if not memo:
        raise HTTPException(status_code=404, detail="Memo not found")

    if permanent:
        log_action(
            db,
            action="deleted",
            entity_type="memo",
            entity_id=memo.id,
            user_id=user.id,
            project_id=project_id
        )
        db.delete(memo)
    else:
        memo.is_archived = True
        log_action(
            db,
            action="archived",
            entity_type="memo",
            entity_id=memo.id,
            user_id=user.id,
            project_id=project_id
        )

    db.commit()

    return {"status": "ok", "archived": not permanent, "deleted_id": memo_id}
