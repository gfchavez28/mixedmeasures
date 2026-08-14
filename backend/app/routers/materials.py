"""Material collection CRUD endpoints."""

import json
from typing import Iterable

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session, selectinload

from ..auth import get_current_user
from ..database import get_db
from ..models.user import User
from ..models.materials import MaterialCollection, Material
from ..models.dataset import Dataset, DatasetColumn
from ..models.analysis_domain import AnalysisDomain
from ..models.code import Code
from ..models.conversation import Conversation
from ..models.document import Document
from ..models.observation import Observation
from ..models.participant import Participant
from ..schemas.materials import (
    MaterialCollectionCreate,
    MaterialCollectionUpdate,
    MaterialCollectionResponse,
    MaterialCollectionListResponse,
    MaterialCollectionDetailResponse,
    MaterialCreate,
    MaterialUpdate,
    MaterialReorderRequest,
    MaterialResponse,
)
from .helpers import _get_project_or_404

router = APIRouter(
    prefix="/api/projects/{project_id}/material-collections",
    tags=["material-collections"],
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_collection_or_404(db: Session, project_id: int, collection_id: int) -> MaterialCollection:
    collection = (
        db.query(MaterialCollection)
        .filter(
            MaterialCollection.id == collection_id,
            MaterialCollection.project_id == project_id,
        )
        .first()
    )
    if not collection:
        raise HTTPException(status_code=404, detail="Material collection not found")
    return collection


def _get_material_or_404(db: Session, collection_id: int, material_id: int) -> Material:
    material = (
        db.query(Material)
        .filter(
            Material.id == material_id,
            Material.collection_id == collection_id,
        )
        .first()
    )
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    return material


# #296 / #652 slab 3: keys in Material.config that point at project entities.
#
# Conservative — only the keys a canvas embed actually reads
# (`InlineChartRenderer::extractComputeParams` for the quantitative branch,
# `inline-chart-params.ts::extractQualComputeParams` for the qualitative one).
# Better to miss a reference than to false-positive on a valid material.
#
# ⚠️ **Keyed by REF KIND, not returned positionally.** This started as a 2-tuple
# `(column_ids, domain_ids)`, which is why slab 3 sat deferred: adding the
# qualitative kinds changed the arity at every call site. A dict makes the next
# kind additive instead — add a row here and an existence query below, and every
# consumer keeps working.
_MATERIAL_REF_LIST_KEYS: dict[str, tuple[str, ...]] = {
    # `text_column_ids` are DatasetColumn ids like the others, so they resolve
    # through the same existence query rather than needing their own.
    "column": ("column_ids", "selected_columns", "text_column_ids"),
    "domain": ("domain_ids", "selected_domains"),
    "code": ("code_ids",),
    "conversation": ("conversation_ids",),
    "document": ("document_ids",),
    "observation": ("observation_ids",),
    "participant": ("participant_ids",),
}
_MATERIAL_REF_SCALAR_KEYS: dict[str, tuple[str, ...]] = {
    "column": ("grouping_column_id", "grouping_column_id_2", "compareBy", "compareBy2", "crossTabCol"),
}

# Back-compat aliases — the original names, kept so a reader grepping the #296
# comment history still lands somewhere real.
_MATERIAL_COLUMN_LIST_KEYS = _MATERIAL_REF_LIST_KEYS["column"]
_MATERIAL_DOMAIN_LIST_KEYS = _MATERIAL_REF_LIST_KEYS["domain"]
_MATERIAL_COLUMN_SCALAR_KEYS = _MATERIAL_REF_SCALAR_KEYS["column"]


def _collect_material_refs(config: dict) -> dict[str, set[int]]:
    """Return ``{ref_kind: {ids}}`` referenced by a material's config.

    A deleted reference is what makes an embed render silently incomplete, so
    every kind the embed can filter on is collected — quantitative (columns,
    domains) AND qualitative (codes plus the four source kinds and participants).

    Before slab 3 this returned columns and domains only, so **every qualitative
    material reported `(∅, ∅)` and could never be flagged stale** — harmless while
    those materials rendered "No data configured" regardless, and live the moment
    slabs 1–2 made eight of the nine types actually draw.
    """
    refs: dict[str, set[int]] = {kind: set() for kind in _MATERIAL_REF_LIST_KEYS}
    if not isinstance(config, dict):
        return refs
    for kind, keys in _MATERIAL_REF_LIST_KEYS.items():
        for key in keys:
            val = config.get(key)
            if isinstance(val, list):
                for item in val:
                    # bool is an int subclass — exclude it explicitly, or a
                    # `True` in a list would register as entity id 1.
                    if isinstance(item, int) and not isinstance(item, bool) and item > 0:
                        refs[kind].add(item)
    for kind, keys in _MATERIAL_REF_SCALAR_KEYS.items():
        for key in keys:
            val = config.get(key)
            if isinstance(val, int) and not isinstance(val, bool) and val > 0:
                refs[kind].add(val)
    return refs


def _build_existence_sets(
    db: Session, project_id: int, materials: Iterable[Material]
) -> dict[str, set[int]]:
    """Batched existence check per ref kind across every material in the iterable.

    One query per kind that has any ids, run once for the whole list rather than
    per material (the #296 detection is then pure set arithmetic).

    Every query is **project-scoped** (#390): an id belonging to another project
    must read as missing, not as "source available".
    """
    wanted: dict[str, set[int]] = {kind: set() for kind in _MATERIAL_REF_LIST_KEYS}
    for m in materials:
        try:
            cfg = json.loads(m.config) if isinstance(m.config, str) else m.config
        except (json.JSONDecodeError, TypeError):
            continue
        for kind, ids in _collect_material_refs(cfg or {}).items():
            wanted[kind] |= ids

    existing: dict[str, set[int]] = {kind: set() for kind in wanted}

    if wanted["column"]:
        existing["column"] = {
            r[0] for r in
            db.query(DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(DatasetColumn.id.in_(wanted["column"]), Dataset.project_id == project_id)
            .all()
        }
    # The remaining kinds are all directly project-scoped, so one shape covers them.
    for kind, model in (
        ("domain", AnalysisDomain),
        ("code", Code),
        ("conversation", Conversation),
        ("document", Document),
        ("observation", Observation),
        ("participant", Participant),
    ):
        if wanted[kind]:
            existing[kind] = {
                r[0] for r in
                db.query(model.id).filter(
                    model.id.in_(wanted[kind]),
                    model.project_id == project_id,
                ).all()
            }
    return existing


def _build_material_response(
    material: Material,
    existing: dict[str, set[int]] | None = None,
) -> MaterialResponse:
    try:
        config = json.loads(material.config) if isinstance(material.config, str) else material.config
    except (json.JSONDecodeError, TypeError):
        config = {}

    # #296: stale-on-load reference detection. When existence sets are not
    # provided (single-material write paths like create/update — fresh refs
    # are valid by construction), skip the check.
    missing_refs: list[dict] = []
    if existing is not None:
        for kind, ids in _collect_material_refs(config or {}).items():
            # A kind absent from `existing` was never queried, so it cannot be
            # judged — skip rather than report every id of that kind missing.
            if kind not in existing:
                continue
            for ref_id in sorted(ids - existing[kind]):
                missing_refs.append({"type": kind, "id": ref_id})

    return MaterialResponse(
        id=material.id,
        collection_id=material.collection_id,
        material_type=material.material_type,
        config=config,
        auto_name=material.auto_name,
        custom_name=material.custom_name,
        display_order=material.display_order,
        source_tab=material.source_tab,
        created_at=material.created_at,
        has_missing_refs=bool(missing_refs),
        missing_refs=missing_refs,
    )


def _build_collection_response(collection: MaterialCollection, material_count: int = 0) -> MaterialCollectionResponse:
    return MaterialCollectionResponse(
        id=collection.id,
        project_id=collection.project_id,
        name=collection.name,
        display_order=collection.display_order,
        created_at=collection.created_at,
        material_count=material_count,
    )


# ── Collection endpoints ────────────────────────────────────────────────────


@router.get("", response_model=MaterialCollectionListResponse)
async def list_collections(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)

    collections = (
        db.query(MaterialCollection)
        .filter(MaterialCollection.project_id == project_id)
        .order_by(MaterialCollection.display_order.asc(), MaterialCollection.id.asc())
        .all()
    )

    counts = dict(
        db.query(Material.collection_id, sa_func.count(Material.id))
        .filter(Material.collection_id.in_([c.id for c in collections]))
        .group_by(Material.collection_id)
        .all()
    ) if collections else {}

    responses = []
    for c in collections:
        responses.append(_build_collection_response(c, counts.get(c.id, 0)))

    return MaterialCollectionListResponse(collections=responses)


@router.post("", response_model=MaterialCollectionResponse, status_code=201)
async def create_collection(
    project_id: int,
    data: MaterialCollectionCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)

    max_order = (
        db.query(sa_func.max(MaterialCollection.display_order))
        .filter(MaterialCollection.project_id == project_id)
        .scalar()
    )

    collection = MaterialCollection(
        project_id=project_id,
        name=data.name,
        display_order=(max_order or 0) + 1,
    )
    db.add(collection)
    db.commit()
    db.refresh(collection)

    return _build_collection_response(collection, 0)


@router.get("/all-materials", response_model=list[MaterialResponse])
async def list_all_materials(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all materials across all collections for a project in one query."""
    _get_project_or_404(db, project_id, user.id)

    materials = (
        db.query(Material)
        .join(MaterialCollection, Material.collection_id == MaterialCollection.id)
        .filter(MaterialCollection.project_id == project_id)
        .order_by(MaterialCollection.display_order.asc(), Material.display_order.asc())
        .all()
    )

    existing = _build_existence_sets(db, project_id, materials)
    return [_build_material_response(m, existing) for m in materials]


@router.get("/{collection_id}", response_model=MaterialCollectionDetailResponse)
async def get_collection(
    project_id: int,
    collection_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    collection = (
        db.query(MaterialCollection)
        .options(selectinload(MaterialCollection.materials))
        .filter(
            MaterialCollection.id == collection_id,
            MaterialCollection.project_id == project_id,
        )
        .first()
    )
    if not collection:
        raise HTTPException(status_code=404, detail="Material collection not found")

    existing = _build_existence_sets(db, project_id, collection.materials)
    return MaterialCollectionDetailResponse(
        id=collection.id,
        project_id=collection.project_id,
        name=collection.name,
        display_order=collection.display_order,
        created_at=collection.created_at,
        materials=[_build_material_response(m, existing) for m in collection.materials],
    )


@router.patch("/{collection_id}", response_model=MaterialCollectionResponse)
async def update_collection(
    project_id: int,
    collection_id: int,
    data: MaterialCollectionUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    collection = _get_collection_or_404(db, project_id, collection_id)

    if data.name is not None:
        collection.name = data.name

    db.commit()
    db.refresh(collection)

    count = (
        db.query(sa_func.count(Material.id))
        .filter(Material.collection_id == collection.id)
        .scalar()
    )
    return _build_collection_response(collection, count)


@router.delete("/{collection_id}")
async def delete_collection(
    project_id: int,
    collection_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    collection = _get_collection_or_404(db, project_id, collection_id)
    db.delete(collection)
    db.commit()
    return {"status": "ok", "deleted_id": collection_id}


# ── Material endpoints ──────────────────────────────────────────────────────


@router.post("/{collection_id}/materials", response_model=MaterialResponse, status_code=201)
async def create_material(
    project_id: int,
    collection_id: int,
    data: MaterialCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_collection_or_404(db, project_id, collection_id)

    max_order = (
        db.query(sa_func.max(Material.display_order))
        .filter(Material.collection_id == collection_id)
        .scalar()
    )

    material = Material(
        collection_id=collection_id,
        material_type=data.material_type,
        config=json.dumps(data.config),
        auto_name=data.auto_name,
        custom_name=data.custom_name,
        display_order=(max_order or 0) + 1,
        source_tab=data.source_tab,
    )
    db.add(material)
    db.commit()
    db.refresh(material)

    return _build_material_response(material)


@router.patch("/{collection_id}/materials/{material_id}", response_model=MaterialResponse)
async def update_material(
    project_id: int,
    collection_id: int,
    material_id: int,
    data: MaterialUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_collection_or_404(db, project_id, collection_id)
    material = _get_material_or_404(db, collection_id, material_id)

    update_data = data.model_dump(exclude_unset=True)
    if "custom_name" in update_data:
        material.custom_name = update_data["custom_name"]
    if "config" in update_data and update_data["config"] is not None:
        material.config = json.dumps(update_data["config"])

    db.commit()
    db.refresh(material)
    return _build_material_response(material)


@router.delete("/{collection_id}/materials/{material_id}")
async def delete_material(
    project_id: int,
    collection_id: int,
    material_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_collection_or_404(db, project_id, collection_id)
    material = _get_material_or_404(db, collection_id, material_id)

    db.delete(material)
    db.commit()
    return {"status": "ok", "deleted_id": material_id}


@router.post("/{collection_id}/materials/reorder")
async def reorder_materials(
    project_id: int,
    collection_id: int,
    data: MaterialReorderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    _get_collection_or_404(db, project_id, collection_id)

    for i, material_id in enumerate(data.material_ids):
        db.query(Material).filter(
            Material.id == material_id,
            Material.collection_id == collection_id,
        ).update({"display_order": i}, synchronize_session="fetch")

    db.commit()
    return {"status": "ok"}
