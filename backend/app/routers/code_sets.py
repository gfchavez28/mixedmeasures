"""Code-set endpoints — a mutually exclusive group of codes (queue row 48).

Mirrors `code_equivalence.py`, which is the right SHAPE for the opposite
relation: a code belongs to at most one set through a single FK, so there is no
cardinality concept — but the members are alternatives rather than synonyms, and
a unit takes exactly one of them.

**Every refusal comes from `services/code_sets.py`.** A guard at a router is not
a guard on the operation (#589): the import and portability paths reach
`Code.code_set_id` without passing through here, so this router only makes the
service's refusals earlier and cheaper, and turns a reason into a sentence.

Every structural change marks the affected targets' consensus stale — a set
decides which code the consensus layer writes for a unit, so changing membership
moves what a rebuild would say.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models.code import Code
from ..models.code_set import CodeSet
from ..models.user import User
from ..schemas.code_set import (
    CodeSetAddCodes,
    CodeSetClaimant,
    CodeSetCreate,
    CodeSetListResponse,
    CodeSetMemberInfo,
    CodeSetRemoveCodes,
    CodeSetRemoveCodesResponse,
    CodeSetResponse,
    CodeSetUpdate,
)
from ..services import code_sets as code_set_rules
from ..services.audit import log_action
from ..services.coding_layers import build_effective_code_map
from ..services.consensus import consensus_enabled
from ..services.consensus_staleness import mark_consensus_stale
from ..services.participant_scores import mark_participant_scores_stale
from .helpers import _get_project_or_404

router = APIRouter(
    prefix="/api/projects/{project_id}/code-sets",
    tags=["code-sets"],
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_set_or_404(db: Session, project_id: int, set_id: int) -> CodeSet:
    found = (
        db.query(CodeSet)
        .filter(CodeSet.id == set_id, CodeSet.project_id == project_id)
        .first()
    )
    if not found:
        raise HTTPException(status_code=404, detail="Code set not found")
    return found


def _members(db: Session, set_id: int) -> list[Code]:
    return (
        db.query(Code)
        .filter(Code.code_set_id == set_id)
        .order_by(Code.numeric_id)
        .all()
    )


def _project_context(db: Session, project_id: int) -> tuple[dict[int, int], dict[int, Code]]:
    """The effective-code map and every code, read ONCE per request.

    ⚠️ The list endpoint used to rebuild both per SET — a full codes read and an
    equivalence-map build for each set in the project, on a request every coding
    surface makes when it opens.
    """
    effective_map = build_effective_code_map(db, project_id)
    codes_by_id = {c.id: c for c in db.query(Code).filter(Code.project_id == project_id).all()}
    return effective_map, codes_by_id


def _build_response(
    code_set: CodeSet,
    db: Session,
    context: tuple[dict[int, int], dict[int, Code]] | None = None,
) -> CodeSetResponse:
    members = _members(db, code_set.id)
    effective_map, codes_by_id = context or _project_context(db, code_set.project_id)
    claimants = code_set_rules.set_claimants(members, effective_map=effective_map)
    return CodeSetResponse(
        id=code_set.id,
        project_id=code_set.project_id,
        label=code_set.label,
        description=code_set.description,
        exhaustive=bool(code_set.exhaustive),
        members=[CodeSetMemberInfo.model_validate(c) for c in members],
        set_basis=code_set_rules.set_basis(bool(code_set.exhaustive)),
        composition_warnings=code_set_rules.set_composition_warnings(
            members, effective_map=effective_map, codes_by_id=codes_by_id,
        ),
        claimants=[
            CodeSetClaimant(code_id=code_id, value_id=value_id)
            for code_id, value_id in sorted(claimants.items())
        ],
        created_at=code_set.created_at,
        updated_at=code_set.updated_at,
    )


def _codes_in_project(db: Session, project_id: int, code_ids: list[int]) -> list[Code]:
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
            status_code=400, detail=f"Codes not found in project: {sorted(missing)}",
        )
    return codes


def _assert_may_join(
    db: Session, project_id: int, codes: list[Code], target_set: CodeSet,
) -> None:
    """Every candidate passes `code_sets.membership_refusal`, or 409 with its words.

    ⚠️ The whole batch is judged together (`incoming_ids`): a set built in one act
    may legitimately contain both halves of an equivalence group, and judging each
    member against the database alone would refuse the canonical code's companion
    for a state the same request is creating.
    """
    effective_map = build_effective_code_map(db, project_id)
    codes_by_id = {
        c.id: c for c in db.query(Code).filter(Code.project_id == project_id).all()
    }
    incoming = frozenset(c.id for c in codes)
    refusals = []
    for code in codes:
        refusal = code_set_rules.membership_refusal(
            code, target_set,
            effective_map=effective_map, codes_by_id=codes_by_id,
            incoming_ids=incoming,
        )
        if refusal is not None:
            reason, sentence = refusal
            refusals.append({"code_id": code.id, "reason": reason, "message": sentence})
    if refusals:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "code_set_membership_refused",
                # The FIRST sentence is the message a client that reads only
                # `detail.message` shows; the list carries the rest, so a batch
                # refusal never collapses into "something went wrong".
                "message": refusals[0]["message"],
                "refusals": refusals,
            },
        )


def _mark_stale(db: Session, project_id: int, code_ids: list[int]) -> None:
    """A membership change moves what a consensus rebuild would write for a unit.

    Row 45's participant-score marker is UNGATED, above the `consensus_enabled`
    gate, for the reason `routers/coding.py:65` records: consensus is meaningless
    with one voter and rating-derived scores are not.
    """
    ids = sorted({cid for cid in code_ids if cid is not None})
    if not ids:
        return
    mark_participant_scores_stale(db, project_id)
    if consensus_enabled(db):
        mark_consensus_stale(db, project_id, code_ids=ids)


# ── CRUD ─────────────────────────────────────────────────────────────────────


@router.get("", response_model=CodeSetListResponse)
def list_code_sets(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    rows = (
        db.query(CodeSet)
        .filter(CodeSet.project_id == project_id)
        .order_by(CodeSet.sequence_order.is_(None), CodeSet.sequence_order, CodeSet.id)
        .all()
    )
    context = _project_context(db, project_id) if rows else None
    return CodeSetListResponse(
        sets=[_build_response(s, db, context) for s in rows], total=len(rows),
    )


@router.post("", response_model=CodeSetResponse, status_code=201)
def create_code_set(
    project_id: int,
    data: CodeSetCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    code_set = CodeSet(
        project_id=project_id,
        label=data.label.strip(),
        description=data.description,
        exhaustive=data.exhaustive,
    )
    db.add(code_set)
    db.flush()

    codes = _codes_in_project(db, project_id, data.code_ids)
    if codes:
        _assert_may_join(db, project_id, codes, code_set)
        for code in codes:
            code.code_set_id = code_set.id
        db.flush()
        _mark_stale(db, project_id, [c.id for c in codes])

    log_action(
        db, action="code_set_created", entity_type="code_set", entity_id=code_set.id,
        user_id=user.id, project_id=project_id,
        details={"label": code_set.label, "members": len(codes)},
    )
    db.commit()
    db.refresh(code_set)
    return _build_response(code_set, db)


@router.patch("/{set_id}", response_model=CodeSetResponse)
def update_code_set(
    project_id: int,
    set_id: int,
    data: CodeSetUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    code_set = _get_set_or_404(db, project_id, set_id)
    fields = data.model_dump(exclude_unset=True)
    if "label" in fields and fields["label"] is not None:
        code_set.label = fields["label"].strip()
    if "description" in fields:
        code_set.description = fields["description"]
    exhaustive_changed = False
    if "exhaustive" in fields and fields["exhaustive"] is not None:
        exhaustive_changed = bool(code_set.exhaustive) != bool(fields["exhaustive"])
        code_set.exhaustive = bool(fields["exhaustive"])
    db.flush()

    # 🔴 `exhaustive` is the one display-ish flag that changes a WRITE: it decides
    # whether a coder who chose nothing is an abstention or a vote for "none of
    # these", which moves the majority. Flipping it therefore invalidates the
    # stored consensus layer exactly as a membership change does.
    if exhaustive_changed:
        _mark_stale(db, project_id, [c.id for c in _members(db, set_id)])

    log_action(
        db, action="code_set_updated", entity_type="code_set", entity_id=code_set.id,
        user_id=user.id, project_id=project_id, details=fields,
    )
    db.commit()
    db.refresh(code_set)
    return _build_response(code_set, db)


@router.delete("/{set_id}")
def delete_code_set(
    project_id: int,
    set_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a set. Its members KEEP every application they carry.

    A set is a reading of codes that already exist, so deleting it un-reads them
    — the codes and their codings are untouched and reappear in the per-code
    table. ⚠️ The member FKs are nulled EXPLICITLY before the delete rather than
    left to `ON DELETE SET NULL`, so the identity map agrees with the database
    within this transaction (`merge_groups`' foot-gun, and the reason the
    relationship carries `passive_deletes=True`).
    """
    _get_project_or_404(db, project_id, user.id)
    code_set = _get_set_or_404(db, project_id, set_id)
    member_ids = [c.id for c in _members(db, set_id)]
    db.query(Code).filter(Code.code_set_id == set_id).update(
        {"code_set_id": None}, synchronize_session="fetch",
    )
    db.flush()
    _mark_stale(db, project_id, member_ids)
    db.delete(code_set)
    log_action(
        db, action="code_set_deleted", entity_type="code_set", entity_id=set_id,
        user_id=user.id, project_id=project_id,
        details={"label": code_set.label, "members": len(member_ids)},
    )
    db.commit()
    return {"deleted": True, "released_codes": len(member_ids)}


