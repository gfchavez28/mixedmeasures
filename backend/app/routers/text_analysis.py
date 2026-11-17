"""Router for text cross-analysis — subgroup filtering, cross-tabulation,
code density, and response length analysis for coded open-ended text responses."""

import io
import csv
import json
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import get_db
from ..models.user import User
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.code_application import CodeApplication
from ..models.code import Code
from ..models.recode import RecodeDefinition
from ..services.grouping import (
    load_grouping_values,
    order_value_labels,
    value_label_sort_key,
)
from ..services.recode import _parse_mapping
from ..services.text_analysis import (
    compute_comment_frequencies,
    get_non_empty_comment_values,
    treat_as_empty_for_project,
)
from ..services.coding_layers import LAYER_CONSENSUS, layer_scope_filter
from ..services.code_analysis import rating_grouping_refusal
from ..services.id_set import in_id_set
from ..services.participant_scores import withheld_rating_columns_in_project
from ..auth import get_current_user
from .code_analysis import _blind_scope
from .helpers import _get_project_or_404, coder_scope_names, parse_int_list, sanitize_content_disposition, TEXT_TYPES
from .export_helpers import csv_safe
from ..schemas.text_analysis import (
    SubgroupFilter,
    FilteredFrequenciesRequest, CrossTabulationRequest,
    FilteredFrequenciesResponse, FrequencySet, CodeFrequencyBrief,
    CrossTabulationResponse, CrossTabRow,
    CodeDensityResponse, CodeDensityGroup,
    ResponseLengthResponse, ResponseLengthCode, ResponseLengthUncoded,
)

router = APIRouter(
    prefix="/api/projects/{project_id}/text-analysis",
    tags=["text-analysis"],
)




def _validate_text_columns(db: Session, project_id: int, column_ids: list[int]) -> list[DatasetColumn]:
    """Validate column_ids belong to project and are comment types."""
    column_ids = list(dict.fromkeys(column_ids))  # deduplicate preserving order
    columns = (
        db.query(DatasetColumn)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            DatasetColumn.id.in_(column_ids),
            Dataset.project_id == project_id,
            DatasetColumn.column_type.in_(TEXT_TYPES),
        )
        .all()
    )
    if len(columns) != len(column_ids):
        found_ids = {c.id for c in columns}
        missing = [cid for cid in column_ids if cid not in found_ids]
        raise HTTPException(
            status_code=400,
            detail=f"Column IDs {missing} not found or not text columns in this project",
        )
    return columns




#: #1534 (1.5.9) — the operators a subgroup filter may use, by what they need.
_LIST_OPERATORS = ("equals", "in")
_VALUE_OPERATORS = ("gte", "lte")
_MEAN_OPERATORS = ("above_mean", "below_mean")


def _refuse_unreadable_filters(filters) -> None:
    """#1534 D104 (1.5.9) — a filter that names no selection is REFUSED, never read as none.

    Before, the CSV export caught a filter list it could not read and wrote
    ``Filters,None`` above every code's overall count, while the screen's route
    answered 422; an ``in`` filter with nothing selected silently matched no record.
    The panel sends only finished filters (`lib/subgroup-filters.ts::readyFilters`),
    so this is the backstop both routes share: a 400 that says what is missing.
    """
    for f in filters:
        if f.operator not in _LIST_OPERATORS + _VALUE_OPERATORS + _MEAN_OPERATORS:
            raise HTTPException(status_code=400, detail=f"Unknown operator: {f.operator}")
        if f.operator in _LIST_OPERATORS and not f.values:
            raise HTTPException(
                status_code=400,
                detail=f"The filter on column {f.column_id} has no value selected.",
            )
        if f.operator in _VALUE_OPERATORS and f.value is None:
            raise HTTPException(
                status_code=400,
                detail=f"The filter on column {f.column_id} has no number to compare with.",
            )


def parse_filters_json(filters_json: str) -> list:
    """#1534 D104 (1.5.9) — the export's `filters_json`, read strictly: unreadable is a 400.

    The old reader caught JSON and schema errors and went on with NO filters, so the
    file said ``Filters,None`` about filters it had been asked for.
    """
    try:
        raw = json.loads(filters_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="filters_json is not valid JSON.")
    if not isinstance(raw, list) or not all(isinstance(f, dict) for f in raw):
        raise HTTPException(status_code=400, detail="filters_json must be a list of filters.")
    try:
        return [SubgroupFilter.model_validate(f) for f in raw]
    except ValidationError as exc:
        first = exc.errors()[0]
        raise HTTPException(status_code=400, detail=f"A filter could not be read: {first['msg']}.")


def _fmt_filter_number(x: float) -> str:
    """40.0 → "40", 2.5 → "2.5" — a filter's number as the researcher typed it."""
    return f"{x:g}"


