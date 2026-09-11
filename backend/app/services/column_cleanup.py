"""What must be removed when a dataset column stops existing (#923).

🔴 **Extracted because there were already TWO copies and the reap was about to be
a third.** `routers/dataset.py::delete_manual_column` carried this cleanup inline
and `_cascade_delete_column_refs` carried a verbatim duplicate for the computed
column path — same six steps in the same order, differing only in a local
variable name. `services/participant_scores.py::sync_score_columns` then reaped a
managed score column with a bare `db.delete(column)` and none of this, so a saved
chart on that column survived it pointing at an id that no longer existed and
`compute_metric` raised `ValueError: Dataset column N not found in project`.

A `MetricDefinition` names its column through `input_source_id`, which is
**polymorphic and carries no ForeignKey** (`models/metric.py`), so no database
cascade can do this — the deletion of the references has to be written, and every
path that deletes a column has to call it.

## `validate_domains` has no default, deliberately

The last step of the router's cleanup asserts that no surviving cross-dataset
`AnalysisDomain` was left unpaired (#298/#290) and raises **409
`cross_dataset_unpaired`**, which rolls the transaction back. That is right for a
researcher deleting a column: they asked for this one thing, and being told why it
cannot happen is an answer.

It is wrong for the participant table's reap. There the column is removed as a
CONSEQUENCE of something already done elsewhere (a code was deleted), discovered
when the table is next refreshed — so a 409 would abort the whole refresh,
leaving every OTHER score stale, over a domain the researcher did not touch in
that action. `refresh_participant_dataset` is also called by the create endpoint.
The documented second layer covers the state instead:
`metrics.py::_assert_domain_members_paired` fires at compute time for any domain
that has become unpaired (the internal design notes "Cross-cutting observations" 1).

So the parameter is **keyword-only with no default**, the shape
`tests/guard_support.py::app_files(floor=)` uses: a third caller has to decide
rather than inherit whichever choice happened to be first.

⚠️ **NOT folded in: `delete_dataset`'s own cascade** (`routers/dataset.py`, E2 in
the mutation catalog). It is the same six steps over a SET of columns scoped to a
dataset, and collapsing the two shapes is a wider change than this one needs.
"""
from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from ..models.dataset import DatasetColumn
from ..models.equivalence_group import EquivalenceGroup
from ..models.metric import MetricDefinition
from ..models.statistical_test import StatisticalTest
from .equivalence_validators import assert_domains_intact_for_domain_ids


def delete_column_references(
    db: Session,
    project_id: int,
    column_id: int,
    *,
    validate_domains: bool,
) -> int:
    """Delete everything that names this column, and return how many saved
    metrics went with it.

    Does NOT delete the column — the caller owns that, and owns the transaction.

    The metric count is returned because a metric is the one thing here a
    researcher can SEE: it is a chart or a test they set up and will look for
    again. Domain members and empty equivalence groups are structure they did not
    author directly.

    Order is load-bearing and unchanged from the router's original:
    capture the affected domain ids BEFORE the member rows are deleted (the
    column-driven validator cannot find them afterwards), validate AFTER the
    member + group cleanup but BEFORE empty domains are pruned.
    """
    affected_domain_ids = [
        r[0] for r in
        db.query(AnalysisDomainMember.domain_id)
        .filter(
            AnalysisDomainMember.member_type == "column",
            AnalysisDomainMember.member_id == column_id,
        )
        .distinct()
        .all()
    ]

    db.query(AnalysisDomainMember).filter(
        AnalysisDomainMember.member_type == "column",
        AnalysisDomainMember.member_id == column_id,
    ).delete(synchronize_session="fetch")

    col_metric_ids = [
        r[0] for r in db.query(MetricDefinition.id).filter(
            MetricDefinition.input_source_type == "dataset_column",
            MetricDefinition.input_source_id == column_id,
        ).all()
    ]
    if col_metric_ids:
        db.query(StatisticalTest).filter(
            StatisticalTest.target_type == "metric_definition",
            StatisticalTest.target_id.in_(col_metric_ids),
        ).delete(synchronize_session="fetch")

    db.query(MetricDefinition).filter(
        MetricDefinition.input_source_type == "dataset_column",
        MetricDefinition.input_source_id == column_id,
    ).delete(synchronize_session="fetch")

    empty_group_ids = [
        g.id for g in
        db.query(EquivalenceGroup)
        .outerjoin(DatasetColumn, DatasetColumn.equivalence_group_id == EquivalenceGroup.id)
        .filter(EquivalenceGroup.project_id == project_id)
        .group_by(EquivalenceGroup.id)
        .having(func.count(DatasetColumn.id) == 0)
        .all()
    ]
    if empty_group_ids:
        db.query(EquivalenceGroup).filter(
            EquivalenceGroup.id.in_(empty_group_ids),
        ).delete(synchronize_session="fetch")

    db.flush()
    if validate_domains:
        assert_domains_intact_for_domain_ids(db, affected_domain_ids)

    empty_domain_ids = [
        d.id for d in
        db.query(AnalysisDomain)
        .outerjoin(AnalysisDomainMember)
        .filter(AnalysisDomain.project_id == project_id)
        .group_by(AnalysisDomain.id)
        .having(func.count(AnalysisDomainMember.id) == 0)
        .all()
    ]
    if empty_domain_ids:
        db.query(AnalysisDomain).filter(
            AnalysisDomain.id.in_(empty_domain_ids),
        ).delete(synchronize_session="fetch")

    return len(col_metric_ids)
