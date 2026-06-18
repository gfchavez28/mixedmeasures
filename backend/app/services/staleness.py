"""Staleness tracking for computed metrics and statistical tests.

When underlying data changes (recode edits, value edits, domain membership changes),
affected MetricDefinition and StatisticalTest rows are marked stale so the UI can
prompt recomputation.
"""

import json as _json

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models.dataset import DatasetColumn, Dataset
from ..models.metric import MetricDefinition
from ..models.statistical_test import StatisticalTest
from ..models.analysis_domain import AnalysisDomainMember


def mark_metrics_stale(
    db: Session,
    project_id: int,
    column_ids: list[int] | None = None,
    domain_ids: list[int] | None = None,
) -> int:
    """Mark metrics stale that depend on the given columns or domains.

    Returns the total number of metric rows marked stale.
    """
    total = 0

    # Track domains containing affected columns (for cascade in both metrics and tests sections)
    containing_domain_ids: list[int] = []

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

        # (d) Find columns belonging to these domains (via AnalysisDomainMember)
        # and mark column-level metrics for those columns stale too.
        column_member_ids = (
            db.query(AnalysisDomainMember.member_id)
            .filter(
                AnalysisDomainMember.domain_id.in_(domain_ids),
                AnalysisDomainMember.member_type == "column",
            )
            .all()
        )
        col_ids_from_domains = [row[0] for row in column_member_ids]

        if col_ids_from_domains:
            count_d = (
                db.query(MetricDefinition)
                .filter(
                    MetricDefinition.project_id == project_id,
                    MetricDefinition.input_source_type == "dataset_column",
                    MetricDefinition.input_source_id.in_(col_ids_from_domains),
                    MetricDefinition.stale == False,  # noqa: E712
                )
                .update({"stale": True}, synchronize_session="fetch")
            )
            total += count_d

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