@router.post("/{set_id}/codes", response_model=CodeSetResponse)
def add_codes(
    project_id: int,
    set_id: int,
    data: CodeSetAddCodes,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _get_project_or_404(db, project_id, user.id)
    code_set = _get_set_or_404(db, project_id, set_id)
    codes = _codes_in_project(db, project_id, data.code_ids)
    # An already-present code is an idempotent re-add, and must not be judged
    # against the composition rule a second time.
    incoming = [c for c in codes if c.code_set_id != set_id]
    _assert_may_join(db, project_id, incoming, code_set)
    for code in incoming:
        code.code_set_id = set_id
    db.flush()
    _mark_stale(db, project_id, [c.id for c in incoming])
    log_action(
        db, action="code_set_codes_added", entity_type="code_set", entity_id=set_id,
        user_id=user.id, project_id=project_id,
        details={"code_ids": [c.id for c in incoming]},
    )
    db.commit()
    db.refresh(code_set)
    return _build_response(code_set, db)


@router.post("/{set_id}/codes/remove", response_model=CodeSetRemoveCodesResponse)
def remove_codes(
    project_id: int,
    set_id: int,
    data: CodeSetRemoveCodes,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove members. An emptied set is auto-dissolved (the `remove_columns` rule).

    ⚠️ The codes keep every application they carry — removing a value from a
    variable does not un-code the passages somebody judged with it.
    """
    _get_project_or_404(db, project_id, user.id)
    code_set = _get_set_or_404(db, project_id, set_id)
    codes = _codes_in_project(db, project_id, data.code_ids)
    removing = [c for c in codes if c.code_set_id == set_id]
    for code in removing:
        code.code_set_id = None
    db.flush()
    _mark_stale(db, project_id, [c.id for c in removing])

    remaining = db.query(Code).filter(Code.code_set_id == set_id).count()
    dissolved = remaining == 0
    if dissolved:
        db.delete(code_set)
    log_action(
        db, action="code_set_codes_removed", entity_type="code_set", entity_id=set_id,
        user_id=user.id, project_id=project_id,
        details={"code_ids": [c.id for c in removing], "dissolved": dissolved},
    )
    db.commit()
    if dissolved:
        return CodeSetRemoveCodesResponse(code_set=None, dissolved=True)
    db.refresh(code_set)
    return CodeSetRemoveCodesResponse(
        code_set=_build_response(code_set, db), dissolved=False,
    )
