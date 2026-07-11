"""Equivalence group endpoints for cross-dataset column equivalence."""

import json
from collections import defaultdict
from difflib import SequenceMatcher

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session, joinedload

from ..auth import get_current_user
from .auth import limiter
from ..database import get_db
from ..models.user import User
from ..models.dataset import Dataset, DatasetColumn, CROSSWALK_INELIGIBLE_TYPES
from ..models.analysis_domain import AnalysisDomainMember
from ..models.equivalence_group import EquivalenceGroup
from ..models.metric import MetricDefinition
from ..schemas.equivalence import (
    EquivalenceGroupCreate,
    EquivalenceGroupBulkCreate,
    EquivalenceGroupUpdate,
    EquivalenceGroupAddColumns,
    EquivalenceGroupRemoveColumns,
    EquivalenceGroupRemoveColumnsResponse,
    EquivalenceGroupReorderRequest,
    EquivalenceGroupSwapRequest,
    EquivalenceGroupSwapResponse,
    EquivalenceGroupColumnDefInfo,
    EquivalenceGroupColumnInfo,
    EquivalenceGroupResponse,
    EquivalenceGroupListResponse,
    BulkCreateResult,
    SuggestedGroup,
    SuggestedGroupColumn,
    EquivalenceSuggestResponse,
    FindMatchesRequest,
    ColumnMatchResult,
    FindMatchesResponse,
)
from ..services.equivalence_validators import (
    assert_columns_same_type,
    assert_columns_same_dataset,
    assert_columns_not_already_linked,
    assert_cross_dataset_members_are_paired,
    assert_domains_intact_after_mutation,
)
from ..services.metrics import compute_metric
from ..services.staleness import mark_metrics_stale
from ..services.audit import log_action
# Single-sourced text normalizer (extracted to services so J3-2b's code-merge
# triage shares the exact same fuzzy-match behavior — see text_similarity.py).
from ..services.text_similarity import normalize_text as _normalize_text

from .helpers import _get_project_or_404

router = APIRouter(
    prefix="/api/projects/{project_id}/equivalence-groups",
    tags=["equivalence"],
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_group_or_404(db: Session, project_id: int, group_id: int) -> EquivalenceGroup:
    group = (
        db.query(EquivalenceGroup)
        .filter(
            EquivalenceGroup.id == group_id,
            EquivalenceGroup.project_id == project_id,
        )
        .first()
    )
    if not group:
        raise HTTPException(status_code=404, detail="Equivalence group not found")
    return group


def _build_group_response(group: EquivalenceGroup, db: Session) -> EquivalenceGroupResponse:
    """Build response schema from an EquivalenceGroup, eager-loading columns + datasets."""
    columns = (
        db.query(DatasetColumn)
        .options(
            joinedload(DatasetColumn.dataset),
            joinedload(DatasetColumn.recode_definitions),
        )
        .filter(DatasetColumn.equivalence_group_id == group.id)
        .order_by(DatasetColumn.dataset_id, DatasetColumn.sequence_order)
        .all()
    )

    col_infos = []
    for col in columns:
        col_type = col.column_type.value
        scale_labels = None
        if col.scale_labels:
            try:
                scale_labels = json.loads(col.scale_labels)
            except (json.JSONDecodeError, TypeError):
                pass
        recode_defs = [
            EquivalenceGroupColumnDefInfo(
                id=d.id,
                name=d.name,
                recode_type=d.recode_type.value if hasattr(d.recode_type, 'value') else str(d.recode_type),
                is_primary=bool(d.is_primary),
            )
            for d in col.recode_definitions
        ]
        col_infos.append(EquivalenceGroupColumnInfo(
            id=col.id,
            dataset_id=col.dataset_id,
            dataset_name=col.dataset.name,
            column_code=col.column_code,
            column_text=col.column_text,
            column_type=col_type,
            scale_labels=scale_labels,
            scale_points=col.scale_points,
            recode_definitions=recode_defs,
        ))

    return EquivalenceGroupResponse(
        id=group.id,
        project_id=group.project_id,
        label=group.label,
        description=group.description,
        origin=group.origin,
        columns=col_infos,
        created_at=group.created_at,
        updated_at=group.updated_at,
    )


def _validate_columns_belong_to_project(
    db: Session, project_id: int, column_ids: list[int],
) -> list[DatasetColumn]:
    """Validate that all column_ids belong to datasets in this project."""
    if not column_ids:
        return []

    columns = (
        db.query(DatasetColumn)
        .join(Dataset)
        .filter(
            DatasetColumn.id.in_(column_ids),
            Dataset.project_id == project_id,
        )
        .all()
    )

    found_ids = {q.id for q in columns}
    missing = set(column_ids) - found_ids
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Columns not found in project: {sorted(missing)}",
        )

    return columns


def _assert_columns_unique_per_dataset(
    columns: list[DatasetColumn],
    existing_members: list[DatasetColumn] | None = None,
) -> None:
    """Raise 409 if ``columns`` (plus ``existing_members``) violate 1:1 per dataset.

    Used before assigning columns to an equivalence group. An equivalence group
    can contain at most one column per dataset — N-way equivalence across N
    datasets is valid, but multi-column-within-a-dataset is not. See #289 for
    rationale; the constraint is also enforced at the schema level by a partial
    unique index, so this check is primarily for friendly error messages.

    Args:
        columns: Columns being added to (or assigned to) the group.
        existing_members: Columns already in the target group, if any. For
            add_columns, pass ``group.columns``. For create_group, leave None.
    """
    all_cols = list(columns) + list(existing_members or [])
    seen: dict[int, int] = {}  # dataset_id -> first column_id encountered
    conflicts_by_dataset: dict[int, set[int]] = {}
    for col in all_cols:
        prior = seen.get(col.dataset_id)
        if prior is None:
            seen[col.dataset_id] = col.id
        elif prior != col.id:
            conflicts_by_dataset.setdefault(col.dataset_id, {prior}).add(col.id)

    if conflicts_by_dataset:
        conflicts = [
            {"dataset_id": ds_id, "column_ids": sorted(col_ids)}
            for ds_id, col_ids in conflicts_by_dataset.items()
        ]
        raise HTTPException(
            status_code=409,
            detail={
                "error": "duplicate_dataset",
                "message": "Each dataset can contribute at most one column per equivalence group.",
                "conflicts": conflicts,
            },
        )


# ── CRUD endpoints ───────────────────────────────────────────────────────────


