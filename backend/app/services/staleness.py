"""Staleness tracking for computed metrics and statistical tests.

When underlying data changes (recode edits, value edits, domain membership changes),
affected MetricDefinition and StatisticalTest rows are marked stale so the UI can
prompt recomputation.

🔴 **Quick compute serves a stored result whenever its metric is not `stale`**
(`routers/metrics.py`), so a door that moves a metric's input and does not call a
marker here leaves a wrong number on screen with no warning (#1168: eight such
doors, enumerated 2026-10-10). `tests/test_metric_staleness_doors.py` derives the
doors that write cells or rows and fails when one reaches no marker.

⚠️ **Mark where the input actually moves, and only what can have moved.** The
opposite fault is real too (#1149): a marker on a number that cannot have changed
trains researchers to ignore the marker. So a membership edit marks the group's
OWN metrics and tests, never its member columns' metrics, and a metadata edit marks
only the grouped metrics whose grouping columns it actually changed.
"""

import json as _json
from collections import defaultdict

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models.dataset import DatasetColumn, Dataset
from ..models.metric import MetricDefinition
from ..models.statistical_test import StatisticalTest
from ..models.analysis_domain import AnalysisDomainMember


def mark_metric_tests_stale(db: Session, metric_ids) -> int:
    """Mark the statistical tests that target these metrics stale (#1039 a).

    🔴 **A metric whose numbers may have moved takes its tests with it.** A t-test
    or ANOVA saved against a metric was computed from what the metric described,
    so when the metric is out of date the test is too. `mark_metrics_stale` below
    cascades for every metric it marks; three doors did not — an edit to a
    metric's definition, the `.mmproject` import, and every recompute but the
    single-metric button — so a test could keep a result computed from data or
    settings that had changed, with no amber marker. The ONE place the cascade is
    written, so a door that stales a metric reaches the tests by calling it.

    Returns how many tests it marked.
    """
    ids = sorted({int(i) for i in metric_ids})
    if not ids:
        return 0
    return (
        db.query(StatisticalTest)
        .filter(
            StatisticalTest.target_type == "metric_definition",
            StatisticalTest.target_id.in_(ids),
            StatisticalTest.stale == False,  # noqa: E712
        )
        .update({"stale": True}, synchronize_session="fetch")
    )


