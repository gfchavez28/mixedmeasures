"""Tier 3 crosswalk endpoints (Path A — #328 atomic move-members).

Cross-cutting endpoints that touch both `equivalence_groups` and
`analysis_domain_members` in one transaction. The move-members endpoint is
the canonical primitive behind drag-to-bracket and drag-to-unassigned — it
replaces the prior "drag updates EG only; domain membership lags" pattern
with one atomic gesture.

See the internal design notes (architecture) and
the internal design notes (move-members invariants) for the design.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from ..models.dataset import DatasetColumn
from ..models.equivalence_group import EquivalenceGroup
from ..models.metric import MetricDefinition
from ..models.user import User
from ..schemas.crosswalk import MoveMembersRequest, MoveMembersResponse
from ..services.audit import log_action
from ..services.equivalence_validators import (
    assert_columns_same_type,
    assert_cross_dataset_members_are_paired,
)
from ..services.metrics import compute_metric
from ..services.staleness import mark_metrics_stale

from .auth import limiter
from .equivalence import (
    _assert_columns_unique_per_dataset,
    _validate_columns_belong_to_project,
)
from .helpers import _get_project_or_404

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/projects/{project_id}/crosswalk",
    tags=["crosswalk"],
)


def _get_domain_or_404_in_project(
    db: Session, project_id: int, domain_id: int
) -> AnalysisDomain:
    """Local copy of analysis_domains._get_domain_or_404 to avoid an import cycle."""
    domain = (
        db.query(AnalysisDomain)
        .filter(
            AnalysisDomain.id == domain_id,
            AnalysisDomain.project_id == project_id,
        )
        .first()
    )
    if not domain:
        raise HTTPException(status_code=404, detail="Analysis domain not found")
    return domain


def _build_domain_response_or_none(
    db: Session, project_id: int, domain_id: Optional[int]
):
    """Reload a domain post-transaction and return its response shape, or None."""
    if domain_id is None:
        return None
    # Late import to avoid cycle (analysis_domains imports crosswalk-adjacent
    # services indirectly).
    from .analysis_domains import _build_domain_responses

    domain = (
        db.query(AnalysisDomain)
        .filter(
            AnalysisDomain.id == domain_id,
            AnalysisDomain.project_id == project_id,
        )
        .first()
    )
    if domain is None:
        return None
    return _build_domain_responses([domain], db)[0]


@router.post("/move-members", response_model=MoveMembersResponse)
@limiter.limit("60/minute")
async def move_members(
    request: Request,
    project_id: int,
    data: MoveMembersRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Atomic move-members endpoint (Path A, #328).

    In one transaction:
      1. Validate columns belong to the project (400 if any missing).
      2. Validate source/target domain ownership (404 if missing).
      3. Validate target EG exists if target_mode='existing_eg' (404).
      4. Short-circuit if every column is already in the target state
         (target_eg + target_domain).
      5. Capture original `equivalence_group_id` for each column.
      6. Phase A: nullify all columns' EG link (mirrors swap pattern; the
         #289 partial unique index allows NULLs, so this sidesteps the
         transient-collision case where a Phase B re-assignment would trip
         the index before the source side has been cleared).
      7. Phase B: assign the new EG (`existing_eg` / new EG created from
         `target_eg_label` / leave NULL for `strip`).
      8. Domain membership updates: delete source's `AnalysisDomainMember`
         rows for these columns; insert target's (skip duplicates).
      9. Post-mutation validators on target side: cross-dataset pairing
         (#290) + 1:1-per-dataset (#289).
     10. Source-EG cleanup: any previous EG that's now empty is auto-deleted.
     11. Mark metrics stale via `mark_metrics_stale(column_ids=...)`. The
         cascade reaches both source and target domain metrics + their
         statistical tests.
     12. Synchronous recompute of affected `domain_aggregate` metrics
         (mirrors swap; failures keep the metric stale, do not abort the
         move).
     13. Audit log + commit.

    Failure during any post-mutation validator raises HTTPException; the
    SQLAlchemy session rolls back atomically.

    Rate limited to 60/minute (mirrors swap; protects multi-select bulk drags).
    """
    _get_project_or_404(db, project_id, user.id)

    # ── 1. Validate columns belong to project ──────────────────────────
    columns = _validate_columns_belong_to_project(db, project_id, data.column_ids)
    columns_by_id: dict[int, DatasetColumn] = {c.id: c for c in columns}

    # ── 2. Validate source/target domain ownership ─────────────────────
    source_domain = (
        _get_domain_or_404_in_project(db, project_id, data.source_domain_id)
        if data.source_domain_id is not None
        else None
    )
    target_domain = (
        _get_domain_or_404_in_project(db, project_id, data.target_domain_id)
        if data.target_domain_id is not None
        else None
    )

    # ── 3. Resolve target EG (existence) ───────────────────────────────
    target_eg: Optional[EquivalenceGroup] = None
    if data.target_mode == "existing_eg":
        target_eg = (
            db.query(EquivalenceGroup)
            .filter(
                EquivalenceGroup.id == data.target_eg_id,
                EquivalenceGroup.project_id == project_id,
            )
            .first()
        )
        if target_eg is None:
            raise HTTPException(
                status_code=404,
                detail=f"Equivalence group {data.target_eg_id} not found in project",
            )

    # ── 4. Capture originals + short-circuit no-op ─────────────────────
    # For each column, record its current EG and whether it's in the
    # source domain. We process columns even if some are already in the
    # right place, but a global no-op (every column already in
    # (target_eg, target_domain)) returns immediately.
    original_eg_by_col: dict[int, Optional[int]] = {
        c.id: c.equivalence_group_id for c in columns
    }
    source_eg_ids: set[int] = {
        eg_id for eg_id in original_eg_by_col.values() if eg_id is not None
    }

    # Compute which target EG ID each column should land at.
    if data.target_mode == "existing_eg":
        target_eg_id_for_assignment: Optional[int] = data.target_eg_id
    elif data.target_mode == "new_eg":
        target_eg_id_for_assignment = None  # will be filled after creation
    else:  # 'strip'
        target_eg_id_for_assignment = None

    # Existing target_domain members (for short-circuit and dup-skip).
    existing_target_member_col_ids: set[int] = set()
    if target_domain is not None:
        existing_target_member_col_ids = {
            row[0]
            for row in (
                db.query(AnalysisDomainMember.member_id)
                .filter(
                    AnalysisDomainMember.domain_id == target_domain.id,
                    AnalysisDomainMember.member_type == "column",
                )
                .all()
            )
        }

    if (
        data.target_mode == "existing_eg"
        and data.source_domain_id == data.target_domain_id
        and target_domain is not None
        and all(
            original_eg_by_col[cid] == data.target_eg_id
            and cid in existing_target_member_col_ids
            for cid in data.column_ids
        )
    ):
        return MoveMembersResponse(
            source_domain=_build_domain_response_or_none(db, project_id, data.source_domain_id),
            target_domain=_build_domain_response_or_none(db, project_id, data.target_domain_id),
            dissolved_eg_ids=[],
            recomputed_metric_ids=[],
        )

    # ── 5. Phase A: nullify all columns' EG link ──────────────────────
    # The #289 partial unique index `ix_equivalence_unique_column_per_dataset`
    # blocks transient (eg_id, dataset_id) duplicates mid-flush. Phase A's
    # NULLs satisfy the partial index (which only covers WHERE eg_id IS NOT
    # NULL), so subsequent Phase B re-assignments don't collide. Same
    # rationale as `equivalence.py::swap_columns`.
    for col in columns:
        col.equivalence_group_id = None
    db.flush()

    # ── 6. Phase B: assign target EG ───────────────────────────────────
    if data.target_mode == "new_eg":
        new_eg = EquivalenceGroup(
            project_id=project_id,
            label=data.target_eg_label.strip() if data.target_eg_label else "",
            origin="human",
        )
        db.add(new_eg)
        db.flush()
        target_eg = new_eg
        target_eg_id_for_assignment = new_eg.id

    if target_eg_id_for_assignment is not None and target_eg is not None:
        # Use the ORM relationship setter for identity-map consistency
        # (mirrors `equivalence.py::swap_columns` Phase 2 / merge_groups).
        for col in columns:
            col.equivalence_group = target_eg
        db.flush()

    # ── 7. Domain membership updates ───────────────────────────────────
    # When source_domain_id == target_domain_id, the column stays in the
    # same variable group — only its equivalence link changes (handled by
    # Phase A/B above). Skipping the delete + re-insert avoids a subtle
    # bug where the dup-skip set (snapshotted pre-delete) caused already-
    # present members to be silently dropped from the domain. This is the
    # promote-to-paired-within-same-bracket case the researcher hits when
    # merging two synthetic single-cell rows of the same variable group.
    domain_membership_changes = data.source_domain_id != data.target_domain_id

    if domain_membership_changes and source_domain is not None:
        db.query(AnalysisDomainMember).filter(
            AnalysisDomainMember.domain_id == source_domain.id,
            AnalysisDomainMember.member_type == "column",
            AnalysisDomainMember.member_id.in_(data.column_ids),
        ).delete(synchronize_session="fetch")
        db.flush()

    if domain_membership_changes and target_domain is not None:
        max_order = (
            db.query(sa_func.max(AnalysisDomainMember.sequence_order))
            .filter(AnalysisDomainMember.domain_id == target_domain.id)
            .scalar()
        )
        next_order = (max_order or 0) + 1
        for cid in data.column_ids:
            if cid in existing_target_member_col_ids:
                continue
            db.add(AnalysisDomainMember(
                domain_id=target_domain.id,
                member_type="column",
                member_id=cid,
                sequence_order=next_order,
            ))
            next_order += 1
        db.flush()

    # ── 8. Post-mutation validators (target side) ──────────────────────
    # Cross-dataset pairing on target domain (#290). Validator imported at
    # module top from services/equivalence_validators.py.
    if target_domain is not None:
        target_member_col_ids = [
            row[0]
            for row in (
                db.query(AnalysisDomainMember.member_id)
                .filter(
                    AnalysisDomainMember.domain_id == target_domain.id,
                    AnalysisDomainMember.member_type == "column",
                )
                .all()
            )
        ]
        # Raises 409 cross_dataset_unpaired on failure → session rollback.
        assert_cross_dataset_members_are_paired(db, target_member_col_ids)

    # 1:1-per-dataset on the target EG (defense-in-depth; the partial unique
    # index would otherwise raise an opaque IntegrityError).
    if target_eg is not None:
        db.refresh(target_eg)
        _assert_columns_unique_per_dataset(list(target_eg.columns))

    # Type compatibility on target EG (mirror swap's same-type assertion;
    # only meaningful when the target EG ends up with ≥2 columns).
    if target_eg is not None and len(target_eg.columns) >= 2:
        assert_columns_same_type(list(target_eg.columns))

    # ── 9. Source-EG cleanup: dissolve emptied EGs ─────────────────────
    dissolved_eg_ids: list[int] = []
    for prev_eg_id in source_eg_ids:
        if prev_eg_id == target_eg_id_for_assignment:
            continue  # target EG; clearly not empty
        remaining = (
            db.query(DatasetColumn)
            .filter(DatasetColumn.equivalence_group_id == prev_eg_id)
            .count()
        )
        if remaining == 0:
            prev_eg = (
                db.query(EquivalenceGroup)
                .filter(
                    EquivalenceGroup.id == prev_eg_id,
                    EquivalenceGroup.project_id == project_id,
                )
                .first()
            )
            if prev_eg is not None:
                db.delete(prev_eg)
                dissolved_eg_ids.append(prev_eg_id)
    if dissolved_eg_ids:
        db.flush()

    # ── 10. Mark metrics stale ─────────────────────────────────────────
    # The cascade keys on column_ids and reaches both source and target
    # domain metrics + their statistical tests via the column→domain join.
    mark_metrics_stale(db, project_id, column_ids=list(data.column_ids))

    # ── 11. Synchronous metric recompute ───────────────────────────────
    affected_domain_ids: list[int] = []
    if source_domain is not None:
        affected_domain_ids.append(source_domain.id)
    if target_domain is not None and (target_domain.id != (source_domain.id if source_domain else None)):
        affected_domain_ids.append(target_domain.id)

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
        for metric in affected_metrics:
            try:
                compute_metric(db, metric)
                recomputed_metric_ids.append(metric.id)
            except Exception as exc:
                logger.warning(
                    "Failed to recompute metric %d (%s) after move-members: %s",
                    metric.id, metric.name, exc,
                )

    # ── 12. Audit log ──────────────────────────────────────────────────
    audit_entity_id = (
        target_domain.id if target_domain is not None
        else (source_domain.id if source_domain is not None else 0)
    )
    log_action(
        db,
        action="moved_members",
        entity_type="analysis_domain",
        entity_id=audit_entity_id,
        user_id=user.id,
        project_id=project_id,
        details={
            "column_ids": list(data.column_ids),
            "source_domain_id": data.source_domain_id,
            "target_domain_id": data.target_domain_id,
            "source_eg_ids": sorted(source_eg_ids),
            "target_eg_id": target_eg_id_for_assignment,
            "target_mode": data.target_mode,
            "dissolved_eg_ids": sorted(dissolved_eg_ids),
            "recomputed_metric_ids": sorted(recomputed_metric_ids),
        },
    )

    db.commit()

    # ── 13. Build response ─────────────────────────────────────────────
    return MoveMembersResponse(
        source_domain=_build_domain_response_or_none(db, project_id, data.source_domain_id),
        target_domain=_build_domain_response_or_none(db, project_id, data.target_domain_id),
        dissolved_eg_ids=sorted(dissolved_eg_ids),
        recomputed_metric_ids=sorted(recomputed_metric_ids),
    )
