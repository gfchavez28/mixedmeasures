"""#1615 — while blind, nothing COMPUTED over a participant rating score reaches the viewer.

#1608 (D198) withheld the participant table's rating columns at the doors that SHOW
the table. The doors that COMPUTE over a column — a saved metric's results, the
group comparison, correlations and scatters, the cross-tab, Data Quality, the record
matrix, a saved test — read the same stored snapshot, which holds EVERY coder's
ratings, and a box plot, a scatter or a mean over one participant shows a value from
which a colleague's rating is read back exactly (her own 2, the table's 3.5 over two
raters ⇒ the colleague's 5).

The rule is the table's own — `participant_scores.withheld_rating_column_ids`, asked
of the snapshot's raters (D222) — applied to everything a door READS:

- a COLUMN is withheld when it is in that set (the score, its rated-passage count,
  and every column computed or derived from one);
- a VARIABLE GROUP when any member is (its scale score averages them);
- a METRIC when any column it reads is — its input (the column, or the group's
  members after a decompose), and every column that decides its GROUPS (the anchor
  AND a variable-group metric's sibling grouping columns,
  `metrics.effective_grouping_column_ids`, the staleness marker's own resolution);
- a saved TEST when its target metric or group is.

A withheld input is never computed over for the viewer and never substituted by a
live, self-scoped recompute (D198: a research measure moves only when the researcher
refreshes). A door leaves it OUT and SAYS how many it left out; a door whose one
input is withheld says why (`undefined_stats.RATING_WITHHELD_BLIND`).

⚠️ No scope, or a scope holding every coder whose ratings the snapshot carries
(D98), withholds nothing — and costs one dataset read (`snapshot_rater_ids` is a JSON
read on a table refreshed by this build).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from ..models.metric import MetricDefinition
from ..models.statistical_test import StatisticalTest
from .metrics import (
    _apply_decompose_filter,
    _domain_member_column_ids,
    effective_grouping_column_ids,
)
from .participant_scores import withheld_rating_columns_in_project


def metric_read_column_ids(
    db: Session, metric: MetricDefinition, *, _members=None, _cache: dict | None = None,
) -> set[int]:
    """Every column whose cells this metric's numbers come from or are grouped by."""
    if metric.input_source_type == "dataset_domain":
        members = (_members or (lambda d: _domain_member_column_ids(db, d)))(metric.input_source_id)
        read = set(_apply_decompose_filter(metric, list(members)))
    else:
        read = {metric.input_source_id}
    # The anchors AND a variable-group metric's sibling grouping columns in its other
    # datasets — the staleness marker's own resolution, never a second copy of it. (A
    # dataset-grouped metric has no grouping column at all: `grouping_column_id`
    # must be null there.)
    read |= effective_grouping_column_ids(db, metric, _cache=_cache)
    return read


@dataclass
class RatingWithholding:
    """One request's answer: which column ids its viewer must not be computed over.

    Built once per request; it caches each variable group's members and the
    grouping-sibling resolution, since a list door asks it of every saved metric.
    """

    columns: frozenset[int]
    _members: dict = field(default_factory=dict, repr=False, compare=False)
    _siblings: dict = field(default_factory=dict, repr=False, compare=False)

    def _domain_members(self, db: Session, domain_id: int) -> list[int]:
        if domain_id not in self._members:
            self._members[domain_id] = _domain_member_column_ids(db, domain_id)
        return self._members[domain_id]

    def __bool__(self) -> bool:
        return bool(self.columns)

    def column(self, column_id: int | None) -> bool:
        return column_id is not None and column_id in self.columns

    def split_columns(self, column_ids) -> tuple[list[int], int]:
        """(the ids kept, in order; how many were left out)."""
        ids = list(column_ids or [])
        kept = [c for c in ids if c not in self.columns]
        return kept, len(ids) - len(kept)

    def domain(self, db: Session, domain_id: int | None) -> bool:
        if not self.columns or domain_id is None:
            return False
        return bool(set(self._domain_members(db, domain_id)) & self.columns)

    def split_domains(self, db: Session, domain_ids) -> tuple[list[int], int]:
        ids = list(domain_ids or [])
        kept = [d for d in ids if not self.domain(db, d)]
        return kept, len(ids) - len(kept)

    def split_sources(self, db: Session, column_ids, domain_ids) -> tuple[list[int], list[int], int]:
        """A request's variables, columns and groups: (columns kept, groups kept,
        how many of either were left out)."""
        cols, n_cols = self.split_columns(column_ids)
        doms, n_doms = self.split_domains(db, domain_ids)
        return cols, doms, n_cols + n_doms

    def metric(self, db: Session, metric: MetricDefinition | None) -> bool:
        if not self.columns or metric is None:
            return False
        if (metric.input_source_type == "dataset_column" and metric.grouping_column_id is None):
            return metric.input_source_id in self.columns     # the common case: no query
        return bool(metric_read_column_ids(
            db, metric, _members=lambda d: self._domain_members(db, d), _cache=self._siblings,
        ) & self.columns)

    def test(self, db: Session, test: StatisticalTest) -> bool:
        if not self.columns:
            return False
        if test.target_type == "analysis_domain":
            return self.domain(db, test.target_id)
        return self.metric(db, db.get(MetricDefinition, test.target_id))


def rating_withholding(db: Session, project_id: int, coder_ids) -> RatingWithholding:
    """The ONE entry for an analysis door (#1615): ``coder_ids`` as parsed from the
    request (None or empty = every coder, withholding nothing — no query)."""
    if not coder_ids:
        return RatingWithholding(frozenset())
    return RatingWithholding(withheld_rating_columns_in_project(db, project_id, coder_ids))
