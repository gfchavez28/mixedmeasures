from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.user import User
from ..models.conversation import Conversation
from ..models.code import Code
from ..models.code_category import CodeCategory
from ..models.materials import Material
from ..models.memo import Memo
from ..models.dataset import Dataset, DatasetColumn, DatasetRow
from ..models.scratchpad import ScratchpadEntry
from ..schemas.scratchpad import (
    ScratchpadEntryCreate,
    ScratchpadEntryUpdate,
    ScratchpadConvertRequest,
    ScratchpadEntryResponse,
    ScratchpadListResponse,
)
from ..auth import get_current_user
from .helpers import _get_project_or_404

router = APIRouter(prefix="/api/projects", tags=["scratchpad"])


@router.get("/{project_id}/scratchpad", response_model=ScratchpadListResponse)
async def list_entries(
    project_id: int,
    resolved: bool | None = Query(None),
    search: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List scratchpad entries, optionally filtered by resolved status or search."""
    _get_project_or_404(db, project_id, user.id)

    query = db.query(ScratchpadEntry).filter(ScratchpadEntry.project_id == project_id)

    if resolved is not None:
        query = query.filter(ScratchpadEntry.resolved == resolved)

    if search:
        query = query.filter(ScratchpadEntry.content.ilike(f"%{search}%"))

    entries = query.order_by(ScratchpadEntry.created_at.desc()).all()

    return ScratchpadListResponse(
        entries=[ScratchpadEntryResponse.model_validate(e) for e in entries],
        total=len(entries),
    )


@router.post("/{project_id}/scratchpad", response_model=ScratchpadEntryResponse, status_code=201)
async def create_entry(
    project_id: int,
    data: ScratchpadEntryCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new scratchpad entry."""
    _get_project_or_404(db, project_id, user.id)

    max_numeric_id = db.query(func.max(ScratchpadEntry.numeric_id)).filter(
        ScratchpadEntry.project_id == project_id
    ).scalar()
    next_numeric_id = (max_numeric_id or 0) + 1

    entry = ScratchpadEntry(
        project_id=project_id,
        numeric_id=next_numeric_id,
        content=data.content,
        context_hint=data.context_hint,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)

    return ScratchpadEntryResponse.model_validate(entry)


@router.patch("/{project_id}/scratchpad/{entry_id}", response_model=ScratchpadEntryResponse)
async def update_entry(
    project_id: int,
    entry_id: int,
    data: ScratchpadEntryUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a scratchpad entry's content or resolved status."""
    _get_project_or_404(db, project_id, user.id)

    entry = db.query(ScratchpadEntry).filter(
        ScratchpadEntry.id == entry_id,
        ScratchpadEntry.project_id == project_id,
    ).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Scratchpad entry not found")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(entry, field, value)

    db.commit()
    db.refresh(entry)

    return ScratchpadEntryResponse.model_validate(entry)


@router.delete("/{project_id}/scratchpad/{entry_id}")
async def delete_entry(
    project_id: int,
    entry_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Hard delete a scratchpad entry."""
    _get_project_or_404(db, project_id, user.id)

    entry = db.query(ScratchpadEntry).filter(
        ScratchpadEntry.id == entry_id,
        ScratchpadEntry.project_id == project_id,
    ).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Scratchpad entry not found")

    db.delete(entry)
    db.commit()

    return {"status": "ok", "deleted_id": entry_id}


def _validate_memo_entity(db: Session, project_id: int, entity_type: str, entity_id: int) -> None:
    """Validate that an entity exists in this project (reuses logic from memos router)."""
    if entity_type == "project":
        if entity_id != project_id:
            raise HTTPException(status_code=400, detail="entity_id must match project_id for project memos")
    elif entity_type == "dataset":
        if not db.query(Dataset.id).filter(Dataset.id == entity_id, Dataset.project_id == project_id).first():
            raise HTTPException(status_code=400, detail=f"dataset {entity_id} not found in this project")
    elif entity_type == "dataset_row":
        if not db.query(DatasetRow.id).join(Dataset).filter(DatasetRow.id == entity_id, Dataset.project_id == project_id).first():
            raise HTTPException(status_code=400, detail=f"dataset_row {entity_id} not found in this project")
    elif entity_type == "dataset_column":
        if not db.query(DatasetColumn.id).join(Dataset).filter(DatasetColumn.id == entity_id, Dataset.project_id == project_id).first():
            raise HTTPException(status_code=400, detail=f"dataset_column {entity_id} not found in this project")
    elif entity_type == "conversation":
        if not db.query(Conversation.id).filter(Conversation.id == entity_id, Conversation.project_id == project_id).first():
            raise HTTPException(status_code=400, detail=f"conversation {entity_id} not found in this project")
    elif entity_type == "code":
        if not db.query(Code.id).filter(Code.id == entity_id, Code.project_id == project_id).first():
            raise HTTPException(status_code=400, detail=f"code {entity_id} not found in this project")
    elif entity_type == "code_category":
        if not db.query(CodeCategory.id).filter(CodeCategory.id == entity_id, CodeCategory.project_id == project_id).first():
            raise HTTPException(status_code=400, detail=f"code_category {entity_id} not found in this project")
    elif entity_type == "analysis":
        if not db.query(Material.id).filter(Material.id == entity_id).first():
            raise HTTPException(status_code=400, detail=f"analysis element {entity_id} not found")


@router.post("/{project_id}/scratchpad/{entry_id}/convert", response_model=ScratchpadEntryResponse)
async def convert_entry(
    project_id: int,
    entry_id: int,
    data: ScratchpadConvertRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Convert a scratchpad entry to a memo."""
    _get_project_or_404(db, project_id, user.id)

    entry = db.query(ScratchpadEntry).filter(
        ScratchpadEntry.id == entry_id,
        ScratchpadEntry.project_id == project_id,
    ).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Scratchpad entry not found")

    if entry.resolved:
        raise HTTPException(status_code=400, detail="Entry is already resolved")

    # Validate target entity
    _validate_memo_entity(db, project_id, data.entity_type, data.entity_id)

    # Get next numeric_id for memos in this project
    max_numeric_id = db.query(func.max(Memo.numeric_id)).filter(
        Memo.project_id == project_id
    ).scalar()
    next_numeric_id = (max_numeric_id or 0) + 1

    # Create the memo
    memo = Memo(
        project_id=project_id,
        numeric_id=next_numeric_id,
        entity_type=data.entity_type,
        entity_id=data.entity_id,
        content=entry.content,
    )
    db.add(memo)
    db.flush()

    # Mark entry as resolved
    entry.resolved = True
    entry.resolved_into_type = "memo"
    entry.resolved_into_id = memo.id

    db.commit()
    db.refresh(entry)

    return ScratchpadEntryResponse.model_validate(entry)