def describe_filter(filt, col: DatasetColumn, mean: float | None = None) -> str:
    """#1534 D105 (1.5.9) — what ONE filter selects, in the panel's words and in ASCII.

    The description is the file's ``Filters`` line and the screen figure's accessible
    name. It used to be ``"region: in"`` — no values — so two different subgroups wrote
    the same line, and a mean filter never said which mean. ASCII because the export
    writes no byte-order mark and Excel misreads anything else in it.
    """
    name = col.column_name or col.column_text or f"Column {col.id}"
    op = filt.operator
    if op == "in":
        return f"{name} is one of {', '.join(filt.values or [])}"
    if op == "equals":
        return f"{name} equals {' or '.join(filt.values or [])}"
    if op == "gte":
        return f"{name} at least {_fmt_filter_number(filt.value)}"
    if op == "lte":
        return f"{name} at most {_fmt_filter_number(filt.value)}"
    side = "above" if op == "above_mean" else "below"
    if mean is None:
        return f"{name} {side} its mean (no numeric answers)"
    return f"{name} {side} its mean ({mean:.2f})"


#: #1534 D108 — the export's Response Length heading while filters apply: that section
#: has never been filtered (nor has the panel's), and the file printed it under the
#: ``Filters`` line without saying so. Screen twin: `CrossAnalysisPanel`'s
#: `FILTERS_REACH_NOTE`.
RESPONSE_LENGTH_UNFILTERED_HEADING = "Response Length by Code (all texts; the filters do not apply)"


def not_compared_note(names: list[str]) -> str:
    """#1534 D107 — the datasets left out of a comparison, said once (screen twin:
    `CrossAnalysisPanel`'s sentence over `filter_scope.unfiltered_datasets`)."""
    whose = "its" if len(names) == 1 else "their"
    return f"{'; '.join(names)} (no filter applies to {whose} records)"


#: #1615 — why a subgroup filter on a variable worked out from participant scores is refused
#: while blind. The grouping refusal's words (`code_analysis.rating_grouping_refusal`, D284),
#: said of a FILTER: who a threshold on a score keeps (``score ≥ 3``, moved by halves) reads
#: each person's every-coder score off, and a mean filter prints the mean itself.
def rating_filter_refusal(name: str) -> str:
    return (f"“{name}” cannot filter while blind: it comes from participant scores, "
            "which combine every coder's ratings, so who it keeps would show your "
            "colleagues' judgements.")


def _refuse_rating_grouping(db: Session, project_id: int, column: DatasetColumn, blind_scope) -> None:
    """#1615 — a cross-tab variable or a density grouping worked out from participant scores
    is refused while blind (409, D284's words) — never dropped: the grouping IS the figure."""
    if column.id in withheld_rating_columns_in_project(db, project_id, blind_scope):
        raise HTTPException(
            status_code=409,
            detail=rating_grouping_refusal(column.column_name or column.column_text),
        )


