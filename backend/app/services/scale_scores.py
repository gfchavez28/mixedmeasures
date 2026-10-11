"""Which metric IS a variable group's scale score (#1177).

A group can carry several ungrouped `domain_aggregate` metrics — the scale score
the crosswalk creates, and lookalikes quick compute creates beside it: the same
aggregate with some answers excluded (the `exclude` URL parameter survives a
change of metric type), the aggregate split by dataset, one built over a
proportion. Each writes its own per-record `RowScore`s.

🔴 **Every surface that reads "the group's scale score" must read the SAME one
metric, and this module is how.** Before it, Correlations, scatter and
Comparisons merged every variant's per-record scores (last one winning), the Data
view showed one column per variant, the R data export wrote `…_score_2`, and
*Compute the scale score* refreshed whichever variant `.first()` returned — so the
button could refresh one metric while the tabs read another, and #1176's
out-of-date notice stayed up after it was pressed.

The identity is the STATISTIC, not the provenance: an unweighted mean of the
members' item means, over every answer, ungrouped (`AGGREGATION_BASIS_UNWEIGHTED_
ITEM_MEANS`). `origin_context="crosswalk_auto"` only breaks a tie between two
metrics that compute it, because the crosswalk's is the one `create_scale_score_
metric` maintains and the R export keeps (foot-gun).
"""
from __future__ import annotations

import json
from typing import Iterable, Protocol

from sqlalchemy.orm import Session

from ..models.metric import MetricDefinition

#: The config `create_scale_score_metric` writes (directive GAP 3.1). The
#: predicate does not require it verbatim: a config that RESOLVES to the same
#: statistic (`compute_domain_aggregate`'s own defaults fill a missing key) is the
#: same scale score.
SCALE_SCORE_CONFIG = {"child_metric_type": "mean", "child_config": {}, "aggregation": "mean"}

#: Breaks a tie between two metrics that both compute the scale score.
SCALE_SCORE_ORIGIN_CONTEXT = "crosswalk_auto"


class _MetricLike(Protocol):
    id: int
    metric_type: str
    input_source_type: str
    input_source_id: int
    grouping_column_id: int | None
    grouping_column_id_2: int | None
    grouping_mode: str | None
    exclude_values: str | None
    config: str | None
    origin_context: str | None


def _json(text: str | None):
    if not text:
        return None
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def is_scale_score(metric: _MetricLike) -> bool:
    """Does this metric compute a variable group's scale score?

    Every condition is one a lookalike can break:
    - a group (`dataset_domain`) aggregate (`domain_aggregate`);
    - UNGROUPED — both grouping columns empty, and not split by dataset
      (`grouping_mode` `None` and `"column"` are the same thing, as in
      `metrics._normalize_metric_key`);
    - over EVERY answer — no excluded values;
    - the mean of item means — `compute_domain_aggregate` reads a missing
      `child_metric_type` / `aggregation` as `"mean"`, so this does too;
    - over EVERY member — not narrowed to some items (`decompose_column_ids`).
    """
    if metric.metric_type != "domain_aggregate" or metric.input_source_type != "dataset_domain":
        return False
    if metric.grouping_column_id is not None or metric.grouping_column_id_2 is not None:
        return False
    if metric.grouping_mode not in (None, "column"):
        return False
    if _json(metric.exclude_values):
        return False
    config = _json(metric.config) or {}
    if not isinstance(config, dict):
        return False
    return (
        config.get("child_metric_type", "mean") == "mean"
        and config.get("aggregation", "mean") == "mean"
        and not config.get("decompose_column_ids")
    )


def pick_scale_scores(metrics: Iterable[_MetricLike]) -> dict[int, _MetricLike]:
    """`{domain_id: its scale score}` from any collection of metrics.

    ⚠️ Deterministic on purpose: when two metrics both compute the scale score
    (a legacy config beside the crosswalk's), the crosswalk's wins, then the
    oldest. Whichever it is, the readers, the out-of-date disclosure and the
    recompute all get the same one — that agreement is the property, not which.
    """
    chosen: dict[int, _MetricLike] = {}
    for metric in metrics:
        if not is_scale_score(metric):
            continue
        current = chosen.get(metric.input_source_id)
        if current is None or _rank(metric) < _rank(current):
            chosen[metric.input_source_id] = metric
    return chosen


def _rank(metric: _MetricLike) -> tuple[int, int]:
    return (0 if metric.origin_context == SCALE_SCORE_ORIGIN_CONTEXT else 1, metric.id)


def scale_score_metrics(
    db: Session, project_id: int, domain_ids: Iterable[int] | None = None,
) -> dict[int, MetricDefinition]:
    """`{domain_id: MetricDefinition}` — each listed group's scale score, for the
    groups that have one (all the project's groups when `domain_ids` is None)."""
    query = db.query(MetricDefinition).filter(
        MetricDefinition.project_id == project_id,
        MetricDefinition.metric_type == "domain_aggregate",
        MetricDefinition.input_source_type == "dataset_domain",
        MetricDefinition.grouping_column_id.is_(None),
        MetricDefinition.grouping_column_id_2.is_(None),
    )
    if domain_ids is not None:
        ids = list(domain_ids)
        if not ids:
            return {}
        query = query.filter(MetricDefinition.input_source_id.in_(ids))
    return pick_scale_scores(query.all())
