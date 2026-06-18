"""Shared validators for equivalence group + analysis domain invariants.

These validators live outside the router layer so router endpoints across
`routers/equivalence.py`, `routers/analysis_domains.py`, `routers/crosswalk.py`
AND `services/project_portability.py` can call them without creating
router → router or router → service import cycles.

Four router-layer validators (raise `HTTPException`):

- `assert_columns_same_type(cols)` — 409 `type_mismatch` if columns don't share
  a column_type. Used by the swap endpoint.
- `assert_columns_same_dataset(cols)` — 400 `cross_dataset` if columns span
  multiple datasets. Used by the swap endpoint.
- `assert_cross_dataset_members_are_paired(db, member_ids, existing_member_ids)`
  — 409 `cross_dataset_unpaired` if a domain whose members span 2+ datasets
  contains any column unpaired via equivalence groups (#290). Used by domain
  create/add/bulk endpoints, the swap endpoint's post-mutation pass, and the
  crosswalk move-members endpoint.

One portability-layer validator (raises `ValueError`):

- `assert_equivalence_group_types_consistent(group)` — used by
  `services/project_portability.py` as a post-write sanity pass during
  `.mmproject` import. Raises `ValueError` (not `HTTPException`) so service
  callers don't leak FastAPI exception types.

See Tier 3 directive GAP 3.14 and Phase 1.1 for the full rationale.
"""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from ..models.dataset import ColumnType, DatasetColumn, SCALE_SCORE_ELIGIBLE_TYPES
from ..models.equivalence_group import EquivalenceGroup

# Column types eligible for domain_aggregate scale-score metrics. Binary yes/no
# is deliberately excluded (don't average a 0/1 into a Likert-style mean), as are
# nominal text, open-ended responses, multi-select, and demographic categoricals.
# Retained name (referenced in equivalence.md / the internal design notes / tests); aliases
# the single source of truth in models/dataset.py (#399, invariant I-D).
NUMERIC_ELIGIBLE_COLUMN_TYPES = SCALE_SCORE_ELIGIBLE_TYPES


def assert_columns_same_type(cols: list[DatasetColumn]) -> None:
    """Raise HTTPException(409) if columns don't share a column_type.

    Used by the router-layer swap endpoint (Tier 3 Session B) to block swaps
    between cells of different types. The `type_mismatch` structured shape
    matches the existing convention from `routers/equivalence.py::_assert_columns_unique_per_dataset`.

    Args:
        cols: Columns being asserted to share a type. Empty and single-element
            lists are trivially valid.
    """
    if len(cols) < 2:
        return

    types = {col.column_type for col in cols}
    if len(types) > 1:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "type_mismatch",
                "message": "Columns in an equivalence group must share a column type.",
                "column_ids": [col.id for col in cols],
            },
        )


def assert_columns_same_dataset(cols: list[DatasetColumn]) -> None:
    """Raise HTTPException(400) if columns span multiple datasets.

    Used by the router-layer swap endpoint (Tier 3 Session B) — a swap is
    defined as exchanging two cells' row assignments within the same dataset
    column, so cross-dataset swaps are nonsensical, not merely forbidden.
    Status 400 signals "bad request shape" rather than 409's "valid request,
    forbidden state."

    Args:
        cols: Columns being asserted to share a dataset. Empty and
            single-element lists are trivially valid.
    """
    if len(cols) < 2:
        return

    dataset_ids = {col.dataset_id for col in cols}
    if len(dataset_ids) > 1:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "cross_dataset",
                "message": "Swap operations must target columns from the same dataset.",
                "column_ids": [col.id for col in cols],
                "dataset_ids": sorted(dataset_ids),
            },
        )


def assert_equivalence_group_types_consistent(group: EquivalenceGroup) -> None:
    """Raise ValueError if an equivalence group contains mixed column types.

    Portability-safe variant of `assert_columns_same_type` — raises `ValueError`
    (not `HTTPException`) because it's called from `services/project_portability.py`
    where service code must not raise FastAPI exception types.

    Used as a post-write sanity pass during `.mmproject` import. Catches the
    case where a legacy or hand-edited export file bundled mismatched-type
    columns into the same equivalence group, which would then raise a confusing
    runtime error the first time a researcher tried to swap cells in the
    affected row.

    Args:
        group: A loaded `EquivalenceGroup` with its `columns` relationship
            populated. Empty and single-column groups are trivially valid.
    """
    cols = list(group.columns)
    if len(cols) < 2:
        return

    types = {col.column_type for col in cols}
    if len(types) > 1:
        type_summary = sorted(t.value if hasattr(t, "value") else str(t) for t in types)
        col_summary = [
            {"id": col.id, "column_code": col.column_code, "column_type": (
                col.column_type.value if hasattr(col.column_type, "value") else str(col.column_type)
            )}
            for col in cols
        ]
        raise ValueError(
            f"EquivalenceGroup {group.id} ({group.label!r}) contains columns "
            f"with mismatched types: {type_summary}. All columns in an "
            f"equivalence group must share a single column_type. "
            f"Columns: {col_summary}. Repair the source project by changing "
            f"the mismatched columns' types before re-importing."
        )