def _apply_filters(db: Session, project_id: int, filters, focal_column_ids: list[int], *, blind_scope):
    """Apply subgroup filters and return the matching DatasetRow IDs.

    🔴 #1534 D107 (1.5.9): **a focal dataset no filter can judge is NOT compared.**
    It used to contribute EVERY record to the filtered side — with questions from
    two datasets and a filter on one, the panel said "7 records match" when 3 did,
    and the filtered percentages blended in the other dataset's answers. Its texts
    are now left out of BOTH sides (the caller reads `compared_column_ids` for the
    overall too), so the comparison sets a subgroup beside the population it was
    drawn from, and `filter_scope.unfiltered_datasets` names what was left out.

    🔴 #1615: ``blind_scope`` is REQUIRED (the grouping gates' shape) — the viewer's coder
    ids while blind mode withholds (`ratings_follow_coder_ids`), else None. A filter on a
    column the participant table's snapshot fills from a coder outside it (a score, its
    rated-passage count, a band computed from one) is REFUSED whole with 409 — before its
    rows or its mean are read, so `describe_filter` never prints an every-coder mean.
    Never dropped: the comparison would then be of a different subgroup than the pills say.

    Returns:
        tuple: (filtered_row_ids: set[int] | None, filter_description: str,
                filter_scope: dict with filtered_datasets and unfiltered_datasets,
                compared_column_ids: list[int] — the focal columns the filters judge;
                every focal column when there are no filters)
    """
    if not filters:
        return (
            None, "No filters applied",
            {"filtered_datasets": [], "unfiltered_datasets": []},
            list(focal_column_ids),
        )
    _refuse_unreadable_filters(filters)

    # Gather info about which datasets contain focal columns
    focal_cols = (
        db.query(DatasetColumn.id, DatasetColumn.dataset_id)
        .filter(DatasetColumn.id.in_(focal_column_ids))
        .all()
    )
    focal_dataset_ids = {fc.dataset_id for fc in focal_cols}

    # Group filters by their column's dataset
    filter_col_ids = [f.column_id for f in filters]
    filter_cols = (
        db.query(DatasetColumn)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            DatasetColumn.id.in_(filter_col_ids),
            Dataset.project_id == project_id,
        )
        .all()
    )
    col_map = {c.id: c for c in filter_cols}

    # Validate all filter columns exist
    for f in filters:
        if f.column_id not in col_map:
            raise HTTPException(
                status_code=400,
                detail=f"Filter column {f.column_id} not found in project",
            )

    # #1615 — asked once, of every filter, before any is resolved (docstring).
    withheld = withheld_rating_columns_in_project(db, project_id, blind_scope)
    for f in filters:
        if f.column_id in withheld:
            col = col_map[f.column_id]
            raise HTTPException(
                status_code=409, detail=rating_filter_refusal(col.column_name or col.column_text))

    # Group filters by dataset_id
    dataset_filters: dict[int, list] = defaultdict(list)
    for f in filters:
        col = col_map[f.column_id]
        dataset_filters[col.dataset_id].append((f, col))

    # Per-dataset filter resolution: intersect within each dataset
    per_dataset_rows: dict[int, set[int]] = {}
    filter_parts = []
    filtered_dataset_names = []
    unfiltered_dataset_names = []

    # Batch-load all relevant datasets in one query
    all_relevant_ds_ids = set(dataset_filters.keys()) | set(focal_dataset_ids)
    ds_name_map: dict[int, str] = {}
    if all_relevant_ds_ids:
        ds_rows = db.query(Dataset.id, Dataset.name).filter(Dataset.id.in_(all_relevant_ds_ids)).all()
        ds_name_map = {d.id: d.name for d in ds_rows}

    for ds_id, ds_filters in dataset_filters.items():
        if ds_id in ds_name_map:
            filtered_dataset_names.append(ds_name_map[ds_id])

        row_sets = []
        for filt, col in ds_filters:
            matching_rows, mean = _resolve_filter_rows(db, filt, col)
            row_sets.append(matching_rows)
            filter_parts.append(describe_filter(filt, col, mean))

        # Intersect all filter results within this dataset
        if row_sets:
            combined = row_sets[0]
            for rs in row_sets[1:]:
                combined = combined & rs
            per_dataset_rows[ds_id] = combined

    # #1534 D107 — a focal dataset with no filter on it is NOT compared (docstring).
    for ds_id in sorted(focal_dataset_ids - set(per_dataset_rows)):
        if ds_id in ds_name_map:
            unfiltered_dataset_names.append(ds_name_map[ds_id])
    dataset_of = {fc.id: fc.dataset_id for fc in focal_cols}
    compared_column_ids = [cid for cid in focal_column_ids if dataset_of.get(cid) in per_dataset_rows]

    # Combine the judged datasets' matching row IDs
    all_row_ids: set[int] = set()
    for rows in per_dataset_rows.values():
        all_row_ids |= rows

    filter_desc = "; ".join(filter_parts) if filter_parts else "No filters"

    return (
        all_row_ids,
        filter_desc,
        {
            "filtered_datasets": filtered_dataset_names,
            "unfiltered_datasets": unfiltered_dataset_names,
        },
        compared_column_ids,
    )


def _resolve_filter_rows(db: Session, filt, col: DatasetColumn) -> tuple[set[int], float | None]:
    """Resolve a single filter to a set of DatasetRow IDs, and the mean a mean filter used.

    #1534 D104: an unfinished filter never reaches here (`_refuse_unreadable_filters`).
    """
    base_q = (
        db.query(DatasetValue.row_id)
        .filter(DatasetValue.column_id == col.id)
    )

    if filt.operator in _LIST_OPERATORS:
        rows = base_q.filter(DatasetValue.value_text.in_(filt.values)).all()
        return {r.row_id for r in rows}, None

    if filt.operator == "gte":
        rows = base_q.filter(DatasetValue.value_numeric >= filt.value).all()
        return {r.row_id for r in rows}, None

    if filt.operator == "lte":
        rows = base_q.filter(DatasetValue.value_numeric <= filt.value).all()
        return {r.row_id for r in rows}, None

    # above_mean / below_mean — the operator set was checked by the caller.
    mean_result = (
        db.query(func.avg(DatasetValue.value_numeric))
        .filter(
            DatasetValue.column_id == col.id,
            DatasetValue.value_numeric.isnot(None),
        )
        .scalar()
    )
    if mean_result is None:
        return set(), None
    if filt.operator == "above_mean":
        rows = base_q.filter(DatasetValue.value_numeric > mean_result).all()
    else:
        rows = base_q.filter(DatasetValue.value_numeric < mean_result).all()
    return {r.row_id for r in rows}, float(mean_result)


def _word_totals_by_code(
    value_ids: list[int], value_codes: dict[int, set[int]], word_counts: dict[int, int],
) -> tuple[dict[int, int], dict[int, int]]:
    """Per code: the summed word count and the number of texts carrying it.

    One pass over the texts, shared by the response-length endpoint and the
    cross-analysis export — both used to rescan every text once per code (#956).
    Integer sums, divided once by the caller, so the averages are unchanged.
    """
    word_sum: dict[int, int] = defaultdict(int)
    text_count: dict[int, int] = defaultdict(int)
    for vid in value_ids:
        for code_id in value_codes.get(vid, ()):
            word_sum[code_id] += word_counts[vid]
            text_count[code_id] += 1
    return word_sum, text_count