@router.get("", response_model=EquivalenceGroupListResponse)
async def list_groups(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all equivalence groups for a project."""
    _get_project_or_404(db, project_id, user.id)

    groups = (
        db.query(EquivalenceGroup)
        .filter(EquivalenceGroup.project_id == project_id)
        .order_by(EquivalenceGroup.sequence_order.asc().nulls_last(), EquivalenceGroup.id)
        .all()
    )

    responses = [_build_group_response(g, db) for g in groups]
    return EquivalenceGroupListResponse(groups=responses, total=len(responses))


@router.post("", response_model=EquivalenceGroupResponse, status_code=201)
async def create_group(
    project_id: int,
    data: EquivalenceGroupCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create an equivalence group, optionally with initial column memberships."""
    _get_project_or_404(db, project_id, user.id)

    if data.column_ids:
        columns = _validate_columns_belong_to_project(db, project_id, data.column_ids)
        # #301: reject silent hijack of columns already linked to another EG.
        # No destination EG yet (we're creating one) → pass None.
        assert_columns_not_already_linked(db, columns, current_eg_id_to_ignore=None)
        _assert_columns_unique_per_dataset(columns)
        # #366: enforce the same-type invariant at creation, not only at swap.
        # A heterogeneous EG (e.g. Job_Level ordinal in one dataset, numeric in
        # another) is accepted by the partial-unique index but rejected by the
        # portability sanity check on import — i.e. you could build a project
        # that can't round-trip. Enforce here so the invariant holds everywhere.
        assert_columns_same_type(columns)
    else:
        columns = []

    group = EquivalenceGroup(
        project_id=project_id,
        label=data.label,
        description=data.description,
    )
    db.add(group)
    db.flush()

    # Assign columns to this group
    for col in columns:
        col.equivalence_group_id = group.id

    log_action(
        db,
        action="created",
        entity_type="equivalence_group",
        entity_id=group.id,
        user_id=user.id,
        project_id=project_id,
        details={"label": group.label, "column_count": len(columns)},
    )
    db.commit()
    db.refresh(group)

    return _build_group_response(group, db)


@router.post("/bulk", response_model=BulkCreateResult, status_code=201)
@limiter.limit("30/minute")
async def bulk_create_groups(
    request: Request,
    project_id: int,
    data: EquivalenceGroupBulkCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create multiple equivalence groups at once.

    Rate-limited 30/min (audit P7) — bulk endpoint, one request per Suggest
    accept. Pre-release hardening against runaway frontend loops.
    """
    _get_project_or_404(db, project_id, user.id)

    # Collect all column IDs for validation
    all_col_ids = []
    for g in data.groups:
        all_col_ids.extend(g.column_ids)

    if all_col_ids:
        all_cols = _validate_columns_belong_to_project(db, project_id, list(set(all_col_ids)))
        # Per-group checks: fail the entire batch on any violation. Match
        # the existing project-membership semantics (all-or-nothing).
        cols_by_id = {c.id: c for c in all_cols}
        for g_data in data.groups:
            group_cols = [cols_by_id[cid] for cid in g_data.column_ids if cid in cols_by_id]
            # #301: reject silent hijack — each group is being newly created,
            # so no destination EG exists yet (current_eg_id_to_ignore=None).
            assert_columns_not_already_linked(db, group_cols, current_eg_id_to_ignore=None)
            _assert_columns_unique_per_dataset(group_cols)
            assert_columns_same_type(group_cols)  # #366: same-type at creation

    created_groups = []
    for g_data in data.groups:
        group = EquivalenceGroup(
            project_id=project_id,
            label=g_data.label,
            description=g_data.description,
        )
        db.add(group)
        db.flush()

        if g_data.column_ids:
            db.query(DatasetColumn).filter(
                DatasetColumn.id.in_(g_data.column_ids),
            ).update(
                {DatasetColumn.equivalence_group_id: group.id},
                synchronize_session="fetch",
            )

        log_action(
            db,
            action="created",
            entity_type="equivalence_group",
            entity_id=group.id,
            user_id=user.id,
            project_id=project_id,
            details={"label": group.label, "column_count": len(g_data.column_ids)},
        )
        created_groups.append(group)

    db.commit()

    responses = [_build_group_response(g, db) for g in created_groups]
    return BulkCreateResult(created=len(responses), groups=responses)


@router.post("/reorder")
async def reorder_groups(
    project_id: int,
    data: EquivalenceGroupReorderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Reorder equivalence groups by updating sequence_order."""
    _get_project_or_404(db, project_id, user.id)

    for i, group_id in enumerate(data.group_ids):
        db.query(EquivalenceGroup).filter(
            EquivalenceGroup.id == group_id,
            EquivalenceGroup.project_id == project_id,
        ).update({"sequence_order": i}, synchronize_session="fetch")

    db.commit()
    return {"status": "ok"}


@router.patch("/{group_id}", response_model=EquivalenceGroupResponse)
async def update_group(
    project_id: int,
    group_id: int,
    data: EquivalenceGroupUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update an equivalence group's label or description."""
    _get_project_or_404(db, project_id, user.id)
    group = _get_group_or_404(db, project_id, group_id)

    if data.label is not None:
        group.label = data.label
    if data.description is not None:
        group.description = data.description

    log_action(
        db,
        action="updated",
        entity_type="equivalence_group",
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
    """Delete an equivalence group. Columns are unlinked (SET NULL), not deleted."""
    _get_project_or_404(db, project_id, user.id)
    group = _get_group_or_404(db, project_id, group_id)

    label = group.label

    # Capture column IDs before the unlink so we can validate affected domains.
    affected_column_ids = [c.id for c in group.columns]

    # Unlink columns
    db.query(DatasetColumn).filter(
        DatasetColumn.equivalence_group_id == group_id,
    ).update(
        {DatasetColumn.equivalence_group_id: None},
        synchronize_session="fetch",
    )

    db.flush()

    # #298: post-mutation domain validity. Deleting an EG can leave a
    # cross-dataset analysis domain with unpaired members. Validate before
    # commit so a failed check rolls back the unlink + delete atomically.
    assert_domains_intact_after_mutation(db, affected_column_ids)

    log_action(
        db,
        action="deleted",
        entity_type="equivalence_group",
        entity_id=group_id,
        user_id=user.id,
        project_id=project_id,
        details={"label": label},
    )

    db.delete(group)

    db.commit()

    return {"status": "ok", "deleted_id": group_id}


# ── Column membership endpoints ────────────────────────────────────────────


@router.post("/{group_id}/columns", response_model=EquivalenceGroupResponse)
@limiter.limit("60/minute")
async def add_columns(
    request: Request,
    project_id: int,
    group_id: int,
    data: EquivalenceGroupAddColumns,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Add columns to an equivalence group.

    Rate-limited 60/min (audit P7) — per-action endpoint, may fan out from
    multi-select bulk-assign flows. Matches `swap_columns` precedent.
    """
    _get_project_or_404(db, project_id, user.id)
    group = _get_group_or_404(db, project_id, group_id)

    columns = _validate_columns_belong_to_project(db, project_id, data.column_ids)

    # #301: reject silent hijack of columns already linked to a DIFFERENT EG.
    # A column already in this group is treated as an idempotent re-add (no 409).
    assert_columns_not_already_linked(db, columns, current_eg_id_to_ignore=group.id)

    # Enforce 1:1 per dataset: the union of new columns and existing members
    # must not contain two columns from the same dataset.
    existing_members = list(group.columns)
    _assert_columns_unique_per_dataset(columns, existing_members=existing_members)
    # #366: the union of new + existing members must share a single column_type.
    assert_columns_same_type(columns + existing_members)

    for col in columns:
        col.equivalence_group_id = group.id

    db.flush()

    log_action(
        db,
        action="columns_added",
        entity_type="equivalence_group",
        entity_id=group.id,
        user_id=user.id,
        project_id=project_id,
        details={"column_ids": data.column_ids},
    )
    db.commit()
    db.refresh(group)

    return _build_group_response(group, db)


@router.post("/{group_id}/columns/remove", response_model=EquivalenceGroupRemoveColumnsResponse)
@limiter.limit("60/minute")
async def remove_columns(
    request: Request,
    project_id: int,
    group_id: int,
    data: EquivalenceGroupRemoveColumns,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remove columns from an equivalence group (sets their group to NULL).

    Path A (#323): if removal empties the group, auto-delete it in the same
    transaction. The response indicates which path was taken via `dissolved`.
    """
    _get_project_or_404(db, project_id, user.id)
    group = _get_group_or_404(db, project_id, group_id)

    db.query(DatasetColumn).filter(
        DatasetColumn.id.in_(data.column_ids),
        DatasetColumn.equivalence_group_id == group_id,
    ).update(
        {DatasetColumn.equivalence_group_id: None},
        synchronize_session="fetch",
    )

    db.flush()

    # #298: post-mutation domain validity. Removing columns from an EG can
    # break a cross-dataset analysis domain that was relying on this EG to
    # bridge datasets. Validate before commit so a failed check rolls back
    # the unlink atomically. Runs before the dissolve check + log so
    # rejection unwinds the whole operation cleanly.
    assert_domains_intact_after_mutation(db, data.column_ids)

    remaining = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.equivalence_group_id == group_id)
        .count()
    )
    dissolved = remaining == 0

    log_action(
        db,
        action="columns_removed",
        entity_type="equivalence_group",
        entity_id=group.id,
        user_id=user.id,
        project_id=project_id,
        details={"column_ids": data.column_ids, "dissolved": dissolved},
    )

    if dissolved:
        db.delete(group)
        db.commit()
        return EquivalenceGroupRemoveColumnsResponse(group=None, dissolved=True)

    db.commit()
    db.refresh(group)
    return EquivalenceGroupRemoveColumnsResponse(
        group=_build_group_response(group, db),
        dissolved=False,
    )


# ── Tier 3 Swap endpoint (GAP 3.2 / Session B Task 1.2) ───────────────────


@router.post("/swap", response_model=EquivalenceGroupSwapResponse)
@limiter.limit("60/minute")
async def swap_columns(
    request: Request,
    project_id: int,
    data: EquivalenceGroupSwapRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Atomically exchange each pair's `equivalence_group_id`.

    Used by the Tier 3 crosswalk's drag-to-swap gesture. Each pair swaps the
    row assignments of two cells in the same dataset column — the user
    moving column A from row X to row Y while column B moves from row Y to
    row X.

    Validation order (all-or-nothing — any failure rejects the entire batch
    before any DB writes):
    - Both columns exist in the project
    - Both columns currently belong to some equivalence group
    - `assert_columns_same_type([a, b])` → 409 type_mismatch
    - `assert_columns_same_dataset([a, b])` → 400 cross_dataset
    - Post-swap 1:1-per-dataset invariant holds (defense-in-depth for the
      batched multi-pair case where intermediate states could interact)

    Staleness handling (GAP 3.13 Option A — default): after the swap,
    synchronously recompute all affected `domain_aggregate` metrics via
    the three-level join `swapped_columns → AnalysisDomainMember → domain
    → MetricDefinition`. If any compute fails, the swap itself is committed
    but the failed metric stays marked stale (recoverable via idempotent
    retry through create_score_metric or the Phase 6 manual recompute).

    Rate limited to 60/minute to accommodate bulk-assign loops while
    preventing runaway frontend chains.
    """
    _get_project_or_404(db, project_id, user.id)

    if not data.swaps:
        raise HTTPException(status_code=400, detail="No swaps provided")

    # Collect all column IDs across all swap pairs
    all_column_ids: list[int] = []
    for swap in data.swaps:
        all_column_ids.append(swap.column_id_a)
        all_column_ids.append(swap.column_id_b)

    # Validate all columns exist in the project (reuse existing helper;
    # raises 400 "Columns not found in project" if any are missing)
    columns = _validate_columns_belong_to_project(db, project_id, all_column_ids)
    columns_by_id: dict[int, DatasetColumn] = {c.id: c for c in columns}

    # Per-pair validation
    for swap in data.swaps:
        col_a = columns_by_id.get(swap.column_id_a)
        col_b = columns_by_id.get(swap.column_id_b)

        # Both columns must currently belong to SOME group (otherwise it's
        # an add, not a swap)
        if col_a.equivalence_group_id is None or col_b.equivalence_group_id is None:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "not_linked",
                    "message": "Both columns must belong to an equivalence group before swapping.",
                    "column_ids": [swap.column_id_a, swap.column_id_b],
                },
            )

        # Type match (409 type_mismatch) — validator raises HTTPException
        assert_columns_same_type([col_a, col_b])

        # Same dataset (400 cross_dataset) — validator raises HTTPException
        assert_columns_same_dataset([col_a, col_b])

    # Execute swaps via a three-phase null-intermediate pattern.
    #
    # **Why null-intermediate:** the #289 partial unique index
    # `ix_equivalence_unique_column_per_dataset` (on equivalence_group_id +
    # dataset_id, WHERE equivalence_group_id IS NOT NULL) blocks the
    # transient state where two same-dataset columns would briefly share a
    # group mid-swap. SQLAlchemy emits UPDATE statements serially at flush
    # time, so naïve `col_a.equivalence_group = group_b; col_b.equivalence_group = group_a`
    # hits the index after the first UPDATE lands and before the second runs.
    #
    # The partial index explicitly allows NULL `equivalence_group_id`, so
    # nullifying both columns first, flushing, then assigning the swapped
    # targets sidesteps the collision. This is an atomic swap at the
    # transaction level — if anything fails mid-phase, the caller's
    # transaction rolls back.
    #
    # The ORM relationship setter (`col.equivalence_group = group`) is
    # preferred for the final assignments — see merge_groups (equivalence.py:527-533)
    # for the passive_deletes identity-map rationale. For the null step we
    # can use either pattern; scalar assignment is simpler.
    groups_cache: dict[int, EquivalenceGroup] = {}
    def _load_group(gid: int) -> EquivalenceGroup:
        if gid not in groups_cache:
            groups_cache[gid] = db.query(EquivalenceGroup).filter(
                EquivalenceGroup.id == gid,
                EquivalenceGroup.project_id == project_id,
            ).first()
        return groups_cache[gid]

    # Capture original assignments before nullifying
    original_assignments: list[tuple[DatasetColumn, int, DatasetColumn, int]] = []
    swapped_column_ids: set[int] = set()
    affected_group_ids: set[int] = set()
    for swap in data.swaps:
        col_a = columns_by_id[swap.column_id_a]
        col_b = columns_by_id[swap.column_id_b]
        orig_a = col_a.equivalence_group_id
        orig_b = col_b.equivalence_group_id
        original_assignments.append((col_a, orig_a, col_b, orig_b))
        swapped_column_ids.add(col_a.id)
        swapped_column_ids.add(col_b.id)
        affected_group_ids.add(orig_a)
        affected_group_ids.add(orig_b)

    # Phase 1: nullify all swap targets (partial index ignores NULLs)
    for col_a, _, col_b, _ in original_assignments:
        col_a.equivalence_group_id = None
        col_b.equivalence_group_id = None
    db.flush()

    # Phase 2: assign swapped targets via the ORM relationship setter so
    # the identity map stays consistent (passive_deletes rationale).
    for col_a, orig_a, col_b, orig_b in original_assignments:
        col_a.equivalence_group = _load_group(orig_b)  # a → b's original
        col_b.equivalence_group = _load_group(orig_a)  # b → a's original
    db.flush()

    # Phase 2b — Membership swap (#336, audit B1, 2026-04-30 Batch B):
    # Atomically swap each pair's `AnalysisDomainMember` rows whenever the two
    # columns are members of different domains (symmetric difference). Without
    # this step, a cell-to-cell drag that crosses brackets exchanges EGs but
    # leaves the domain-membership rows pointing at the OLD brackets, producing
    # the "phantom cell" rendering bug — col_a's value contributes to the old
    # bracket's scale-score metric but visually appears in the new bracket.
    #
    # Algorithm (per pair):
    #   domains_only_a = {D : col_a ∈ D.members ∧ col_b ∉ D.members}
    #   domains_only_b = {D : col_b ∈ D.members ∧ col_a ∉ D.members}
    #   For D ∈ domains_only_a: replace col_a → col_b
    #   For D ∈ domains_only_b: replace col_b → col_a
    #
    # Domains containing BOTH cols (e.g. same-bracket swap) are no-ops.
    # Domains containing NEITHER are no-ops. The replacement is an UPDATE on
    # `member_id` rather than DELETE+INSERT, which (a) preserves
    # `sequence_order` so the row's display position is stable, and (b) avoids
    # transient violations of `uq_domain_member` in multi-pair batches.
    #
    # synchronize_session="fetch" is required because the cross-dataset
    # validator immediately below re-queries AnalysisDomainMember and must
    # see the post-update state.
    member_swaps_audit: list[dict] = []
    for col_a, _, col_b, _ in original_assignments:
        a_id = col_a.id
        b_id = col_b.id
        domains_with_a = {
            row[0] for row in
            db.query(AnalysisDomainMember.domain_id)
            .filter(
                AnalysisDomainMember.member_type == "column",
                AnalysisDomainMember.member_id == a_id,
            )
            .all()
        }
        domains_with_b = {
            row[0] for row in
            db.query(AnalysisDomainMember.domain_id)
            .filter(
                AnalysisDomainMember.member_type == "column",
                AnalysisDomainMember.member_id == b_id,
            )
            .all()
        }
        domains_only_a = sorted(domains_with_a - domains_with_b)
        domains_only_b = sorted(domains_with_b - domains_with_a)
        if domains_only_a:
            db.query(AnalysisDomainMember).filter(
                AnalysisDomainMember.domain_id.in_(domains_only_a),
                AnalysisDomainMember.member_type == "column",
                AnalysisDomainMember.member_id == a_id,
            ).update(
                {AnalysisDomainMember.member_id: b_id},
                synchronize_session="fetch",
            )
            for d in domains_only_a:
                member_swaps_audit.append({"domain_id": d, "removed_col": a_id, "added_col": b_id})
        if domains_only_b:
            db.query(AnalysisDomainMember).filter(
                AnalysisDomainMember.domain_id.in_(domains_only_b),
                AnalysisDomainMember.member_type == "column",
                AnalysisDomainMember.member_id == b_id,
            ).update(
                {AnalysisDomainMember.member_id: a_id},
                synchronize_session="fetch",
            )
            for d in domains_only_b:
                member_swaps_audit.append({"domain_id": d, "removed_col": b_id, "added_col": a_id})
    if member_swaps_audit:
        db.flush()

    # Post-swap #290 validation: the swap may have orphaned a cross-dataset
    # analysis domain member. If col_a was part of a cross-dataset domain
    # that required it to be equivalence-linked to col_c (in a different
    # dataset), and col_a just moved to a different equivalence group that
    # col_c isn't part of, then the domain now has unpaired cross-dataset
    # members — violating the invariant enforced at routers/analysis_domains.py
    # create/add_members paths AND at services/metrics.py::resolve_dataset_domain.
    #
    # Without this check, a valid swap at the equivalence-group layer can
    # silently break the domain layer, and the researcher discovers it only
    # when they try to compute a domain metric (which raises ValueError mid-
    # compute from _assert_domain_members_paired — exactly the "bypassed
    # validator" signal that function was designed to detect).
    #
    # Strategy: for each AnalysisDomain containing any swapped column,
    # re-run the pairing validator. If it raises 409 cross_dataset_unpaired,
    # let the exception propagate. Raising before db.commit() rolls back
    # the session — the swap is undone as an atomic unit. The validator now
    # lives in `services/equivalence_validators.py` (extracted from a former
    # router-level helper) and is imported at module top.

    post_swap_affected_domain_ids = [
        row[0] for row in
        db.query(AnalysisDomainMember.domain_id)
        .filter(
            AnalysisDomainMember.member_type == "column",
            AnalysisDomainMember.member_id.in_(list(swapped_column_ids)),
        )
        .distinct()
        .all()
    ]
    for domain_id in post_swap_affected_domain_ids:
        member_col_ids = [
            row[0] for row in
            db.query(AnalysisDomainMember.member_id)
            .filter(
                AnalysisDomainMember.domain_id == domain_id,
                AnalysisDomainMember.member_type == "column",
            )
            .all()
        ]
        # Raises HTTPException 409 cross_dataset_unpaired on failure. The
        # raise propagates up, db.commit() never runs, session rolls back,
        # and the swap is undone atomically. The test for this case is
        # test_swap_rejects_when_it_would_orphan_cross_dataset_domain.
        assert_cross_dataset_members_are_paired(db, member_col_ids)

    # Defense-in-depth post-swap 1:1 invariant check. For a single 2-column
    # same-dataset swap this is trivially satisfied (each group still has
    # one column per dataset, different columns swapped). For batched
    # multi-pair swaps, intermediate states could interact — this pass
    # catches any residual violation the DB-level partial unique index
    # would otherwise raise a confusing IntegrityError for.
    for gid in affected_group_ids:
        group = _load_group(gid)
        db.refresh(group)
        _assert_columns_unique_per_dataset(list(group.columns))

    # Mark metrics stale via the cascade helper (marks domain metrics for
    # any domain containing swapped columns, plus any StatisticalTests
    # targeting those metrics).
    mark_metrics_stale(db, project_id, column_ids=list(swapped_column_ids))

    # GAP 3.13 Option A — synchronous recompute of affected domain_aggregate
    # metrics via three-level join: swapped_columns → AnalysisDomainMember →
    # domain → MetricDefinition. A single swap can affect multiple metrics
    # because (a) a column can belong to multiple domains, and (b) each
    # domain can have multiple domain_aggregate variants (ungrouped + grouped).
    affected_domain_ids_rows = (
        db.query(AnalysisDomainMember.domain_id)
        .filter(
            AnalysisDomainMember.member_type == "column",
            AnalysisDomainMember.member_id.in_(list(swapped_column_ids)),
        )
        .distinct()
        .all()
    )
    affected_domain_ids = [row[0] for row in affected_domain_ids_rows]

    recomputed_metric_ids: list[int] = []
    if affected_domain_ids:
        affected_metrics = (
            db.query(MetricDefinition)
            .filter(
                MetricDefinition.project_id == project_id,
                MetricDefinition.metric_type == "domain_aggregate",
                MetricDefinition.input_source_type == "dataset_domain",
                MetricDefinition.input_source_id.in_(affected_domain_ids),
            )
            .all()
        )
        import logging as _logging
        _logger = _logging.getLogger(__name__)
        for metric in affected_metrics:
            try:
                compute_metric(db, metric)
                recomputed_metric_ids.append(metric.id)
            except Exception as exc:
                _logger.warning(
                    "Failed to recompute metric %d (%s) after swap: %s",
                    metric.id, metric.name, exc,
                )
                # Metric stays marked stale; swap itself is still committed.

    log_action(
        db,
        action="swapped",
        entity_type="equivalence_group",
        entity_id=next(iter(affected_group_ids)) if affected_group_ids else 0,
        user_id=user.id,
        project_id=project_id,
        details={
            "swapped_column_ids": sorted(swapped_column_ids),
            "affected_group_ids": sorted(affected_group_ids),
            "recomputed_metric_ids": sorted(recomputed_metric_ids),
            "pair_count": len(data.swaps),
            "member_swaps": member_swaps_audit,
        },
    )
    db.commit()

    # Build response with the updated groups
    updated_groups = []
    for gid in sorted(affected_group_ids):
        group = db.query(EquivalenceGroup).filter(
            EquivalenceGroup.id == gid,
            EquivalenceGroup.project_id == project_id,
        ).first()
        if group:
            updated_groups.append(_build_group_response(group, db))

    return EquivalenceGroupSwapResponse(
        updated_groups=updated_groups,
        recomputed_metric_ids=sorted(recomputed_metric_ids),
    )


# ── Merge endpoint ─────────────────────────────────────────────────────────


@router.post("/{group_id}/merge/{other_group_id}", response_model=EquivalenceGroupResponse)
async def merge_groups(
    project_id: int,
    group_id: int,
    other_group_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Merge other_group into group_id. Moves all columns, deletes other_group."""
    _get_project_or_404(db, project_id, user.id)
    target_group = _get_group_or_404(db, project_id, group_id)
    source_group = _get_group_or_404(db, project_id, other_group_id)

    if group_id == other_group_id:
        raise HTTPException(status_code=400, detail="Cannot merge a group with itself")

    # #301 hijack guard intentionally NOT applied here — merge is an explicit
    # consolidation operation; source columns moving from source_group_id to
    # target_group_id IS the operation's purpose. The 1:1 check below catches
    # any post-merge dataset conflict.
    _assert_columns_unique_per_dataset(
        list(target_group.columns),
        existing_members=list(source_group.columns),
    )
    # #366: the merged group must remain single-type. Merging two same-type EGs
    # is fine; merging across types would produce a group that can't round-trip.
    assert_columns_same_type(list(target_group.columns) + list(source_group.columns))

    # Move columns from source to target. We reassign via the ORM
    # relationship (`col.equivalence_group = target_group`) rather than
    # setting the FK scalar directly: the latter doesn't invalidate the
    # cached `equivalence_group` relationship on the column, which causes
    # SQLAlchemy to issue a phantom UPDATE back to the old source_group id
    # when the source is deleted later in the same transaction. Using the
    # relationship setter keeps the identity map consistent.
    source_columns = list(source_group.columns)
    moved_column_ids = [c.id for c in source_columns]
    for col in source_columns:
        col.equivalence_group = target_group
    db.flush()

    # #298: post-mutation domain validity. Merging EGs reassigns source
    # columns to target_group_id, which can break a cross-dataset analysis
    # domain that was relying on the source EG to bridge datasets. Validate
    # the union of moved columns + pre-existing target columns so we catch
    # any domain whose pairing structure changed. Validator raises 409
    # before mark_metrics_stale runs — the rollback would otherwise unwind
    # the staleness writes too, but short-circuiting cleanly avoids
    # polluting the transaction.
    target_column_ids = [c.id for c in target_group.columns]
    assert_domains_intact_after_mutation(db, moved_column_ids + target_column_ids)

    # Mark stale
    if moved_column_ids:
        mark_metrics_stale(db, project_id, column_ids=moved_column_ids)

    log_action(
        db,
        action="merged",
        entity_type="equivalence_group",
        entity_id=group_id,
        user_id=user.id,
        project_id=project_id,
        details={"merged_from": other_group_id, "columns_moved": len(moved_column_ids)},
    )

    db.delete(source_group)
    db.commit()
    db.refresh(target_group)

    return _build_group_response(target_group, db)


# ── Find matches endpoint ─────────────────────────────────────────────────


@router.post("/find-matches", response_model=FindMatchesResponse)
async def find_matches(
    project_id: int,
    data: FindMatchesRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Find cross-dataset column matches for the given column IDs.

    Two MUTUALLY EXCLUSIVE intents are supported (#300 Tier 2):

    1. **Explore mode** — source anchors all belong to ONE dataset. For each
       anchor, fuzzy-match its text against every non-anchor column in other
       datasets at or above ``min_similarity``. Emits only fuzzy candidates
       (``user_selected=False``).

    2. **Confirm mode** — source anchors span 2+ datasets (the user has
       already picked their cross-dataset pairs). For each anchor, any
       *other anchor* in a different dataset is surfaced as a guaranteed
       candidate (``user_selected=True``) with the actual text similarity
       score for the UI's confidence indicator. Fuzzy emission is
       SUPPRESSED entirely — no exploration noise.

    Mode is determined by the number of distinct datasets the loaded anchor
    columns belong to. This is independent from ``/analysis-domains/suggest``
    (the Suggest Groups button) which runs its own 3-pass clustering
    algorithm regardless of user selection.
    """
    _get_project_or_404(db, project_id, user.id)

    # Load anchor columns
    anchor_cols = (
        db.query(DatasetColumn)
        .join(Dataset)
        .filter(
            DatasetColumn.id.in_(data.column_ids),
            Dataset.project_id == project_id,
        )
        .all()
    )
    if not anchor_cols:
        return FindMatchesResponse(matches=[])

    anchor_id_set = {c.id for c in anchor_cols}
    anchor_dataset_ids = {c.dataset_id for c in anchor_cols}
    # Map: dataset_id -> list of anchor columns in that dataset (for user_selected lookups)
    anchors_by_dataset: dict[int, list[DatasetColumn]] = defaultdict(list)
    for c in anchor_cols:
        anchors_by_dataset[c.dataset_id].append(c)

    # ── Tier 2 mode gate (#300) ──
    # Single-dataset source → explore mode → fuzzy emission.
    # Multi-dataset source  → confirm mode → user_selected only, no fuzzy.
    # See the function docstring for the rationale — the mixed emission of
    # fuzzy noise alongside confirmed pairs was the source of the "10
    # sections instead of 5" UX bug in MappingDialog.
    is_confirm_mode = len(anchor_dataset_ids) >= 2

    # Load all non-skip, non-anchor columns in the project as the fuzzy candidate pool.
    # Anchors from *other* datasets are handled separately below (they bypass the
    # fuzzy threshold), so we exclude them here to avoid double-counting.
    # In confirm mode the fuzzy pool is unused, so skip the query entirely.
    fuzzy_candidates: list[DatasetColumn] = []
    if not is_confirm_mode:
        fuzzy_candidates_query = (
            db.query(DatasetColumn)
            .join(Dataset)
            .options(joinedload(DatasetColumn.dataset))
            .filter(Dataset.project_id == project_id)
        )
        if anchor_id_set:
            fuzzy_candidates_query = fuzzy_candidates_query.filter(
                ~DatasetColumn.id.in_(anchor_id_set)
            )
        # #556b: identifier columns are ineligible members, so never offer them
        # as match candidates (they'd land in an EG whose scale score can't
        # compute). Was a bare `!= "skip"`.
        fuzzy_candidates = [
            c for c in fuzzy_candidates_query.all()
            if c.column_type not in CROSSWALK_INELIGIBLE_TYPES
        ]

    threshold = data.min_similarity

    # Pre-load datasets for anchors so we can build user_selected results without
    # lazy-loading inside the loop.
    anchor_dataset_map: dict[int, Dataset] = {}
    if len(anchor_dataset_ids) > 1:
        ds_rows = (
            db.query(Dataset)
            .filter(Dataset.id.in_(anchor_dataset_ids))
            .all()
        )
        anchor_dataset_map = {ds.id: ds for ds in ds_rows}

    matches: list[ColumnMatchResult] = []
    for anchor in anchor_cols:
        anchor_norm = _normalize_text(anchor.column_text or "")
        # We still allow user_selected results even if anchor text is empty —
        # the user's explicit choice doesn't depend on text matching.

        # ── 1. User-selected candidates: other anchors from different datasets ──
        # Emit ALL qualifying candidates per (anchor, target_dataset) pair —
        # the previous per-dataset best-match collapse was removed in the
        # #290 follow-up because it prevented users from picking a different
        # pairing when the "best" suggestion was wrong. See #299
        # for the follow-up UX improvement (dropdown pattern).
        #
        # Canonical pair ordering: emit each unordered {a, b} pair only once,
        # in the direction where anchor.id < other_anchor.id. Without this,
        # every user-selected pair would be emitted both (a→b) and (b→a).
        #
        # Similarity: return the actual text similarity so the UI can show
        # it as a confidence indicator alongside the "Selected" badge. The
        # user can see at a glance whether their explicit pick is a good
        # match or dubious.
        for other_ds_id, other_anchors in anchors_by_dataset.items():
            if other_ds_id == anchor.dataset_id:
                continue  # same-dataset anchors are never paired
            for other_anchor in other_anchors:
                if other_anchor.column_type.value == "skip":
                    continue
                if other_anchor.id <= anchor.id:
                    continue  # canonical: emit each pair only once (lower id → higher id)
                already_linked = (
                    anchor.equivalence_group_id is not None
                    and other_anchor.equivalence_group_id is not None
                    and anchor.equivalence_group_id == other_anchor.equivalence_group_id
                )
                # Actual text similarity between anchor and this candidate
                if anchor_norm:
                    other_norm = _normalize_text(other_anchor.column_text or "")
                    sim = (
                        SequenceMatcher(None, anchor_norm, other_norm).ratio()
                        if other_norm else 0.0
                    )
                else:
                    sim = 0.0
                ds = anchor_dataset_map.get(other_ds_id)
                matches.append(ColumnMatchResult(
                    anchor_column_id=anchor.id,
                    target_column_id=other_anchor.id,
                    target_column_text=other_anchor.column_text or "",
                    target_column_code=other_anchor.column_code,
                    target_dataset_id=other_anchor.dataset_id,
                    target_dataset_name=ds.name if ds else "",
                    target_column_type=other_anchor.column_type.value,
                    similarity=round(sim, 3),
                    already_linked=already_linked,
                    user_selected=True,
                ))

        # ── 2. Fuzzy candidates: skipped entirely in confirm mode ──
        # Tier 2 (#300): when the user has picked anchors from 2+
        # datasets, they've already expressed the pairings they want — fuzzy
        # exploration produces noise (previously caused Board anchor sections
        # to fill with unrelated Self suggestions in the 5+5 scenario).
        # Explore mode (single-dataset source) continues to emit fuzzy
        # candidates across all other datasets at or above the threshold.
        if is_confirm_mode:
            continue
        if not anchor_norm:
            continue

        for target in fuzzy_candidates:
            # Skip same-dataset
            if target.dataset_id == anchor.dataset_id:
                continue

            target_norm = _normalize_text(target.column_text or "")
            if not target_norm:
                continue

            score = SequenceMatcher(None, anchor_norm, target_norm).ratio()
            if score < threshold:
                continue

            already_linked = (
                anchor.equivalence_group_id is not None
                and target.equivalence_group_id is not None
                and anchor.equivalence_group_id == target.equivalence_group_id
            )

            matches.append(ColumnMatchResult(
                anchor_column_id=anchor.id,
                target_column_id=target.id,
                target_column_text=target.column_text or "",
                target_column_code=target.column_code,
                target_dataset_id=target.dataset_id,
                target_dataset_name=target.dataset.name,
                target_column_type=target.column_type.value,
                similarity=round(score, 3),
                already_linked=already_linked,
                user_selected=False,
            ))

    # Sort: group by anchor (so the frontend can render section headers in a
    # stable order), then similarity desc so the best candidate per anchor
    # surfaces first. Under Tier 2, a given response is either all
    # user_selected (confirm mode) or all fuzzy (explore mode), so the
    # legacy user_selected-first tiebreaker is a no-op but kept for safety.
    matches.sort(key=lambda m: (0 if m.user_selected else 1, m.anchor_column_id, -m.similarity))

    return FindMatchesResponse(matches=matches)


# ── Suggest endpoint ────────────────────────────────────────────────────────


@router.get("/suggest", response_model=EquivalenceSuggestResponse)
async def suggest_groups(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Auto-suggest equivalence groups by matching column text and codes across datasets."""
    _get_project_or_404(db, project_id, user.id)

    # Load all ungrouped, non-skip columns across all datasets
    columns = (
        db.query(DatasetColumn)
        .join(Dataset)
        .filter(
            Dataset.project_id == project_id,
            DatasetColumn.equivalence_group_id.is_(None),
        )
        .options(joinedload(DatasetColumn.dataset))
        .all()
    )

    # Filter out types that can never be an EG member (#556b — skip + identifier)
    columns = [
        col for col in columns
        if col.column_type not in CROSSWALK_INELIGIBLE_TYPES
    ]

    if len(columns) < 2:
        return EquivalenceSuggestResponse(suggestions=[])

    # Build per-dataset column lists
    by_instrument: dict[int, list[DatasetColumn]] = defaultdict(list)
    for col in columns:
        by_instrument[col.dataset_id].append(col)

    # Need at least 2 instruments
    if len(by_instrument) < 2:
        return EquivalenceSuggestResponse(suggestions=[])

    suggestions: list[SuggestedGroup] = []
    used_col_ids: set[int] = set()

    def _col_to_suggestion(
        col: DatasetColumn,
        similarity_score: float | None = None,
    ) -> SuggestedGroupColumn:
        col_type = col.column_type.value
        return SuggestedGroupColumn(
            id=col.id,
            dataset_id=col.dataset_id,
            dataset_name=col.dataset.name,
            column_code=col.column_code,
            column_text=col.column_text,
            column_type=col_type,
            similarity_score=similarity_score,
        )

    # ── Pass 1: Exact text match (normalized) ──
    text_groups: dict[str, list[DatasetColumn]] = defaultdict(list)
    for col in columns:
        key = _normalize_text(col.column_text)
        if key:
            text_groups[key].append(col)

    for key, matched_cols in text_groups.items():
        # Must have columns from 2+ datasets
        inst_ids = {col.dataset_id for col in matched_cols}
        if len(inst_ids) < 2:
            continue

        # If ambiguous within one dataset (>1 column from same dataset), skip that dataset's extras
        deduped: list[DatasetColumn] = []
        seen_instruments: set[int] = set()
        for col in matched_cols:
            if col.dataset_id in seen_instruments:
                continue
            # Check if this dataset has multiple matches
            inst_count = sum(1 for c2 in matched_cols if c2.dataset_id == col.dataset_id)
            if inst_count > 1:
                continue  # Skip ambiguous dataset
            seen_instruments.add(col.dataset_id)
            deduped.append(col)

        if len(deduped) < 2:
            continue

        # Check for type mismatch
        types = {
            col.column_type.value
            for col in deduped
        }
        type_mismatch = len(types) > 1

        # Generate label from first column's text (truncated)
        label_text = deduped[0].column_text
        if len(label_text) > 60:
            label_text = label_text[:57] + "..."

        c_ids = [col.id for col in deduped]
        if any(cid in used_col_ids for cid in c_ids):
            continue

        suggestions.append(SuggestedGroup(
            label=label_text,
            match_type="exact_text",
            type_mismatch=type_mismatch,
            columns=[_col_to_suggestion(col) for col in deduped],
        ))
        used_col_ids.update(c_ids)

    # ── Pass 2: Column code match ──
    code_groups: dict[str, list[DatasetColumn]] = defaultdict(list)
    for col in columns:
        if col.id in used_col_ids:
            continue
        if col.column_code:
            code_key = col.column_code.strip().lower()
            if code_key:
                code_groups[code_key].append(col)

    for code_key, matched_cols in code_groups.items():
        inst_ids = {col.dataset_id for col in matched_cols}
        if len(inst_ids) < 2:
            continue

        # Deduplicate ambiguous datasets
        deduped: list[DatasetColumn] = []
        seen_instruments: set[int] = set()
        for col in matched_cols:
            if col.dataset_id in seen_instruments:
                continue
            inst_count = sum(1 for c2 in matched_cols if c2.dataset_id == col.dataset_id)
            if inst_count > 1:
                continue
            seen_instruments.add(col.dataset_id)
            deduped.append(col)

        if len(deduped) < 2:
            continue

        types = {
            col.column_type.value
            for col in deduped
        }
        type_mismatch = len(types) > 1

        label_text = deduped[0].column_text
        if len(label_text) > 60:
            label_text = label_text[:57] + "..."

        c_ids = [col.id for col in deduped]
        if any(cid in used_col_ids for cid in c_ids):
            continue

        suggestions.append(SuggestedGroup(
            label=f"[{code_key.upper()}] {label_text}",
            match_type="code_match",
            type_mismatch=type_mismatch,
            columns=[_col_to_suggestion(col) for col in deduped],
        ))
        used_col_ids.update(c_ids)

    # ── Pass 3: Fuzzy text matching ──
    SIMILARITY_THRESHOLD = 0.7
    norm_texts: dict[int, str] = {}

    remaining = [col for col in columns if col.id not in used_col_ids]
    remaining_instruments = {col.dataset_id for col in remaining}

    if len(remaining) >= 2 and len(remaining_instruments) >= 2:
        # Pre-compute normalized text for remaining columns
        for col in remaining:
            norm_texts[col.id] = _normalize_text(col.column_text)

        # Build lookup by id
        col_by_id: dict[int, DatasetColumn] = {col.id: col for col in remaining}

        # Compute pairwise similarity across datasets (never within same dataset)
        pairs: list[tuple[float, int, int]] = []
        for i in range(len(remaining)):
            for j in range(i + 1, len(remaining)):
                ci, cj = remaining[i], remaining[j]
                if ci.dataset_id == cj.dataset_id:
                    continue
                ti, tj = norm_texts[ci.id], norm_texts[cj.id]
                if not ti or not tj:
                    continue
                score = SequenceMatcher(None, ti, tj).ratio()
                if score >= SIMILARITY_THRESHOLD:
                    pairs.append((score, ci.id, cj.id))

        # Sort by score descending
        pairs.sort(key=lambda x: -x[0])

        # Greedy grouping
        fuzzy_used: set[int] = set()
        fuzzy_groups: list[tuple[list[int], float]] = []  # (member_ids, min_score)

        for score, id_a, id_b in pairs:
            if id_a in fuzzy_used or id_b in fuzzy_used:
                continue
            fuzzy_groups.append(([id_a, id_b], score))
            fuzzy_used.add(id_a)
            fuzzy_used.add(id_b)

        # Extension pass: try adding unused columns to each group
        for group_idx, (member_ids, min_score) in enumerate(fuzzy_groups):
            group_datasets = {col_by_id[mid].dataset_id for mid in member_ids}
            for col in remaining:
                if col.id in fuzzy_used:
                    continue
                if col.dataset_id in group_datasets:
                    continue  # One column per dataset per group
                # Check similarity to ALL existing members
                min_pair_score = 1.0
                all_above = True
                for mid in member_ids:
                    s = SequenceMatcher(None, norm_texts[col.id], norm_texts[mid]).ratio()
                    if s < SIMILARITY_THRESHOLD:
                        all_above = False
                        break
                    min_pair_score = min(min_pair_score, s)
                if all_above:
                    member_ids.append(col.id)
                    group_datasets.add(col.dataset_id)
                    fuzzy_used.add(col.id)
                    fuzzy_groups[group_idx] = (member_ids, min(min_score, min_pair_score))

        # Emit fuzzy suggestions
        for member_ids, min_score in fuzzy_groups:
            deduped_cols = [col_by_id[mid] for mid in member_ids]
            # Must have 2+ datasets
            inst_ids = {col.dataset_id for col in deduped_cols}
            if len(inst_ids) < 2:
                continue

            types = {col.column_type.value for col in deduped_cols}
            type_mismatch = len(types) > 1

            label_text = deduped_cols[0].column_text
            if len(label_text) > 60:
                label_text = label_text[:57] + "..."

            # Near-exact matches (≥0.95) are effectively exact text — label accordingly
            effective_type = "exact_text" if min_score >= 0.95 else "similar_text"

            suggestions.append(SuggestedGroup(
                label=label_text,
                match_type=effective_type,
                type_mismatch=type_mismatch,
                similarity_score=round(min_score, 2) if effective_type == "similar_text" else None,
                columns=[_col_to_suggestion(col) for col in deduped_cols],
            ))
            used_col_ids.update(member_ids)

    # ── Pass 4: Attach remaining columns to existing groups (fuzzy) ──
    # Columns still ungrouped may be fuzzy-close to groups formed in Pass 1/2/3.
    still_remaining = [col for col in columns if col.id not in used_col_ids]
    if still_remaining and suggestions:
        # Ensure we have normalized text for all columns (including grouped ones)
        for col in columns:
            if col.id not in norm_texts:
                norm_texts[col.id] = _normalize_text(col.column_text)

        for sg in suggestions:
            sg_datasets = {sq.dataset_id for sq in sg.columns}
            sg_col_ids = [sq.id for sq in sg.columns]

            for col in still_remaining:
                if col.id in used_col_ids:
                    continue
                if col.dataset_id in sg_datasets:
                    continue  # One column per dataset per group

                col_norm = norm_texts.get(col.id, "")
                if not col_norm:
                    continue

                # Check similarity to ALL existing group members
                min_score = 1.0
                all_above = True
                for member_id in sg_col_ids:
                    member_norm = norm_texts.get(member_id, "")
                    if not member_norm:
                        all_above = False
                        break
                    s = SequenceMatcher(None, col_norm, member_norm).ratio()
                    if s < SIMILARITY_THRESHOLD:
                        all_above = False
                        break
                    min_score = min(min_score, s)

                if all_above:
                    sg.columns.append(
                        _col_to_suggestion(col, similarity_score=round(min_score, 2))
                    )
                    sg_datasets.add(col.dataset_id)
                    sg_col_ids.append(col.id)
                    used_col_ids.add(col.id)

                    # Update type_mismatch for the group
                    types = {sq.column_type for sq in sg.columns}
                    sg.type_mismatch = len(types) > 1

                    # Update group-level similarity_score to the minimum
                    if sg.similarity_score is not None:
                        sg.similarity_score = round(
                            min(sg.similarity_score, min_score), 2
                        )

    return EquivalenceSuggestResponse(suggestions=suggestions)