def assert_columns_not_already_linked(
    db: Session,
    cols: list[DatasetColumn],
    current_eg_id_to_ignore: int | None,
) -> None:
    """Raise 409 if any of `cols` is already linked to an equivalence group
    other than `current_eg_id_to_ignore`.

    Used to reject silent column hijack between equivalence groups (#301).
    Pre-Path-A behavior was: assigning a column already in EG-A to a new EG-B
    silently nullified A and reassigned to B. That moves a column out of any
    cross-dataset domain pairing it was supporting, with no caller acknowledgment.

    Args:
        cols: Columns being assigned. The validator checks each one's current
            `equivalence_group_id`.
        current_eg_id_to_ignore: When the call is `add_columns(group_id=X)`,
            pass `X` here so a column already in X is treated as an idempotent
            re-add (no 409). For `create_group` and `bulk_create_groups`, pass
            `None` (no destination EG exists yet).

    Raises:
        HTTPException(409): structured detail with `error="column_already_linked"`,
            `message`, and `conflicts=[{column_id, column_code, current_group_id,
            current_group_label}]`. The `current_group_label` is loaded once for
            all distinct conflicting EG IDs in a single batched query.
    """
    conflicts = [
        col for col in cols
        if col.equivalence_group_id is not None
        and col.equivalence_group_id != current_eg_id_to_ignore
    ]
    if not conflicts:
        return

    distinct_eg_ids = {col.equivalence_group_id for col in conflicts}
    label_by_id: dict[int, str | None] = dict(
        db.query(EquivalenceGroup.id, EquivalenceGroup.label)
        .filter(EquivalenceGroup.id.in_(distinct_eg_ids))
        .all()
    )

    raise HTTPException(
        status_code=409,
        detail={
            "error": "column_already_linked",
            "message": (
                "Column is already linked to a different equivalence group. "
                "Unlink it first, or merge the two groups."
            ),
            "conflicts": [
                {
                    "column_id": col.id,
                    "column_code": col.column_code,
                    "current_group_id": col.equivalence_group_id,
                    "current_group_label": label_by_id.get(col.equivalence_group_id),
                }
                for col in conflicts
            ],
        },
    )


def assert_cross_dataset_members_are_paired(
    db: Session,
    member_ids: list[int],
    existing_member_ids: list[int] | None = None,
) -> None:
    """Raise 409 if the final domain member set would span multiple datasets
    but contains any column that isn't linked via equivalence groups to a
    column in a different dataset within the same member set.

    This restores the pre-migration-025 invariant (see #290): an
    AnalysisDomain whose members span 2+ datasets must have every member
    participate in an EquivalenceGroup that bridges to at least one other
    dataset in the same domain. Before Feb 17 2026 this was enforced via
    the `member_type='equivalence_group'` variant that was removed in the
    consolidation refactor.

    Args:
        member_ids: column IDs being added (or the full set for create).
        existing_member_ids: current member IDs already in the target
            domain (for add_members), or None for create.
    """
    all_ids = list(dict.fromkeys(list(member_ids) + list(existing_member_ids or [])))
    if not all_ids:
        return

    cols = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.id.in_(all_ids))
        .all()
    )
    datasets_in_domain = {c.dataset_id for c in cols}
    if len(datasets_in_domain) < 2:
        return  # single-dataset domain — constraint doesn't apply

    # Build eg_id → set of dataset_ids represented in this domain member set
    eg_to_datasets: dict[int, set[int]] = {}
    for c in cols:
        if c.equivalence_group_id is None:
            continue
        eg_to_datasets.setdefault(c.equivalence_group_id, set()).add(c.dataset_id)

    # For each member, check that its equivalence group bridges to another dataset
    unpaired: list[dict] = []
    for c in cols:
        if c.equivalence_group_id is None:
            unpaired.append({
                "id": c.id,
                "column_code": c.column_code,
                "column_text": c.column_text,
                "dataset_id": c.dataset_id,
            })
            continue
        other_datasets = eg_to_datasets.get(c.equivalence_group_id, set()) - {c.dataset_id}
        if not other_datasets:
            unpaired.append({
                "id": c.id,
                "column_code": c.column_code,
                "column_text": c.column_text,
                "dataset_id": c.dataset_id,
            })

    if unpaired:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "cross_dataset_unpaired",
                "message": (
                    "Cross-dataset analysis domain members must be linked via "
                    "equivalence groups. Pair these columns with their equivalents "
                    "in the other datasets first, or remove them from the domain."
                ),
                "unpaired_columns": unpaired,
            },
        )


