"""Shared grouping-value loader + display ordering for analysis paths.

Loads ``{row_id: value_text}`` for a grouping column, excluding recognized N/A
strings (#384) so that missing/refusal values (e.g. "N/A", "Decline to state")
never form a spurious group or category in group-by, cross-tabulation,
group-comparison, or scatter color-grouping.

This centralizes the N/A decision that previously drifted across four
independent queries — the root cause of #384. The "what counts as missing"
decision itself lives in ``services/missing_values`` (#592: column-aware —
a declared ``missing_values`` rule list REPLACES the ``_is_na`` defaults),
so every path applies the same rule.

``order_value_labels`` is the sibling single-source decision for #406: how
value_text labels are ordered on display surfaces.
"""
import math

from sqlalchemy.orm import Session

from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from .missing_values import is_missing, parse_missing_rules

#: What a bucket of rows with no grouping value is CALLED, everywhere.
#:
#: The Excel export has labelled its ``None`` bucket this since #506, as a lone
#: string literal. #823(l) needed the same word in a second place — the residual
#: cell of a CROSSED comparison — and a second literal is how two surfaces start
#: disagreeing about one fact. Any surface that renders a missing-value bucket
#: as a row, a group or an axis value uses this.
MISSING_GROUP_LABEL = "(Missing)"


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
    row_ids: list[int] | None,
    *,
    project_id: int | None = None,
) -> dict[int, str]:
    """Return ``{row_id: value_text}`` for the grouping column over ``row_ids``,
    excluding recognized N/A values (treated as missing — a missing grouping
    value must not define a subgroup).

    ``row_ids=None`` means no row restriction (every row holding a value in the
    column); an explicit empty list still returns ``{}``. ``project_id`` adds an
    ownership join (used by the correlations path). Empty strings are left as-is
    (callers already drop falsy groups), matching prior behavior; only values
    the column's missing rule matches are removed.

    Single-column convenience over ``load_grouping_values_for_columns`` — the N/A
    rule itself lives there, once.
    """
    return load_grouping_values_for_columns(
        db, [column_id], row_ids, project_id=project_id,
    )


def load_grouping_values_for_columns(
    db: Session,
    column_ids: list[int],
    row_ids: list[int] | None,
    *,
    project_id: int | None = None,
) -> dict[int, str]:
    """``{row_id: value_text}`` across a SET of grouping columns, same N/A rule.

    The domain path (``metrics.py::resolve_dataset_domain``) groups by an anchor
    column PLUS its sibling columns in the other datasets a domain spans
    (``_resolve_grouping_siblings``), so it needs one query over N column ids
    rather than N queries. A ``DatasetRow`` belongs to exactly one dataset and
    siblings are one-per-dataset, so at most one id can match a given row — the
    map cannot collide.

    ``row_ids=None`` = no row restriction (#597: the text-analysis surfaces
    group over every row holding a value in the grouping column, so forcing
    callers to pre-fetch a dataset's row ids just to pass them back in would
    add a full-table query per request). ``[]`` still returns ``{}``.

    #593: this exists because that path hand-rolled its own unfiltered
    ``value_text`` query and so never applied the #384 N/A rule — the same
    grouping column produced a real "Decline to state" group on the domain path
    and a None bucket on the column path. New grouping paths route through here
    or ``load_grouping_values``; never re-inline the query.

    #592 slab 2: the decision is COLUMN-AWARE — a column with a declared
    ``missing_values`` rule list uses it (REPLACE semantics), an undeclared
    column keeps the ``_is_na`` defaults; each value is judged by ITS column's
    rules (the query selects ``column_id`` for exactly this).
    """
    if row_ids is not None and not row_ids:
        return {}
    if not column_ids:
        return {}
    rules_by_col = {
        cid: parse_missing_rules(mv)
        for cid, mv in db.query(
            DatasetColumn.id, DatasetColumn.missing_values,
        ).filter(DatasetColumn.id.in_(column_ids)).all()
    }
    query = db.query(
        DatasetValue.row_id, DatasetValue.column_id, DatasetValue.value_text,
    ).filter(
        DatasetValue.column_id.in_(column_ids),
        DatasetValue.value_text.isnot(None),
    )
    if row_ids is not None:
        query = query.filter(DatasetValue.row_id.in_(row_ids))
    if project_id is not None:
        query = (
            query.join(DatasetColumn, DatasetValue.column_id == DatasetColumn.id)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(Dataset.project_id == project_id)
        )
    return {
        r_id: val
        for r_id, c_id, val in query.all()
        if not is_missing(val, rules_by_col.get(c_id))
    }