def mark_metrics_stale(
    db: Session,
    project_id: int,
    column_ids: list[int] | None = None,
    domain_ids: list[int] | None = None,
) -> int:
    """Mark metrics stale that depend on the given columns or domains.

    ``column_ids`` is for a door that moved CELLS (or a column's meaning): it
    reaches the metrics on those columns, grouped by them — as the anchor or as a
    variable-group metric's sibling grouping column — and on the variable groups
    containing them. ``domain_ids`` is for a door that changed a group's
    MEMBERSHIP: it reaches that group's own metrics and tests, and nothing on its
    member columns, whose numbers a membership edit cannot move (#1149).

    ⚠️ Computed columns that depend on a changed column are marked one level
    deep, deliberately: their cells move only when they are recomputed, and
    `recompute_column` marks the next level at that moment. A transitive
    pre-pass would mark numbers that have not moved yet.

    Returns the total number of metric rows marked stale.
    """
    total = 0

    # Track domains containing affected columns (for cascade in both metrics and tests sections)
    containing_domain_ids: list[int] = []
    sibling_metric_ids: list[int] = []

    if column_ids:
        # Pre-pass: mark computed columns stale if they depend on changed columns
        computed_cols = (
            db.query(DatasetColumn)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                Dataset.project_id == project_id,
                DatasetColumn.expression.isnot(None),
            )
            .all()
        )
        if computed_cols:
            changed_set = set(column_ids)
            stale_computed_ids = []
            for cc in computed_cols:
                if cc.depends_on_column_ids:
                    try:
                        dep_ids = set(_json.loads(cc.depends_on_column_ids))
                    except (ValueError, TypeError):
                        continue
                    if dep_ids & changed_set:
                        stale_computed_ids.append(cc.id)
            if stale_computed_ids:
                db.query(DatasetColumn).filter(
                    DatasetColumn.id.in_(stale_computed_ids),
                ).update({"stale": True}, synchronize_session="fetch")
                column_ids = list(set(column_ids) | set(stale_computed_ids))

        # (a) Metrics whose input source is one of these columns
        count_a = (
            db.query(MetricDefinition)
            .filter(
                MetricDefinition.project_id == project_id,
                MetricDefinition.input_source_type == "dataset_column",
                MetricDefinition.input_source_id.in_(column_ids),
                MetricDefinition.stale == False,  # noqa: E712
            )
            .update({"stale": True}, synchronize_session="fetch")
        )
        total += count_a

        # (b) Metrics whose grouping_column or grouping_column_2 is one of these columns
        count_b = (
            db.query(MetricDefinition)
            .filter(
                MetricDefinition.project_id == project_id,
                or_(
                    MetricDefinition.grouping_column_id.in_(column_ids),
                    MetricDefinition.grouping_column_id_2.in_(column_ids),
                ),
                MetricDefinition.stale == False,  # noqa: E712
            )
            .update({"stale": True}, synchronize_session="fetch")
        )
        total += count_b

        # (b2) Find domains containing these columns, mark domain metrics stale
        containing_domain_ids = [
            row[0] for row in
            db.query(AnalysisDomainMember.domain_id)
            .filter(
                AnalysisDomainMember.member_type == "column",
                AnalysisDomainMember.member_id.in_(column_ids),
            )
            .distinct()
            .all()
        ]
        if containing_domain_ids:
            count_b2 = (
                db.query(MetricDefinition)
                .filter(
                    MetricDefinition.project_id == project_id,
                    MetricDefinition.input_source_type == "dataset_domain",
                    MetricDefinition.input_source_id.in_(containing_domain_ids),
                    MetricDefinition.stale == False,  # noqa: E712
                )
                .update({"stale": True}, synchronize_session="fetch")
            )
            total += count_b2

        # (b3) #1168 door 8 — a grouped variable-group metric groups its OTHER
        # datasets' rows by SIBLING demographic columns, which arm (b) cannot see
        # (it knows only the anchor). Resolved through compute's own matching.
        changed = set(column_ids)
        sibling_metric_ids = [
            metric_id
            for metric_id, grouping in grouping_sets(db, project_id).items()
            if grouping & changed
        ]
        if sibling_metric_ids:
            total += (
                db.query(MetricDefinition)
                .filter(
                    MetricDefinition.id.in_(sibling_metric_ids),
                    MetricDefinition.stale == False,  # noqa: E712
                )
                .update({"stale": True}, synchronize_session="fetch")
            )

    if domain_ids:
        # (c) Metrics whose input source is one of these domains
        count_c = (
            db.query(MetricDefinition)
            .filter(
                MetricDefinition.project_id == project_id,
                MetricDefinition.input_source_type == "dataset_domain",
                MetricDefinition.input_source_id.in_(domain_ids),
                MetricDefinition.stale == False,  # noqa: E712
            )
            .update({"stale": True}, synchronize_session="fetch")
        )
        total += count_c
        # No arm for the member COLUMNS' own metrics (#1149, removed 2026-10-10):
        # a membership edit cannot move a column metric's input, and marking it
        # put a false marker on every t-test saved against one.

    # ── Mark statistical tests stale ──────────────────────────────────────
    # Statistical tests can target domains (alpha) or metrics (t-test/ANOVA).
    # When columns or domains change, propagate staleness.

    if column_ids:
        # Find metrics affected by these columns, mark tests targeting them
        affected_metric_ids = [
            row[0] for row in
            db.query(MetricDefinition.id)
            .filter(
                MetricDefinition.project_id == project_id,
                or_(
                    (MetricDefinition.input_source_type == "dataset_column") &
                    (MetricDefinition.input_source_id.in_(column_ids)),
                    MetricDefinition.grouping_column_id.in_(column_ids),
                    MetricDefinition.grouping_column_id_2.in_(column_ids),
                ),
            )
            .all()
        ]
        affected_metric_ids.extend(sibling_metric_ids)
        if affected_metric_ids:
            db.query(StatisticalTest).filter(
                StatisticalTest.project_id == project_id,
                StatisticalTest.target_type == "metric_definition",
                StatisticalTest.target_id.in_(affected_metric_ids),
                StatisticalTest.stale == False,  # noqa: E712
            ).update({"stale": True}, synchronize_session="fetch")

        # Also cascade to tests targeting domains containing these columns
        if containing_domain_ids:
            db.query(StatisticalTest).filter(
                StatisticalTest.project_id == project_id,
                StatisticalTest.target_type == "analysis_domain",
                StatisticalTest.target_id.in_(containing_domain_ids),
                StatisticalTest.stale == False,  # noqa: E712
            ).update({"stale": True}, synchronize_session="fetch")

            # And tests targeting domain-level metrics
            domain_metric_ids = [
                row[0] for row in
                db.query(MetricDefinition.id)
                .filter(
                    MetricDefinition.project_id == project_id,
                    MetricDefinition.input_source_type == "dataset_domain",
                    MetricDefinition.input_source_id.in_(containing_domain_ids),
                )
                .all()
            ]
            if domain_metric_ids:
                db.query(StatisticalTest).filter(
                    StatisticalTest.project_id == project_id,
                    StatisticalTest.target_type == "metric_definition",
                    StatisticalTest.target_id.in_(domain_metric_ids),
                    StatisticalTest.stale == False,  # noqa: E712
                ).update({"stale": True}, synchronize_session="fetch")

    if domain_ids:
        # Alpha tests targeting these domains
        db.query(StatisticalTest).filter(
            StatisticalTest.project_id == project_id,
            StatisticalTest.target_type == "analysis_domain",
            StatisticalTest.target_id.in_(domain_ids),
            StatisticalTest.stale == False,  # noqa: E712
        ).update({"stale": True}, synchronize_session="fetch")

        # T-test/ANOVA tests targeting domain-level metrics
        affected_domain_metric_ids = [
            row[0] for row in
            db.query(MetricDefinition.id)
            .filter(
                MetricDefinition.project_id == project_id,
                MetricDefinition.input_source_type == "dataset_domain",
                MetricDefinition.input_source_id.in_(domain_ids),
            )
            .all()
        ]
        if affected_domain_metric_ids:
            db.query(StatisticalTest).filter(
                StatisticalTest.project_id == project_id,
                StatisticalTest.target_type == "metric_definition",
                StatisticalTest.target_id.in_(affected_domain_metric_ids),
                StatisticalTest.stale == False,  # noqa: E712
            ).update({"stale": True}, synchronize_session="fetch")

    return total