def assert_domains_intact_after_mutation(
    db: Session,
    affected_column_ids: list[int],
) -> None:
    """Raise 409 `cross_dataset_unpaired` if any `AnalysisDomain` containing
    one or more of `affected_column_ids` would be left with unpaired
    cross-dataset members after the in-progress mutation.

    Used to pull #298's invariant catch forward from runtime (next-compute)
    to mutation time. Wired into side-channel mutators that don't directly
    touch domain members but can break domain pairing through their effect on
    `DatasetColumn.equivalence_group_id`:

    - `equivalence.py::remove_columns` (column unlinks from EG)
    - `equivalence.py::delete_group` (whole EG deleted, members unlink)
    - `equivalence.py::merge_groups` (source columns reassigned to target EG;
      can shift a column out of a domain's effective pairing without that
      domain's members appearing to change)

    The runtime late-catch in `services/metrics.py::_assert_domain_members_paired`
    stays as the safety net; this validator is the proactive pass that
    rejects at mutation time so the researcher gets a friendly 409 instead
    of a metric-compute ValueError days later.

    Args:
        affected_column_ids: Columns whose `equivalence_group_id` was just
            changed (or whose membership in an EG was just severed). The
            validator looks up all domains containing any of these as members
            and re-validates each one.

    Raises:
        HTTPException(409): structured `cross_dataset_unpaired` detail
            (same shape as `assert_cross_dataset_members_are_paired`).
    """
    if not affected_column_ids:
        return

    # Load the set of analysis domains that contain any of the affected columns
    # as members (member_type='column').
    affected_domain_id_rows = (
        db.query(AnalysisDomainMember.domain_id)
        .filter(
            AnalysisDomainMember.member_type == "column",
            AnalysisDomainMember.member_id.in_(affected_column_ids),
        )
        .distinct()
        .all()
    )

    for (domain_id,) in affected_domain_id_rows:
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
        # raise propagates up through the calling router and rolls back the
        # transaction atomically (no commit before this point).
        assert_cross_dataset_members_are_paired(db, member_col_ids)


def assert_domains_intact_for_domain_ids(
    db: Session,
    domain_ids: list[int],
) -> None:
    """Validate I2 cross-dataset pairing for domains identified by ID.

    Sibling of `assert_domains_intact_after_mutation` for cascade-deletion
    paths (Dataset / DatasetColumn delete) where the side-channel cleanup
    has ALREADY removed the AnalysisDomainMember rows for the deleted
    columns. The column-driven helper can't find the affected domains in
    that case (zero member rows match), so the cascade subset of the #298
    invariant gap (`Section E`, mutation catalog) needs a domain-ID-driven
    variant.

    Caller pattern: capture domain IDs BEFORE the cascade removes member
    rows; call this helper AFTER the cascade has run (members deleted, EG
    unlinks flushed) but BEFORE the empty-domain cleanup pass — that way
    the validator sees the post-cascade state of every domain that's not
    about to be deleted.

    Skips empty domains (`member_count == 0`) — those will be cleaned up
    by the caller's empty-domain pass and aren't a correctness violation.

    Enriches the standard `cross_dataset_unpaired` 409 detail with
    `domain_id` and `domain_name` so the frontend can pinpoint which
    domain blocked the delete instead of the user having to cross-reference
    column IDs.

    Args:
        domain_ids: Domain IDs to validate. Empty list short-circuits.

    Raises:
        HTTPException(409): structured `cross_dataset_unpaired` detail
            with `domain_id` + `domain_name` keys added.
    """
    if not domain_ids:
        return

    for domain_id in domain_ids:
        member_col_ids = [
            row[0] for row in
            db.query(AnalysisDomainMember.member_id)
            .filter(
                AnalysisDomainMember.domain_id == domain_id,
                AnalysisDomainMember.member_type == "column",
            )
            .all()
        ]
        if not member_col_ids:
            # Domain has no remaining members — caller's empty-domain
            # cleanup pass will handle it.
            continue

        try:
            assert_cross_dataset_members_are_paired(db, member_col_ids)
        except HTTPException as e:
            # Enrich the 409 with domain context so the frontend can show a
            # specific "Cannot delete: domain X would be left unpaired" toast.
            domain = (
                db.query(AnalysisDomain)
                .filter(AnalysisDomain.id == domain_id)
                .first()
            )
            domain_name = domain.name if domain else f"#{domain_id}"
            detail = e.detail
            if isinstance(detail, dict):
                detail = {
                    **detail,
                    "domain_id": domain_id,
                    "domain_name": domain_name,
                    "message": (
                        f"Cannot complete this operation: it would leave the "
                        f"analysis domain '{domain_name}' with unpaired "
                        f"cross-dataset members. Repair the domain first — "
                        f"remove the unpaired columns or pair them with "
                        f"equivalents in the other datasets."
                    ),
                }
            raise HTTPException(status_code=e.status_code, detail=detail) from e


