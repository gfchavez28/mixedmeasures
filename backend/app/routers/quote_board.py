import json
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..database import get_db
from ..auth import get_current_user
from ..models import QuoteBoardConfig
from ..models.user import User
from .helpers import _get_project_or_404
from pydantic import BaseModel


router = APIRouter(prefix="/api/projects/{project_id}/quote-board", tags=["quote-board"])


class QuoteBoardConfigResponse(BaseModel):
    custom_orders: dict[str, list[int]]


class QuoteBoardConfigUpdate(BaseModel):
    custom_orders: dict[str, list[int]] | None = None


def _safe_json(text: str | None) -> dict:
    """Parse JSON from DB field, returning empty dict on corruption."""
    if not text:
        return {}
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return {}


def _get_config(db: Session, project_id: int) -> QuoteBoardConfig:
    config = db.query(QuoteBoardConfig).filter_by(project_id=project_id).first()
    if not config:
        config = QuoteBoardConfig(project_id=project_id)
        db.add(config)
        db.flush()
    return config


@router.get("/config", response_model=QuoteBoardConfigResponse)
async def get_config(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    config = _get_config(db, project_id)
    db.commit()
    return QuoteBoardConfigResponse(
        custom_orders=_safe_json(config.custom_orders),
    )


@router.patch("/config", response_model=QuoteBoardConfigResponse)
async def update_config(
    project_id: int,
    data: QuoteBoardConfigUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    config = _get_config(db, project_id)
    if "custom_orders" in data.model_fields_set:
        config.custom_orders = json.dumps(data.custom_orders) if data.custom_orders else None
    db.commit()
    db.refresh(config)
    return QuoteBoardConfigResponse(
        custom_orders=_safe_json(config.custom_orders),
    )
