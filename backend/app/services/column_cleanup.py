"""What must be removed when dataset columns stop existing (#923, #1168, #1175).

🔴 **ONE cascade for every column delete — a variable, a computed variable, a
whole dataset, a reaped score column.** It began as TWO verbatim copies in
`routers/dataset.py` (#923 folded those here) while `delete_dataset` kept a THIRD,
plural copy of the same six steps. The saved-statistics batch (2026-10-10) had to
change all of them the same three ways, so the dataset delete was folded in too
rather than edited twice (#733: a copy propagates a defect verbatim).

A `MetricDefinition` names its column through `input_source_id`, which is
**polymorphic and carries no ForeignKey** (`models/metric.py`), so no database
cascade can do this — the deletion of the references has to be written, and every
path that deletes a column has to call it.

## Plan, then apply (#1175)

`plan_column_removal` works out everything the delete will do, reading only.
`delete_column_references` computes that plan and executes IT — so the delete
confirmations, which read the plan through a GET, name exactly what the click
removes (#795: a preview computed by other code than the act can be wrong).

## What the batch changed (#1168 doors 2–3, #1173)

- **A metric GROUPED by a removed column is removed, with its tests** (plan
  decision 1). Its `grouping_column_id` is `ON DELETE SET NULL`, and that column is
  part of the metric's identity key (`metrics.py::_normalize_metric_key`), so the
  database used to turn a grouped chart into one indistinguishable from the
  ungrouped chart of the same variable — and quick compute then served the old
  per-group results, un-stale, for the ungrouped request.
- **A surviving variable group that loses a member is marked stale** — its scale
  score kept pooling the removed items. So are grouped variable-group metrics that
  used a removed column as a SIBLING grouping column.
- **An emptied variable group goes with its metrics and tests.** The column path
  deleted the group and orphaned them (computing one raised "not found").
- **A removed column's own equivalence group is dissolved** (#1173): links are
  nulled before the empty-group sweep, which used to run while the column still
  held its link.

## `validate_domains` has no default, deliberately

A delete that would leave a surviving cross-dataset `AnalysisDomain` unpaired
(#298/#290) is refused with **409 `cross_dataset_unpaired`** — right for a
researcher deleting a variable or dataset: they asked for this one thing, and
being told why it cannot happen is an answer. Since #1175 the refusal is decided
by the plan, before anything is written.

It is wrong for the participant table's reap. There the column is removed as a
CONSEQUENCE of something already done elsewhere (a code was deleted), discovered
when the table is next refreshed — so a 409 would abort the whole refresh, leaving
every OTHER score stale, over a domain the researcher did not touch in that
action. `metrics.py::_assert_domain_members_paired` fires at compute time instead
(the internal design notes "Cross-cutting observations" 1).

So the parameter is **keyword-only with no default**, the shape
`tests/guard_support.py::app_files(floor=)` uses: a new caller has to decide
rather than inherit whichever choice happened to be first.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from ..models.dataset import DatasetColumn
from ..models.equivalence_group import EquivalenceGroup
from ..models.metric import MetricDefinition
from ..models.statistical_test import StatisticalTest
from .equivalence_validators import assert_domains_intact_for_domain_ids
from .staleness import mark_metrics_stale


@dataclass
class ColumnRemovalPlan:
    """Everything a delete of ``column_ids`` will do. Read-only to build."""

    column_ids: list[int]
    #: Metrics whose input is a removed column.
    input_metric_ids: list[int] = field(default_factory=list)
    #: Metrics GROUPED by a removed column (and not already removed by input).
    grouping_metric_ids: list[int] = field(default_factory=list)
    #: Variable groups holding a removed column that SURVIVE — recalculated.
    recalculated_domain_ids: list[int] = field(default_factory=list)
    #: Variable groups left with no member — removed, with their metrics and tests.
    emptied_domain_ids: list[int] = field(default_factory=list)
    emptied_domain_metric_ids: list[int] = field(default_factory=list)
    #: Every statistical test the delete removes.
    test_ids: list[int] = field(default_factory=list)
    #: Equivalence groups left with no column — dissolved.
    dissolved_group_ids: list[int] = field(default_factory=list)
    #: The 409 the delete would raise (a surviving group left unpaired), or None.
    refusal: HTTPException | None = None

    @property
    def removed_metric_ids(self) -> list[int]:
        return sorted(
            set(self.input_metric_ids)
            | set(self.grouping_metric_ids)
            | set(self.emptied_domain_metric_ids)
        )


def plan_column_removal(
    db: Session, project_id: int, column_ids,
) -> ColumnRemovalPlan:
    """What deleting these columns would remove, recalculate or refuse.

    Reads only — the removal-plan GETs call it for the delete confirmations, and
    `delete_column_references` executes exactly what it returns.
    """
    ids = sorted({int(c) for c in column_ids})
    plan = ColumnRemovalPlan(column_ids=ids)
    if not ids:
        return plan
    removed = set(ids)

    plan.input_metric_ids = [
        r[0] for r in db.query(MetricDefinition.id).filter(
            MetricDefinition.input_source_type == "dataset_column",
            MetricDefinition.input_source_id.in_(ids),
        ).all()
    ]
    by_input = set(plan.input_metric_ids)
    plan.grouping_metric_ids = [
        r[0] for r in db.query(MetricDefinition.id).filter(
            or_(
                MetricDefinition.grouping_column_id.in_(ids),
                MetricDefinition.grouping_column_id_2.in_(ids),
            ),
        ).all()
        if r[0] not in by_input
    ]

    # Every variable group in the project, with its members — a project holds a
    # handful, and the empty-group rule below needs them all (as before the fold,
    # a group that was ALREADY empty is swept with the delete).
    members: dict[int, set[int]] = {
        d_id: set() for (d_id,) in
        db.query(AnalysisDomain.id).filter(AnalysisDomain.project_id == project_id).all()
    }
    for d_id, member_id in (
        db.query(AnalysisDomainMember.domain_id, AnalysisDomainMember.member_id)
        .join(AnalysisDomain, AnalysisDomain.id == AnalysisDomainMember.domain_id)
        .filter(
            AnalysisDomain.project_id == project_id,
            AnalysisDomainMember.member_type == "column",
        )
        .all()
    ):
        members[d_id].add(member_id)
    affected = sorted(d for d, cols in members.items() if cols & removed)
    plan.emptied_domain_ids = sorted(d for d, cols in members.items() if not (cols - removed))
    emptied = set(plan.emptied_domain_ids)
    plan.recalculated_domain_ids = [d for d in affected if d not in emptied]

    if plan.emptied_domain_ids:
        plan.emptied_domain_metric_ids = [
            r[0] for r in db.query(MetricDefinition.id).filter(
                MetricDefinition.input_source_type == "dataset_domain",
                MetricDefinition.input_source_id.in_(plan.emptied_domain_ids),
            ).all()
        ]

    test_filters = []
    metric_ids = plan.removed_metric_ids
    if metric_ids:
        test_filters.append(
            (StatisticalTest.target_type == "metric_definition")
            & StatisticalTest.target_id.in_(metric_ids)
        )
    if plan.emptied_domain_ids:
        test_filters.append(
            (StatisticalTest.target_type == "analysis_domain")
            & StatisticalTest.target_id.in_(plan.emptied_domain_ids)
        )
    if test_filters:
        plan.test_ids = sorted(
            r[0] for r in db.query(StatisticalTest.id).filter(or_(*test_filters)).all()
        )

    # The removed columns' links are nulled first, so a group survives only if a
    # column OUTSIDE the delete still holds it (#1173).
    group_ids = [
        g_id for (g_id,) in
        db.query(EquivalenceGroup.id).filter(EquivalenceGroup.project_id == project_id).all()
    ]
    holding: set[int] = set()
    if group_ids:
        holding = {
            r[0] for r in
            db.query(DatasetColumn.equivalence_group_id)
            .filter(
                DatasetColumn.equivalence_group_id.in_(group_ids),
                DatasetColumn.id.notin_(ids),
            )
            .distinct()
            .all()
        }
    plan.dissolved_group_ids = sorted(g for g in group_ids if g not in holding)

    try:
        assert_domains_intact_for_domain_ids(
            db, plan.recalculated_domain_ids, excluding_column_ids=ids,
        )
    except HTTPException as exc:
        plan.refusal = exc
    return plan


def delete_column_references(
    db: Session,
    project_id: int,
    column_ids,
    *,
    validate_domains: bool,
) -> ColumnRemovalPlan:
    """Delete everything that names these columns, and return the plan it ran.

    Does NOT delete the columns — the caller owns that, and owns the transaction.

    The order is load-bearing:
      1. plan, and refuse (409) before anything is written;
      2. mark stale what will survive — the groups losing a member and the
         grouped metrics using a removed column as a sibling — while the
         memberships and links the marker joins through still exist;
      3. null the removed columns' equivalence links (#1173);
      4. delete their memberships;
      5. delete the metrics on them or grouped by them, with their tests;
      6. dissolve the equivalence groups left empty;
      7. delete the emptied variable groups, with their metrics and tests.
    """
    plan = plan_column_removal(db, project_id, column_ids)
    if not plan.column_ids:
        return plan
    if validate_domains and plan.refusal is not None:
        raise plan.refusal
    ids = plan.column_ids

    db.flush()
    mark_metrics_stale(db, project_id, column_ids=ids)

    db.query(DatasetColumn).filter(
        DatasetColumn.id.in_(ids),
        DatasetColumn.equivalence_group_id.isnot(None),
    ).update({DatasetColumn.equivalence_group_id: None}, synchronize_session="fetch")

    db.query(AnalysisDomainMember).filter(
        AnalysisDomainMember.member_type == "column",
        AnalysisDomainMember.member_id.in_(ids),
    ).delete(synchronize_session="fetch")

    if plan.test_ids:
        db.query(StatisticalTest).filter(
            StatisticalTest.id.in_(plan.test_ids),
        ).delete(synchronize_session="fetch")
    if plan.removed_metric_ids:
        db.query(MetricDefinition).filter(
            MetricDefinition.id.in_(plan.removed_metric_ids),
        ).delete(synchronize_session="fetch")

    if plan.dissolved_group_ids:
        db.query(EquivalenceGroup).filter(
            EquivalenceGroup.id.in_(plan.dissolved_group_ids),
        ).delete(synchronize_session="fetch")

    if plan.emptied_domain_ids:
        db.query(AnalysisDomain).filter(
            AnalysisDomain.id.in_(plan.emptied_domain_ids),
        ).delete(synchronize_session="fetch")
    db.flush()
    return plan