def assert_domain_members_numeric_eligible(
    db: Session,
    member_column_ids: list[int],
) -> None:
    """Raise 400 `non_numeric_domain` when every column member of an analysis
    domain is of a non-numeric type (nominal/binary/multi-select/open-text/
    demographic), which would silently produce `valid_n=0` from a
    `domain_aggregate` scale-score metric.

    Mirrors the #347 fix pattern (which rejects `domain_aggregate +
    grouping_column_id` at create time) on the no-grouping path. Surfaced by
    scenario 2 hardening (#350) — the crosswalk's
    `create-score-metric` endpoint accepted a cross-dataset domain whose 3
    members were all `nominal` `School` columns, persisted a `domain_aggregate`
    metric, and compute returned 176 `RowScore` rows all with `score=null`
    plus a single `ComputedResult` with `valid_n=0`. No error surfaced.

    Strict semantics: reject when ALL members are non-numeric. Mixed sets
    (≥1 numeric-eligible member) pass — `compute_domain_aggregate` already
    drops non-numeric rows correctly when there's something numeric to
    aggregate.

    Empty member list → silent pass. An empty-domain `domain_aggregate` is
    a separate problem; the resolver returns `{}` and the metric compute
    short-circuits without confusion.

    Numeric-eligible types: `ORDINAL`, `NUMERIC`, `PERCENTAGE`. See
    `NUMERIC_ELIGIBLE_COLUMN_TYPES` above.

    Args:
        db: Active session.
        member_column_ids: Column IDs that will be (or are already) members
            of the domain. For create paths, pass the proposed member list.
            For idempotent / update paths, pass the post-mutation member list.

    Raises:
        HTTPException(400): structured detail with `error="non_numeric_domain"`,
            human-readable `message`, and `columns` listing the offending
            members with their types so the frontend can surface a specific
            "column X is type Y" error.
    """
    if not member_column_ids:
        return

    cols = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.id.in_(member_column_ids))
        .all()
    )
    if not cols:
        return

    # Strict: reject only when EVERY member is non-numeric. A mix of numeric
    # + nominal columns is allowed; the aggregate skips the nominal ones at
    # compute time, which is the intended fallback behavior.
    numeric_members = [c for c in cols if c.column_type in NUMERIC_ELIGIBLE_COLUMN_TYPES]
    if numeric_members:
        return

    offending = [
        {
            "id": c.id,
            "column_code": c.column_code,
            "column_text": c.column_text,
            "column_type": (
                c.column_type.value if hasattr(c.column_type, "value") else str(c.column_type)
            ),
        }
        for c in cols
    ]
    type_summary = sorted({o["column_type"] for o in offending})

    raise HTTPException(
        status_code=400,
        detail={
            "error": "non_numeric_domain",
            "message": (
                "Scale scores need at least one numeric, percentage, or "
                "ordinal member. Every column in this domain is of type "
                f"{', '.join(type_summary)} — domain aggregation would "
                "produce no scores. Change a column's type in the Recode "
                "workbench, add a numeric member, or use a different metric "
                "(e.g. frequency on a single column) for this domain."
            ),
            "columns": offending,
        },
    )