def _mark_metric_ids_stale(db: Session, metric_ids) -> int:
    """Mark exactly these metrics stale, with their tests."""
    ids = sorted({int(i) for i in metric_ids})
    if not ids:
        return 0
    marked = (
        db.query(MetricDefinition)
        .filter(
            MetricDefinition.id.in_(ids),
            MetricDefinition.stale == False,  # noqa: E712
        )
        .update({"stale": True}, synchronize_session="fetch")
    )
    mark_metric_tests_stale(db, ids)
    return marked


def grouping_sets(db: Session, project_id: int) -> dict[int, frozenset[int]]:
    """Each grouped variable-group metric's grouping columns, anchor + siblings.

    Read from what is FLUSHED (the session runs with `autoflush=False`), so a door
    takes this snapshot before it changes anything and flushes before the after
    side — `mark_regrouped_metrics_stale` does that flush itself.

    Bounded by the project's count of grouped variable-group metrics, with one
    sibling cache per call, the same cache `compute_all_for_project` keeps.
    """
    from .metrics import effective_grouping_column_ids

    metrics = (
        db.query(MetricDefinition)
        .filter(
            MetricDefinition.project_id == project_id,
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.grouping_column_id.isnot(None),
            or_(
                MetricDefinition.grouping_mode.is_(None),
                MetricDefinition.grouping_mode != "dataset",
            ),
        )
        .all()
    )
    cache: dict = {}
    return {
        m.id: frozenset(effective_grouping_column_ids(db, m, _cache=cache))
        for m in metrics
    }