def _to_frequency_set(result: dict) -> FrequencySet:
    """Adapt a `compute_comment_frequencies` result dict to the `FrequencySet` schema.

    Track J · J2 slab 3b — the `filtered-frequencies` endpoint + the CSV export now
    delegate their counting to `services/text_analysis.compute_comment_frequencies`
    (DISTINCT dataset-value + consensus-layer exclusion, single-sourced AND tested)
    instead of a parallel inline count that silently inflated per coder AND counted
    the derived consensus layer once it materialized.
    """
    return FrequencySet(
        row_count=result["row_count"],
        text_count=result["text_count"],
        frequencies=[CodeFrequencyBrief(**f) for f in result["frequencies"]],
    )


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/filtered-frequencies", response_model=FilteredFrequenciesResponse)
def filtered_frequencies(
    project_id: int,
    body: FilteredFrequenciesRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get code frequencies for comment columns, optionally filtered by subgroup."""
    _get_project_or_404(db, project_id, user.id)
    columns = _validate_text_columns(db, project_id, body.column_ids)
    column_ids = [c.id for c in columns]

    # Apply filters. #1534 D107: both sides read only the columns the filters judge.
    filtered_row_ids, filter_desc, filter_scope, compared_ids = _apply_filters(
        db, project_id, body.filters, column_ids,
        blind_scope=_blind_scope(body.coder_ids, body.ratings_follow_coder_ids, ratings_viewer_id=None),  # #1615
    )

    filtered_set = _to_frequency_set(compute_comment_frequencies(
        db, project_id, compared_ids,
        row_ids=list(filtered_row_ids) if filtered_row_ids is not None else None,
        coder_ids=body.coder_ids, layer_scope=body.layer_scope,
    ))

    # Overall: the same datasets, unfiltered
    overall_set = None
    if body.include_overall and body.filters:
        overall_set = _to_frequency_set(compute_comment_frequencies(
            db, project_id, compared_ids,
            coder_ids=body.coder_ids, layer_scope=body.layer_scope,
        ))

    return FilteredFrequenciesResponse(
        filtered=filtered_set,
        overall=overall_set,
        filter_description=filter_desc,
        filter_scope=filter_scope,
    )


@router.post("/cross-tabulation", response_model=CrossTabulationResponse)
def cross_tabulation(
    project_id: int,
    body: CrossTabulationRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Build a code x response-value cross-tabulation matrix."""
    _get_project_or_404(db, project_id, user.id)
    comment_columns = _validate_text_columns(db, project_id, body.text_column_ids)
    comment_col_ids = [c.id for c in comment_columns]

    # Validate cross column
    cross_col = (
        db.query(DatasetColumn)
        .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
        .filter(
            DatasetColumn.id == body.cross_column_id,
            Dataset.project_id == project_id,
        )
        .first()
    )
    if not cross_col:
        raise HTTPException(status_code=400, detail="Cross-tab column not found in project")
    # #1615 — refused while blind when worked out from participant scores. Asked of the
    # column whatever its dataset: the cross-tab follows participant links (below).
    _refuse_rating_grouping(
        db, project_id, cross_col, _blind_scope(body.coder_ids, body.ratings_follow_coder_ids, ratings_viewer_id=None))

    # Build the ordered list of cross-column values (these become the cross-tab
    # columns). They are the original text labels stored in value_text — both the
    # recode `mapping` (keyed on labels) and row_to_cross_value below key on
    # value_text, so the order set must be labels, not recode targets.
    #
    # When the cross column has a primary recode, order the labels by the
    # recode's numeric mapping so columns read low→high (e.g. Standard →
    # Premium); unmapped/non-numeric values sort alphabetically after the
    # mapped ones. Without a recode, order is alphabetical.
    #
    # NOTE: the model field is `mapping` ({label: value}); an older `.definition`
    # shape no longer exists. Reading `primary_recode.definition` here used to
    # raise AttributeError → 500 for any cross column with a primary recode (#362).
    primary_recode = (
        db.query(RecodeDefinition)
        .filter(
            RecodeDefinition.column_id == cross_col.id,
            RecodeDefinition.is_primary == True,
        )
        .first()
    )

    # Build row_id -> cross_value through the shared grouping loader (#597):
    # it applies the #384 N/A rule, so a recognized-missing label ("N/A",
    # "Decline to state") never becomes a cross-tab column here while folding
    # into the missing bucket on every quantitative surface. row_ids=None =
    # every row holding a value in the cross column (this endpoint's scope).
    row_to_cross_value = load_grouping_values(db, cross_col.id, None)

    # The candidate axis set derives from values actually present (post-N/A):
    # never an empty column for a mapped-but-absent label, never a dropped
    # present-but-unmapped value. Alphabetical pre-sort keeps ties in
    # _cross_value_key deterministic (sorted() is stable).
    raw_values = sorted({v for v in row_to_cross_value.values() if v})

    order_map: dict[str, float] = {}
    if primary_recode:
        for label, target in _parse_mapping(primary_recode).items():
            try:
                order_map[label.strip().lower()] = float(target)
            except (TypeError, ValueError):
                pass  # category_group target is a group name, not numeric → alphabetical

    # Mapped labels first (by the recode's numeric value); unmapped after, in
    # numeric-aware order (#406: numeric labels sort numerically, text labels
    # keep alphabetical — was a flat stable-alphabetical fallback).
    def _cross_value_key(v: str):
        lv = v.strip().lower()
        if lv in order_map:
            return (0, (0, order_map[lv], ""))
        return (1, value_label_sort_key(v))

    response_values = sorted(raw_values, key=_cross_value_key)

    cross_dataset_id = cross_col.dataset_id

    # Get comment values from the same dataset (or linked via participant)
    treat_as_empty = treat_as_empty_for_project(db, project_id)
    comment_values = get_non_empty_comment_values(db, comment_col_ids, treat_as_empty)

    # Build: for each comment value, find its cross-tab value
    # Direct: same dataset
    comment_col_dataset_map = {c.id: c.dataset_id for c in comment_columns}

    # Load active codes
    codes = (
        db.query(Code)
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
        .all()
    )
    if body.code_ids:
        code_id_set = set(body.code_ids)
        codes = [c for c in codes if c.id in code_id_set]

    # Load code applications for these comment values
    value_ids = [v.id for v in comment_values]
    if not value_ids:
        return CrossTabulationResponse(
            cross_column_name=cross_col.column_name or cross_col.column_text,
            response_values=response_values,
            matrix=[],
            column_totals={rv: 0 for rv in response_values},
            total_coded_texts=0,
        )

    # #956: every substantive value of the selected columns — rows × columns.
    code_apps_q = (
        db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
        .filter(in_id_set(CodeApplication.dataset_value_id, value_ids), layer_scope_filter(body.layer_scope))
    )
    if body.coder_ids and body.layer_scope != LAYER_CONSENSUS:
        code_apps_q = code_apps_q.filter(CodeApplication.user_id.in_(body.coder_ids))
    code_apps = code_apps_q.all()
    # Map value_id -> set of code_ids
    value_code_map: dict[int, set[int]] = defaultdict(set)
    for ca in code_apps:
        value_code_map[ca.dataset_value_id].add(ca.code_id)

    # For each response value, count codes
    # counts[code_id][response_value] = count
    counts: dict[int, dict[str, int]] = {c.id: defaultdict(int) for c in codes}
    column_totals: dict[str, int] = defaultdict(int)
    total_coded = 0

    # Pre-load cross-dataset linkage data to avoid N+1 queries:
    # 1. Collect row_ids that are NOT in the cross column's dataset
    cross_dataset_row_ids = set()
    for dv in comment_values:
        if comment_col_dataset_map.get(dv.column_id) != cross_dataset_id:
            cross_dataset_row_ids.add(dv.row_id)

    # 2. Batch-load DatasetRow.participant_id for those row_ids
    row_participant_map: dict[int, int | None] = {}
    if cross_dataset_row_ids:
        rows = (
            db.query(DatasetRow.id, DatasetRow.participant_id)
            .filter(in_id_set(DatasetRow.id, cross_dataset_row_ids))
            .all()
        )
        row_participant_map = {r.id: r.participant_id for r in rows}

    # 3. Batch-load linked rows in the cross column's dataset by participant_id
    participant_to_cross_row: dict[int, int] = {}
    linked_participant_ids = {pid for pid in row_participant_map.values() if pid is not None}
    if linked_participant_ids:
        linked_rows = (
            db.query(DatasetRow.id, DatasetRow.participant_id)
            .filter(
                DatasetRow.dataset_id == cross_dataset_id,
                in_id_set(DatasetRow.participant_id, linked_participant_ids),
            )
            .all()
        )
        for lr in linked_rows:
            participant_to_cross_row[lr.participant_id] = lr.id

    for dv in comment_values:
        dv_dataset_id = comment_col_dataset_map.get(dv.column_id)
        cross_val = None

        if dv_dataset_id == cross_dataset_id:
            # Same dataset — direct lookup
            cross_val = row_to_cross_value.get(dv.row_id)
        else:
            # Cross-dataset: use pre-loaded participant linkage
            participant_id = row_participant_map.get(dv.row_id)
            if participant_id is not None:
                linked_row_id = participant_to_cross_row.get(participant_id)
                if linked_row_id is not None:
                    cross_val = row_to_cross_value.get(linked_row_id)

        if cross_val is None or cross_val not in response_values:
            continue

        applied_codes = value_code_map.get(dv.id, set())
        if not applied_codes:
            continue

        total_coded += 1
        column_totals[cross_val] += 1
        for code in codes:
            if code.id in applied_codes:
                counts[code.id][cross_val] += 1

    # Build matrix rows
    matrix = []
    for code in codes:
        row_counts = {rv: counts[code.id].get(rv, 0) for rv in response_values}
        row_total = sum(row_counts.values())
        row_pcts = {}
        for rv in response_values:
            col_total = column_totals.get(rv, 0)
            row_pcts[rv] = round(row_counts[rv] / col_total * 100, 1) if col_total else 0.0
        matrix.append(CrossTabRow(
            code_id=code.id,
            code_name=code.name,
            code_color=code.color,
            counts=row_counts,
            percentages=row_pcts,
            row_total=row_total,
        ))

    return CrossTabulationResponse(
        cross_column_name=cross_col.column_name or cross_col.column_text,
        response_values=response_values,
        matrix=matrix,
        column_totals=dict(column_totals),
        total_coded_texts=total_coded,
    )


@router.get("/code-density", response_model=CodeDensityResponse)
def code_density(
    project_id: int,
    column_ids: str = Query(..., description="Comma-separated focal column IDs"),
    group_by_column_id: int | None = Query(None, description="Column to group by"),
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs; omit/empty = all coders"),
    # Bare default (not Query(None)) so direct-call tests don't bind the sentinel — see backend/tests/the internal design notes.
    layer_scope: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    # #1615 — sent ONLY while blind mode withholds (D273): a grouping worked out from
    # participant scores is then refused. Bare default (backend/tests/the internal design notes).
    ratings_follow_coder_ids: bool = False,
):
    """Average number of codes applied per comment, optionally grouped."""
    _get_project_or_404(db, project_id, user.id)
    col_id_list = parse_int_list(column_ids) or []
    if not col_id_list:
        raise HTTPException(status_code=400, detail="column_ids required")

    parsed_coder_ids = parse_int_list(coder_ids)

    _validate_text_columns(db, project_id, col_id_list)

    # Get substantive (non-empty, non-N/A) text values — must match the gauge (#519)
    comment_values = get_non_empty_comment_values(
        db, col_id_list, treat_as_empty_for_project(db, project_id))
    value_ids = [v.id for v in comment_values]

    # Count DISTINCT codes per value (Track J · J2: two coders applying the same
    # code to one value are two rows but ONE code; exclude the consensus layer).
    if value_ids:
        code_counts_query = (
            db.query(CodeApplication.dataset_value_id, func.count(func.distinct(CodeApplication.code_id)))
            .filter(in_id_set(CodeApplication.dataset_value_id, value_ids), layer_scope_filter(layer_scope))
        )
        if parsed_coder_ids and layer_scope != LAYER_CONSENSUS:
            code_counts_query = code_counts_query.filter(CodeApplication.user_id.in_(parsed_coder_ids))
        code_counts_q = code_counts_query.group_by(CodeApplication.dataset_value_id).all()
    else:
        code_counts_q = []
    codes_per_value = dict(code_counts_q)

    # Overall
    all_counts = [codes_per_value.get(v.id, 0) for v in comment_values]
    overall_avg = round(sum(all_counts) / len(all_counts), 2) if all_counts else 0.0
    overall = CodeDensityGroup(
        group_value="Overall",
        avg_codes_per_text=overall_avg,
        text_count=len(comment_values),
    )

    groups: list[CodeDensityGroup] = []

    if group_by_column_id:
        # Validate group column
        group_col = (
            db.query(DatasetColumn)
            .join(Dataset, DatasetColumn.dataset_id == Dataset.id)
            .filter(
                DatasetColumn.id == group_by_column_id,
                Dataset.project_id == project_id,
            )
            .first()
        )
        if not group_col:
            raise HTTPException(status_code=400, detail="Group column not found in project")
        _refuse_rating_grouping(  # #1615
            db, project_id, group_col, _blind_scope(parsed_coder_ids, ratings_follow_coder_ids, ratings_viewer_id=None))

        # Build row_id -> group_value through the shared grouping loader (#597):
        # applies the #384 N/A rule so a recognized-missing label never forms a
        # code-density group. row_ids=None = every row holding a group value.
        row_to_group = load_grouping_values(db, group_by_column_id, None)

        # Map comment values to groups
        grouped: dict[str, list[int]] = defaultdict(list)  # group_value -> [code_count, ...]
        for dv in comment_values:
            gv = row_to_group.get(dv.row_id)
            if gv:
                grouped[gv].append(codes_per_value.get(dv.id, 0))

        for gv in order_value_labels(grouped.keys()):  # #406
            counts_list = grouped[gv]
            avg = round(sum(counts_list) / len(counts_list), 2) if counts_list else 0.0
            groups.append(CodeDensityGroup(
                group_value=gv,
                avg_codes_per_text=avg,
                text_count=len(counts_list),
            ))

    return CodeDensityResponse(groups=groups, overall=overall)


@router.get("/response-length-by-code", response_model=ResponseLengthResponse)
def response_length_by_code(
    project_id: int,
    column_ids: str = Query(..., description="Comma-separated focal column IDs"),
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs; omit/empty = all coders"),
    # Bare default (not Query(None)) so direct-call tests don't bind the sentinel — see backend/tests/the internal design notes.
    layer_scope: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Average word count of comments by code applied."""
    _get_project_or_404(db, project_id, user.id)
    col_id_list = parse_int_list(column_ids) or []
    if not col_id_list:
        raise HTTPException(status_code=400, detail="column_ids required")

    parsed_coder_ids = parse_int_list(coder_ids)

    _validate_text_columns(db, project_id, col_id_list)

    # Get substantive (non-empty, non-N/A) text values — must match the gauge (#519)
    comment_values = get_non_empty_comment_values(
        db, col_id_list, treat_as_empty_for_project(db, project_id))
    value_ids = [v.id for v in comment_values]

    # Compute word counts
    word_counts: dict[int, int] = {}  # value_id -> word_count
    for dv in comment_values:
        word_counts[dv.id] = len(dv.value_text.split()) if dv.value_text else 0

    # Load code applications (exclude the consensus layer by default).
    if value_ids:
        code_apps_query = (
            db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
            .filter(in_id_set(CodeApplication.dataset_value_id, value_ids), layer_scope_filter(layer_scope))
        )
        if parsed_coder_ids and layer_scope != LAYER_CONSENSUS:
            code_apps_query = code_apps_query.filter(CodeApplication.user_id.in_(parsed_coder_ids))
        code_apps = code_apps_query.all()
    else:
        code_apps = []

    # Map value_id -> set of code_ids
    value_codes: dict[int, set[int]] = defaultdict(set)
    for ca in code_apps:
        value_codes[ca.dataset_value_id].add(ca.code_id)

    # Load active codes
    codes = (
        db.query(Code)
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
        .all()
    )

    # Per-code: avg word count of values with that code — ONE pass over the texts.
    # This rescanned every text once PER CODE, which on BES's 843,525 texts was
    # most of a 34 s request once #956 let it finish.
    code_word_sum, code_text_count = _word_totals_by_code(value_ids, value_codes, word_counts)
    code_results = []
    for code in codes:
        n = code_text_count.get(code.id, 0)
        avg = round(code_word_sum[code.id] / n, 1) if n else 0.0
        code_results.append(ResponseLengthCode(
            code_id=code.id,
            code_name=code.name,
            code_color=code.color,
            avg_words=avg,
            text_count=n,
        ))

    # Uncoded: values with no code applications
    uncoded_ids = [vid for vid in value_ids if vid not in value_codes]
    if uncoded_ids:
        wc_sum = sum(word_counts[vid] for vid in uncoded_ids)
        uncoded_avg = round(wc_sum / len(uncoded_ids), 1)
    else:
        uncoded_avg = 0.0

    return ResponseLengthResponse(
        codes=code_results,
        uncoded=ResponseLengthUncoded(avg_words=uncoded_avg, text_count=len(uncoded_ids)),
    )


@router.get("/export")
def export_cross_analysis(
    project_id: int,
    column_ids: str = Query(..., description="Comma-separated focal column IDs"),
    filters_json: str = Query("[]", description="JSON-encoded filters"),
    # NOTE: a `cross_column_id` param used to be accepted here but was never
    # read (#597) — dropped rather than wired into a third grouping query.
    coder_ids: str | None = Query(None, description="Comma-separated coder (user) IDs; omit/empty = all coders"),
    # Bare default (not Query(None)) so direct-call tests don't bind the sentinel — see backend/tests/the internal design notes.
    layer_scope: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    # #1615 — as `code-density`'s: a filter worked out from participant scores is refused.
    ratings_follow_coder_ids: bool = False,
):
    """Export cross-analysis as CSV.

    🔴 #1534 (1.5.9): **the client sent its filters as `filters=` from the day this
    was written (2026-02-19) while this route reads `filters_json`**, and FastAPI drops
    an undeclared query parameter without a word — so no release ever filtered this
    file: it said ``Filters,None`` above every code's overall count while the screen
    showed the comparison. The client sends `filters_json` now (D103), and
    `lib/api/request-contract.test.ts` (D110) holds every client request's names to
    the routes' declared ones. With them the file says what it selects (D105), its
    bases (D106), which focal datasets it could not compare (D107) and which section
    the filters do not reach (D108); a list it cannot read is a 400 (D104).
    """
    _get_project_or_404(db, project_id, user.id)
    col_id_list = parse_int_list(column_ids) or []
    if not col_id_list:
        raise HTTPException(status_code=400, detail="column_ids required")
    parsed_coder_ids = parse_int_list(coder_ids)

    columns = _validate_text_columns(db, project_id, col_id_list)

    # #1534 D104 — read strictly: a list it cannot read is a 400, never "no filters".
    filters = parse_filters_json(filters_json)

    # Load codes
    codes = (
        db.query(Code)
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
        .all()
    )

    # The counts first: the header block states their bases (D106).
    if filters:
        filtered_row_ids, filter_desc, filter_scope, compared_ids = _apply_filters(
            db, project_id, filters, col_id_list,
            blind_scope=_blind_scope(parsed_coder_ids, ratings_follow_coder_ids, ratings_viewer_id=None),  # #1615
        )
        # D107: both sides read only the columns the filters judge.
        overall = compute_comment_frequencies(
            db, project_id, compared_ids, coder_ids=parsed_coder_ids, layer_scope=layer_scope,
        )
        filtered = compute_comment_frequencies(
            db, project_id, compared_ids,
            row_ids=list(filtered_row_ids) if filtered_row_ids is not None else None,
            coder_ids=parsed_coder_ids, layer_scope=layer_scope,
        )
    else:
        freq = compute_comment_frequencies(
            db, project_id, col_id_list, coder_ids=parsed_coder_ids, layer_scope=layer_scope,
        )

    output = io.StringIO()
    writer = csv.writer(output)

    # Section 1: Filter description
    writer.writerow(["Cross-Analysis Export"])
    writer.writerow(["Columns", csv_safe(", ".join(c.column_name or c.column_text for c in columns))])

    if filters:
        writer.writerow(["Filters", csv_safe(filter_desc)])
    else:
        writer.writerow(["Filters", "None"])

    # #1531 D97 (1.5.9) — the coder scope is said beside the filters, because the
    # file holds only these coders' coding: while blind the panel asks for the
    # viewer's own, and a file that did not say so reads as every coder's. Under
    # the consensus layer `coder_ids` is moot (one synthetic coder — the reads
    # below skip it there too), so nothing is said; no scope, no line (the
    # unscoped file is byte-identical to before).
    if parsed_coder_ids and layer_scope != LAYER_CONSENSUS:
        writer.writerow(["Coders", csv_safe(", ".join(coder_scope_names(db, parsed_coder_ids)))])

    # #1534 D107 — the focal datasets no filter judges are named, never silently pooled.
    if filters and filter_scope["unfiltered_datasets"]:
        writer.writerow(["Not compared", csv_safe(not_compared_note(filter_scope["unfiltered_datasets"]))])

    # #1534 D106 — the bases each side's percentages are of (the screen says the
    # filtered one as "N texts from M records").
    writer.writerow(["Base", "Texts", "Records"])
    if filters:
        writer.writerow(["Filtered", filtered["text_count"], filtered["row_count"]])
        writer.writerow(["Overall", overall["text_count"], overall["row_count"]])
    else:
        writer.writerow(["All", freq["text_count"], freq["row_count"]])

    writer.writerow([])

    # Section 2: Frequency comparison
    writer.writerow(["Code Frequencies"])
    if filters:
        writer.writerow(["Code", "Filtered Count", "Filtered %", "Overall Count", "Overall %", "Difference (pp)"])
        overall_map = {f["code_id"]: f for f in overall["frequencies"]}
        for f in filtered["frequencies"]:
            o = overall_map.get(f["code_id"])
            diff = round(f["percentage"] - (o["percentage"] if o else 0), 1)
            writer.writerow([
                csv_safe(f["code_name"]), f["count"], f"{f['percentage']}%",
                o["count"] if o else 0, f"{o['percentage'] if o else 0}%",
                f"{'+' if diff > 0 else ''}{diff}pp",
            ])
    else:
        writer.writerow(["Code", "Count", "%"])
        for f in freq["frequencies"]:
            writer.writerow([csv_safe(f["code_name"]), f["count"], f"{f['percentage']}%"])

    writer.writerow([])

    # Section 3: Response length — every focal text, filtered or not: the panel's
    # Response Length never took the filters, and #1534 D108 has the file say so.
    writer.writerow([RESPONSE_LENGTH_UNFILTERED_HEADING if filters else "Response Length by Code"])
    writer.writerow(["Code", "Avg Words", "Text Count"])
    comment_values = get_non_empty_comment_values(
        db, col_id_list, treat_as_empty_for_project(db, project_id))
    value_ids = [v.id for v in comment_values]
    word_counts_map = {v.id: len(v.value_text.split()) if v.value_text else 0 for v in comment_values}
    if value_ids:
        code_apps_all_q = (
            db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
            .filter(in_id_set(CodeApplication.dataset_value_id, value_ids), layer_scope_filter(layer_scope))
        )
        if parsed_coder_ids and layer_scope != LAYER_CONSENSUS:
            code_apps_all_q = code_apps_all_q.filter(CodeApplication.user_id.in_(parsed_coder_ids))
        code_apps_all = code_apps_all_q.all()
    else:
        code_apps_all = []
    val_codes: dict[int, set[int]] = defaultdict(set)
    for ca in code_apps_all:
        val_codes[ca.dataset_value_id].add(ca.code_id)

    code_word_sum, code_text_count = _word_totals_by_code(value_ids, val_codes, word_counts_map)
    for code in codes:
        n = code_text_count.get(code.id, 0)
        avg_wc = round(code_word_sum[code.id] / n, 1) if n else 0.0
        writer.writerow([csv_safe(code.name), avg_wc, n])

    uncoded_vids = [vid for vid in value_ids if vid not in val_codes]
    uncoded_avg = round(sum(word_counts_map[vid] for vid in uncoded_vids) / len(uncoded_vids), 1) if uncoded_vids else 0.0
    writer.writerow(["(Uncoded)", uncoded_avg, len(uncoded_vids)])

    output.seek(0)
    col_names = sanitize_content_disposition("_".join(c.column_name or "col" for c in columns[:3]))
    filename = f"cross_analysis_{col_names}.csv"

    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
