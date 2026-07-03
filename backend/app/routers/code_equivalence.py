"""Code-equivalence group endpoints (Track J · J2-3, Slab 6).

Codes grouped as one "effective code" so agreement/consensus treats e.g.
"Positive" ≡ "POSITIVE". Mirrors `equivalence.py` (dataset-column equivalence)
but simpler: a code belongs to ≤1 group via `Code.code_equivalence_group_id`,
so there is NO per-dataset cardinality concept, no swap/find-matches/suggest
(codes aren't dataset-scoped). The effective-code resolver lives in
`services/coding_layers.py`; this router only manages membership.

Every structural change (members or canonical changing → effective-code shift)
marks the affected targets' consensus stale via `mark_consensus_stale`, gated on
`consensus_enabled` so single-coder projects do zero work; a background sweep
recomputes (write-side, never on read — DEC-C/ADJ-3).
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..auth import get_current_user
from .auth import limiter
from ..database import get_db
from ..models.user import User
from ..models.code import Code
from ..models.code_equivalence_group import CodeEquivalenceGroup
from ..schemas.code_equivalence import (
    CodeEquivalenceGroupCreate,
    CodeEquivalenceGroupUpdate,
    CodeEquivalenceGroupAddCodes,
    CodeEquivalenceGroupRemoveCodes,
    CodeEquivalenceGroupRemoveCodesResponse,
    CodeEquivalenceMemberInfo,
    CodeEquivalenceGroupResponse,
    CodeEquivalenceGroupListResponse,
)
from ..services.audit import log_action
from ..services.consensus import consensus_enabled
from ..services.consensus_staleness import mark_consensus_stale

from .helpers import _get_project_or_404

router = APIRouter(
    prefix="/api/projects/{project_id}/code-equivalence-groups",
    tags=["code-equivalence"],
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_group_or_404(db: Session, project_id: int, group_id: int) -> CodeEquivalenceGroup:
    group = (
        db.query(CodeEquivalenceGroup)
        .filter(
            CodeEquivalenceGroup.id == group_id,
            CodeEquivalenceGroup.project_id == project_id,
        )
        .first()
    )
    if not group:
        raise HTTPException(status_code=404, detail="Code equivalence group not found")
    return group


def _group_members(db: Session, group_id: int) -> list[Code]:
    return (
        db.query(Code)
        .filter(Code.code_equivalence_group_id == group_id)
        .order_by(Code.numeric_id)
        .all()
    )


def _build_group_response(group: CodeEquivalenceGroup, db: Session) -> CodeEquivalenceGroupResponse:
    members = _group_members(db, group.id)
    return CodeEquivalenceGroupResponse(
        id=group.id,
        project_id=group.project_id,
        label=group.label,
        description=group.description,
        canonical_code_id=group.canonical_code_id,
        origin=group.origin,
        members=[CodeEquivalenceMemberInfo.model_validate(c) for c in members],
        created_at=group.created_at,
        updated_at=group.updated_at,
    )


def _validate_codes_belong_to_project(
    db: Session, project_id: int, code_ids: list[int],
) -> list[Code]:
    if not code_ids:
        return []
    codes = (
        db.query(Code)
        .filter(Code.id.in_(code_ids), Code.project_id == project_id)
        .all()
    )
    missing = set(code_ids) - {c.id for c in codes}
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Codes not found in project: {sorted(missing)}",
        )
    return codes


def _assert_codes_not_universal(codes: list[Code]) -> None:
    """Universal codes (Unsubstantive/Unclear) are excluded from consensus voting
    (`consensus.py`), so grouping one is dead weight and confusing. Reject it."""
    universal = sorted(c.id for c in codes if c.is_universal)
    if universal:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "universal_code",
                "message": "Universal codes cannot be grouped.",
                "code_ids": universal,
            },
        )


def _assert_codes_not_already_linked(codes: list[Code], current_group_id: int | None) -> None:
    """#301-style hijack guard: a code already in a DIFFERENT group cannot be
    silently moved. A code already in the target group is an idempotent re-add."""
    conflicts = sorted(
        c.id for c in codes
        if c.code_equivalence_group_id is not None
        and c.code_equivalence_group_id != current_group_id
    )
    if conflicts:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "already_linked",
                "message": "One or more codes already belong to another equivalence group.",
                "code_ids": conflicts,
            },
        )


def _mark_stale(db: Session, project_id: int, code_ids: list[int]) -> None:
    """Mark consensus stale for every target carrying any of ``code_ids`` — gated
    on ``consensus_enabled`` so single-coder projects do zero work. Pass the UNION
    of all members affected by an effective-code shift (C4)."""
    ids = sorted({cid for cid in code_ids if cid is not None})
    if ids and consensus_enabled(db):
        mark_consensus_stale(db, project_id, code_ids=ids)


# ── CRUD endpoints ───────────────────────────────────────────────────────────


@router.get("", response_model=CodeEquivalenceGroupListResponse)
async def list_groups(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all code-equivalence groups for a project, with member code details."""
    _get_project_or_404(db, project_id, user.id)
    groups = (
        db.query(CodeEquivalenceGroup)
        .filter(CodeEquivalenceGroup.project_id == project_id)
        .order_by(
            CodeEquivalenceGroup.sequence_order.asc().nulls_last(),
            CodeEquivalenceGroup.id,
        )
        .all()
    )
    responses = [_build_group_response(g, db) for g in groups]
    return CodeEquivalenceGroupListResponse(groups=responses, total=len(responses))