def mark_regrouped_metrics_stale(
    db: Session, project_id: int, before: dict[int, frozenset[int]],
) -> int:
    """After a METADATA edit, mark the grouped variable-group metrics whose
    grouping columns it changed (#1168 door 8).

    The doors are the ones that change which column is a sibling: a type change
    (to or from demographic), a demographic subtype, a short name, and every
    equivalence-group change. None moves a cell, so `mark_metrics_stale` would be
    the wrong tool — it would also mark the column's own metrics, whose numbers
    did not move (#1149's fault). Comparing the sets before and after marks
    exactly the metrics whose groups now come from different columns.
    """
    db.flush()
    after = grouping_sets(db, project_id)
    moved = [
        metric_id for metric_id, grouping in after.items()
        if before.get(metric_id) != grouping
    ]
    return _mark_metric_ids_stale(db, moved)


def mark_pairing_stale(
    db: Session,
    project_id: int,
    column_ids,
    before: dict[int, frozenset[int]],
) -> int:
    """After an equivalence-group change to these columns.

    Two things read the pairing, and neither is a cell:
    - **sibling grouping** — tier 1 of `_resolve_grouping_siblings` matches by
      equivalence group (`mark_regrouped_metrics_stale`);
    - **a variable group's reliability tests** — Cronbach's α and split-half
      collapse paired columns into ONE item (`statistical_tests.py::
      collapse_domain_items`), so re-pairing a member re-shapes the item matrix.
      Those tests target the variable group, and the create / add / remove /
      delete doors marked nothing (found 2026-10-10, building #1168).

    The group's own metrics are NOT marked: a scale score averages each record's
    own items and never reads the pairing.
    """
    marked = mark_regrouped_metrics_stale(db, project_id, before)
    ids = sorted({int(c) for c in column_ids})
    if ids:
        domain_ids = [
            row[0] for row in
            db.query(AnalysisDomainMember.domain_id)
            .filter(
                AnalysisDomainMember.member_type == "column",
                AnalysisDomainMember.member_id.in_(ids),
            )
            .distinct()
            .all()
        ]
        if domain_ids:
            db.query(StatisticalTest).filter(
                StatisticalTest.project_id == project_id,
                StatisticalTest.target_type == "analysis_domain",
                StatisticalTest.target_id.in_(domain_ids),
                StatisticalTest.stale == False,  # noqa: E712
            ).update({"stale": True}, synchronize_session="fetch")
    return marked


def mark_dataset_grouped_metrics_stale(
    db: Session, project_id: int, dataset_id: int,
) -> int:
    """After a dataset RENAME: the variable-group metrics grouped BY DATASET whose
    group contains one of its columns (plan decision 5).

    Their group labels ARE the dataset names (`resolve_dataset_domain`'s
    `grouping_mode == "dataset"` arm), so a saved result keeps showing the old
    name as a group until it is recomputed. The house precedent marks on a
    `column_text` change for the same reason.
    """
    domain_ids = [
        row[0] for row in
        db.query(AnalysisDomainMember.domain_id)
        .join(DatasetColumn, DatasetColumn.id == AnalysisDomainMember.member_id)
        .filter(
            AnalysisDomainMember.member_type == "column",
            DatasetColumn.dataset_id == dataset_id,
        )
        .distinct()
        .all()
    ]
    if not domain_ids:
        return 0
    metric_ids = [
        row[0] for row in
        db.query(MetricDefinition.id)
        .filter(
            MetricDefinition.project_id == project_id,
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.input_source_id.in_(domain_ids),
            MetricDefinition.grouping_mode == "dataset",
        )
        .all()
    ]
    return _mark_metric_ids_stale(db, metric_ids)


def mark_metrics_stale_for_columns(db: Session, column_ids) -> int:
    """`mark_metrics_stale(column_ids=…)` for a caller with no project in hand.

    The install-wide writers — the startup and restore repairs, which walk every
    project's columns at once (#1168 door 7). Each column is resolved to its own
    project, so the project-scoped marker keeps its scoping unchanged.
    """
    ids = sorted({int(c) for c in column_ids})
    if not ids:
        return 0
    by_project: dict[int, list[int]] = defaultdict(list)
    for column_id, project_id in (
        db.query(DatasetColumn.id, Dataset.project_id)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(DatasetColumn.id.in_(ids))
        .all()
    ):
        by_project[project_id].append(column_id)
    return sum(
        mark_metrics_stale(db, project_id, column_ids=cols)
        for project_id, cols in sorted(by_project.items())
    )
