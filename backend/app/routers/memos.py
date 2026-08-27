from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.user import User
from ..models.project import Project
from ..models.conversation import Conversation
from ..models.observation import Observation
from ..models.code import Code
from ..models.code_category import CodeCategory
from ..models.document import Document
from ..models.canvas import Canvas
from ..models.materials import MaterialCollection, Material
from ..models.memo import MEMO_ENTITY_TYPES, Memo
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


# ── Memo target validation (#780) ────────────────────────────────────────────
#
# 🔴 This replaced TWO divergent branch chains, and both had live holes. The one
# here covered ten of the eleven declared types — `document` matched no arm and
# there was no `else`, so a document memo's `entity_id` was **never checked
# against the project at all**. `routers/scratchpad.py` carried a private copy
# covering eight, and its `analysis` arm queried `Material.id == entity_id` with
# no collection join, so converting a scratchpad entry could attach a memo to
# ANOTHER project's material. The #733 rule: a copy does not merely drift from
# its original, it propagates a defect verbatim and adds its own.
#
# ⚠️ `test_ownership_gate_sweep.py` cannot see this class. Both endpoints call
# `_get_project_or_404`, so the project gate is satisfied; the hole is in the
# per-entity check that runs after it. A sweep asking "does this endpoint reach
# a gate token" is structurally blind to a branch chain missing an arm.
#
# ⚠️ `Memo.entity_id` has NO ForeignKey, so nothing downstream would have
# caught it either — no IntegrityError, no warning, just a memo pointing at a
# stranger's row.

def _in_project(db: Session, col, *filters) -> bool:
    return db.query(col).filter(*filters).first() is not None


#: Per-type ownership rule, keyed by `MEMO_ENTITY_TYPES`. `project` is absent on
#: purpose — its rule is an identity check, not a lookup — and is handled first
#: in `_validate_memo_entity`.
_MEMO_ENTITY_CHECKS = {
    "conversation": lambda db, pid, eid: _in_project(
        db, Conversation.id, Conversation.id == eid, Conversation.project_id == pid),
    "observation": lambda db, pid, eid: _in_project(
        db, Observation.id, Observation.id == eid, Observation.project_id == pid),
    "document": lambda db, pid, eid: _in_project(
        db, Document.id, Document.id == eid, Document.project_id == pid),
    "code": lambda db, pid, eid: _in_project(
        db, Code.id, Code.id == eid, Code.project_id == pid),
    "code_category": lambda db, pid, eid: _in_project(
        db, CodeCategory.id, CodeCategory.id == eid, CodeCategory.project_id == pid),
    "dataset": lambda db, pid, eid: _in_project(
        db, Dataset.id, Dataset.id == eid, Dataset.project_id == pid),
    "canvas": lambda db, pid, eid: _in_project(
        db, Canvas.id, Canvas.id == eid, Canvas.project_id == pid),
    # Joined: these hang off the project through a parent.
    "dataset_row": lambda db, pid, eid: db.query(DatasetRow.id).join(Dataset).filter(
        DatasetRow.id == eid, Dataset.project_id == pid).first() is not None,
    "dataset_column": lambda db, pid, eid: db.query(DatasetColumn.id).join(Dataset).filter(
        DatasetColumn.id == eid, Dataset.project_id == pid).first() is not None,
    "analysis": lambda db, pid, eid: db.query(Material.id).join(MaterialCollection).filter(
        Material.id == eid, MaterialCollection.project_id == pid).first() is not None,
}

# FAIL CLOSED AT IMPORT. Adding a memo-able entity to `MEMO_ENTITY_TYPES` without
# an ownership rule here stops the app booting — which is the correct trade,
# because the alternative is exactly the silent hole this section documents. It
# can only ever fire on a code change, so it is caught by the first test that
# imports this module, never by a user.
_MISSING_RULES = set(MEMO_ENTITY_TYPES) - set(_MEMO_ENTITY_CHECKS) - {"project"}
if _MISSING_RULES:
    raise RuntimeError(
        f"memo entity types with no ownership rule: {sorted(_MISSING_RULES)} — "
        "add one to _MEMO_ENTITY_CHECKS in routers/memos.py, or a memo of that "
        "type will be created without its entity_id ever being checked."
    )


def _validate_memo_entity(
    db: Session, project_id: int, entity_type: str, entity_id: int
) -> None:
    """Refuse a memo whose target is not in this project.

    THE one implementation — `routers/scratchpad.py` imports this rather than
    keeping its own. Raises `HTTPException(400)`; returns None on success.
    """
    if entity_type == "project":
        if entity_id != project_id:
            raise HTTPException(
                status_code=400,
                detail="entity_id must match project_id for project memos",
            )
        return

    check = _MEMO_ENTITY_CHECKS.get(entity_type)
    if check is None:
        # Unreachable while the schema validates against the same vocabulary and
        # the import guard above holds — kept because "no rule" must never mean
        # "no check", which is precisely how `document` slipped through.
        raise HTTPException(
            status_code=400, detail=f"unsupported memo entity type: {entity_type}"
        )
    if not check(db, project_id, entity_id):
        raise HTTPException(
            status_code=400,
            detail=f"{entity_type} {entity_id} not found in this project",
        )


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

    _validate_memo_entity(db, project_id, data.entity_type, data.entity_id)

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
