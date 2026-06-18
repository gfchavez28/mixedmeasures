"""Shared grouping-value loader + display ordering for analysis paths.

Loads ``{row_id: value_text}`` for a grouping column, excluding recognized N/A
strings (#384) so that missing/refusal values (e.g. "N/A", "Decline to state")
never form a spurious group or category in group-by, cross-tabulation,
group-comparison, or scatter color-grouping.

This centralizes the N/A decision that previously drifted across four
independent queries — the root cause of #384. The "what counts as N/A" decision
itself lives in ``dataset_import._is_na`` (also used by #381 frequency/proportion
and the Data Quality tab), so every path now applies the same rule.

``order_value_labels`` is the sibling single-source decision for #406: how
value_text labels are ordered on display surfaces.
"""
import math

from sqlalchemy.orm import Session

from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from .dataset_import import _is_na


def value_label_sort_key(label: str) -> tuple[int, float, str]:
    """Sort key behind ``order_value_labels`` — public for callers that need to
    compose it into a larger key (e.g. recode-mapping order first, then this)."""
    try:
        num = float(label)
        if math.isnan(num):
            return (1, 0.0, label)
        return (0, num, "")
    except (TypeError, ValueError):
        return (1, 0.0, label)


def order_value_labels(labels) -> list[str]:
    """#406: the single source of truth for ordering ``value_text`` labels on
    display surfaces (frequency distributions, cross-tab axes, comparison and
    statistical-test group order).

    Numeric-aware rather than column-type-gated: labels that parse as numbers
    sort numerically and come first; non-parsable labels follow in lexicographic
    order. A pure-text label set therefore keeps plain lexicographic order, and
    a numeric label set sorts 1, 2, 9, 12 — never 1, 12, 2, 9. Data-driven
    because several callers order labels pooled across columns (domain-path
    frequency) where no single column type exists, and because numeric-looking
    labels in a nominal column still read better in numeric order.

    Deliberately NOT used by count-ranked surfaces (recode value frequencies —
    frequency rank is their semantics) or by ``scale_labels``/recode-mapping
    orders, which are explicit user-authored orderings that always win.
    """
    return sorted(labels, key=value_label_sort_key)


def load_grouping_values(
    db: Session,
    column_id: int,
    row_ids: list[int],
    *,
    project_id: int | None = None,
) -> dict[int, str]:
    """Return ``{row_id: value_text}`` for the grouping column over ``row_ids``,
    excluding recognized N/A values (treated as missing — a missing grouping
    value must not define a subgroup).

    ``project_id`` adds an ownership join (used by the correlations path). Empty
    strings are left as-is (callers already drop falsy groups), matching prior
    behavior; only ``_is_na()`` matches are removed.
    """
    if not row_ids:
        return {}
    query = db.query(DatasetValue.row_id, DatasetValue.value_text).filter(
        DatasetValue.column_id == column_id,
        DatasetValue.row_id.in_(row_ids),
        DatasetValue.value_text.isnot(None),
    )
    if project_id is not None:
        query = (
            query.join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(Dataset.project_id == project_id)
        )
    return {r_id: val for r_id, val in query.all() if not _is_na(val)}