@router.post("", response_model=CodeEquivalenceGroupResponse, status_code=201)
async def create_group(
    project_id: int,
    data: CodeEquivalenceGroupCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a code-equivalence group, optionally with initial member codes."""
    _get_project_or_404(db, project_id, user.id)

    codes = _validate_codes_belong_to_project(db, project_id, data.code_ids)
    if codes:
        _assert_codes_not_universal(codes)
        _assert_codes_not_already_linked(codes, current_group_id=None)

    member_ids = {c.id for c in codes}
    if data.canonical_code_id is not None and data.canonical_code_id not in member_ids:
        raise HTTPException(
            status_code=400,
            detail="canonical_code_id must be one of the group's member codes",
        )

    group = CodeEquivalenceGroup(
        project_id=project_id,
        label=data.label,
        description=data.description,
        canonical_code_id=data.canonical_code_id,
    )
    db.add(group)
    db.flush()

    for code in codes:
        code.code_equivalence_group_id = group.id
    db.flush()

    _mark_stale(db, project_id, list(member_ids))

    log_action(
        db,
        action="created",
        entity_type="code_equivalence_group",
        entity_id=group.id,
        user_id=user.id,
        project_id=project_id,
        details={"label": group.label, "code_count": len(codes)},
    )
    db.commit()
    db.refresh(group)
    return _build_group_response(group, db)


@router.patch("/{group_id}", response_model=CodeEquivalenceGroupResponse)
async def update_group(
    project_id: int,
    group_id: int,
    data: CodeEquivalenceGroupUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update a group's label/description, or repoint its canonical code.

    Label/description changes don't shift effective codes (no mark-stale); a
    canonical change does (mark all members)."""
    _get_project_or_404(db, project_id, user.id)
    group = _get_group_or_404(db, project_id, group_id)

    fields = data.model_dump(exclude_unset=True)

    if "canonical_code_id" in fields:
        new_canonical = fields["canonical_code_id"]
        if new_canonical is not None:
            member_ids = {c.id for c in _group_members(db, group.id)}
            if new_canonical not in member_ids:
                raise HTTPException(
                    status_code=400,
                    detail="canonical_code_id must be one of the group's member codes",
                )
        group.canonical_code_id = new_canonical
        # Canonical shift changes the effective code for EVERY member.
        _mark_stale(db, project_id, [c.id for c in _group_members(db, group.id)])

    if data.label is not None:
        group.label = data.label
    if data.description is not None:
        group.description = data.description

    log_action(
        db,
        action="updated",
        entity_type="code_equivalence_group",
        entity_id=group.id,
        user_id=user.id,
        project_id=project_id,
        details={"label": group.label},
    )
    db.commit()
    db.refresh(group)
    return _build_group_response(group, db)


@router.delete("/{group_id}")
async def delete_group(
    project_id: int,
    group_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a group. Member codes are unlinked (SET NULL), not deleted."""
    _get_project_or_404(db, project_id, user.id)
    group = _get_group_or_404(db, project_id, group_id)

    label = group.label
    member_ids = [c.id for c in _group_members(db, group.id)]

    db.query(Code).filter(Code.code_equivalence_group_id == group_id).update(
        {Code.code_equivalence_group_id: None},
        synchronize_session="fetch",
    )
    db.flush()

    # Members revert to identity effective-code → their consensus may change.
    _mark_stale(db, project_id, member_ids)

    log_action(
        db,
        action="deleted",
        entity_type="code_equivalence_group",
        entity_id=group_id,
        user_id=user.id,
        project_id=project_id,
        details={"label": label},
    )
    db.delete(group)
    db.commit()
    return {"status": "ok", "deleted_id": group_id}


# ── Member endpoints ────────────────────────────────────────────────────────


@router.post("/{group_id}/codes", response_model=CodeEquivalenceGroupResponse)
@limiter.limit("60/minute")
async def add_codes(
    request: Request,
    project_id: int,
    group_id: int,
    data: CodeEquivalenceGroupAddCodes,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add codes to a group (rate-limited 60/min — may fan out from bulk UI)."""
    _get_project_or_404(db, project_id, user.id)
    group = _get_group_or_404(db, project_id, group_id)

    codes = _validate_codes_belong_to_project(db, project_id, data.code_ids)
    _assert_codes_not_universal(codes)
    _assert_codes_not_already_linked(codes, current_group_id=group.id)

    for code in codes:
        code.code_equivalence_group_id = group.id
    db.flush()

    # Adding a member can change the min-member canonical fallback → every current
    # member's effective code may shift. Mark the whole post-add membership.
    _mark_stale(db, project_id, [c.id for c in _group_members(db, group.id)])

    log_action(
        db,
        action="codes_added",
        entity_type="code_equivalence_group",
        entity_id=group.id,
        user_id=user.id,
        project_id=project_id,
        details={"code_ids": data.code_ids},
    )
    db.commit()
    db.refresh(group)
    return _build_group_response(group, db)


@router.post("/{group_id}/codes/remove", response_model=CodeEquivalenceGroupRemoveCodesResponse)
@limiter.limit("60/minute")
async def remove_codes(
    request: Request,
    project_id: int,
    group_id: int,
    data: CodeEquivalenceGroupRemoveCodes,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove codes from a group. Auto-dissolves the group if it becomes empty
    (mirrors `equivalence.remove_columns` Path A); `dissolved` reports which."""
    _get_project_or_404(db, project_id, user.id)
    group = _get_group_or_404(db, project_id, group_id)

    removed_ids = [c.id for c in _group_members(db, group.id) if c.id in set(data.code_ids)]

    db.query(Code).filter(
        Code.id.in_(data.code_ids),
        Code.code_equivalence_group_id == group_id,
    ).update(
        {Code.code_equivalence_group_id: None},
        synchronize_session="fetch",
    )
    db.flush()

    remaining = _group_members(db, group.id)
    # If the canonical code was just removed, null it so the resolver falls back
    # cleanly to the lowest remaining member (A4 — read-time fallback covers a
    # stale value, but this keeps the stored value honest).
    if group.canonical_code_id in set(removed_ids):
        group.canonical_code_id = None

    # Removed codes revert to identity; remaining members may see a canonical
    # shift — mark the UNION (C4).
    _mark_stale(db, project_id, removed_ids + [c.id for c in remaining])

    dissolved = len(remaining) == 0

    log_action(
        db,
        action="codes_removed",
        entity_type="code_equivalence_group",
        entity_id=group.id,
        user_id=user.id,
        project_id=project_id,
        details={"code_ids": data.code_ids, "dissolved": dissolved},
    )

    if dissolved:
        db.delete(group)
        db.commit()
        return CodeEquivalenceGroupRemoveCodesResponse(group=None, dissolved=True)

    db.commit()
    db.refresh(group)
    return CodeEquivalenceGroupRemoveCodesResponse(
        group=_build_group_response(group, db),
        dissolved=False,
    )


# ── Merge endpoint ─────────────────────────────────────────────────────────


@router.post("/{group_id}/merge/{other_group_id}", response_model=CodeEquivalenceGroupResponse)
@limiter.limit("60/minute")
async def merge_groups(
    request: Request,
    project_id: int,
    group_id: int,
    other_group_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Merge other_group into group_id: move all codes, delete other_group."""
    _get_project_or_404(db, project_id, user.id)
    target_group = _get_group_or_404(db, project_id, group_id)
    source_group = _get_group_or_404(db, project_id, other_group_id)

    if group_id == other_group_id:
        raise HTTPException(status_code=400, detail="Cannot merge a group with itself")

    source_codes = _group_members(db, source_group.id)
    target_ids = [c.id for c in _group_members(db, target_group.id)]
    moved_ids = [c.id for c in source_codes]

    # Reassign via the ORM relationship setter (NOT the FK scalar) + flush before
    # deleting the source: this keeps the identity map consistent so SQLAlchemy
    # doesn't emit a phantom UPDATE back to the about-to-be-deleted source group
    # (the internal design notes foot-gun #1, same as equivalence.merge_groups). Note this
    # is the IDENTITY-MAP rationale, not the #439 cascade-sweep one — a group
    # delete is SET NULL + passive_deletes, so member codes are never deleted.
    for code in source_codes:
        code.code_equivalence_group = target_group
    db.flush()

    # Every member of BOTH groups can see an effective-code shift (the merged set
    # has a new min-member canonical fallback) — mark the union (C4).
    _mark_stale(db, project_id, moved_ids + target_ids)

    log_action(
        db,
        action="merged",
        entity_type="code_equivalence_group",
        entity_id=group_id,
        user_id=user.id,
        project_id=project_id,
        details={"merged_from": other_group_id, "codes_moved": len(moved_ids)},
    )

    db.delete(source_group)
    db.commit()
    db.refresh(target_group)
    return _build_group_response(target_group, db)
