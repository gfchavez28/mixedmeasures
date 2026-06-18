"""Router for text cross-analysis — subgroup filtering, cross-tabulation,
code density, and response length analysis for coded open-ended text responses."""

import io
import csv
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import get_db
from ..models.user import User
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.code_application import CodeApplication
from ..models.code import Code
from ..models.recode import RecodeDefinition
from ..services.grouping import order_value_labels, value_label_sort_key
from ..services.recode import _parse_mapping
from ..auth import get_current_user
from .helpers import _get_project_or_404, parse_int_list, sanitize_content_disposition, TEXT_TYPES
from .export_helpers import csv_safe
from ..schemas.text_analysis import (
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


def _get_non_empty_comment_values(db: Session, column_ids: list[int], row_ids: list[int] | None = None):
    """Get DatasetValues for comment columns, optionally filtered by row IDs."""
    q = (
        db.query(DatasetValue)
        .filter(
            DatasetValue.column_id.in_(column_ids),
            DatasetValue.value_text.isnot(None),
            DatasetValue.value_text != "",
        )
    )
    if row_ids is not None:
        q = q.filter(DatasetValue.row_id.in_(row_ids))
    return q.all()


def _apply_filters(db: Session, project_id: int, filters, focal_column_ids: list[int]):
    """Apply subgroup filters and return matching DatasetRow IDs per dataset.

    Returns:
        tuple: (filtered_row_ids: set[int], filter_description: str,
                filter_scope: dict with filtered_datasets and unfiltered_datasets)
    """
    if not filters:
        return None, "No filters applied", {"filtered_datasets": [], "unfiltered_datasets": []}

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
            matching_rows = _resolve_filter_rows(db, filt, col)
            row_sets.append(matching_rows)
            filter_parts.append(f"{col.column_name or col.column_text}: {filt.operator}")

        # Intersect all filter results within this dataset
        if row_sets:
            combined = row_sets[0]
            for rs in row_sets[1:]:
                combined = combined & rs
            per_dataset_rows[ds_id] = combined

    # For datasets that contain focal columns but have no filters, include ALL their rows
    for ds_id in focal_dataset_ids:
        if ds_id not in per_dataset_rows:
            if ds_id in ds_name_map:
                unfiltered_dataset_names.append(ds_name_map[ds_id])
            all_rows = db.query(DatasetRow.id).filter(DatasetRow.dataset_id == ds_id).all()
            per_dataset_rows[ds_id] = {r.id for r in all_rows}

    # Combine all row IDs
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
    )


def _resolve_filter_rows(db: Session, filt, col: DatasetColumn) -> set[int]:
    """Resolve a single filter to a set of DatasetRow IDs."""
    base_q = (
        db.query(DatasetValue.row_id)
        .filter(DatasetValue.column_id == col.id)
    )

    if filt.operator in ("equals", "in"):
        if not filt.values:
            return set()
        rows = base_q.filter(DatasetValue.value_text.in_(filt.values)).all()
        return {r.row_id for r in rows}

    elif filt.operator == "gte":
        if filt.value is None:
            return set()
        rows = base_q.filter(DatasetValue.value_numeric >= filt.value).all()
        return {r.row_id for r in rows}

    elif filt.operator == "lte":
        if filt.value is None:
            return set()
        rows = base_q.filter(DatasetValue.value_numeric <= filt.value).all()
        return {r.row_id for r in rows}

    elif filt.operator == "above_mean":
        mean_result = (
            db.query(func.avg(DatasetValue.value_numeric))
            .filter(
                DatasetValue.column_id == col.id,
                DatasetValue.value_numeric.isnot(None),
            )
            .scalar()
        )
        if mean_result is None:
            return set()
        rows = base_q.filter(DatasetValue.value_numeric > mean_result).all()
        return {r.row_id for r in rows}

    elif filt.operator == "below_mean":
        mean_result = (
            db.query(func.avg(DatasetValue.value_numeric))
            .filter(
                DatasetValue.column_id == col.id,
                DatasetValue.value_numeric.isnot(None),
            )
            .scalar()
        )
        if mean_result is None:
            return set()
        rows = base_q.filter(DatasetValue.value_numeric < mean_result).all()
        return {r.row_id for r in rows}

    else:
        raise HTTPException(status_code=400, detail=f"Unknown operator: {filt.operator}")


def _build_frequency_set(
    db: Session, comment_values: list[DatasetValue], codes: list[Code],
) -> FrequencySet:
    """Build a FrequencySet from a list of DatasetValues."""
    value_ids = [v.id for v in comment_values]
    if not value_ids:
        return FrequencySet(
            row_count=0,
            text_count=0,
            frequencies=[CodeFrequencyBrief(
                code_id=c.id, code_name=c.name, code_color=c.color,
                count=0, percentage=0.0,
            ) for c in codes],
        )

    # Count code applications
    code_counts = (
        db.query(CodeApplication.code_id, func.count(CodeApplication.id))
        .filter(CodeApplication.dataset_value_id.in_(value_ids))
        .group_by(CodeApplication.code_id)
        .all()
    )
    count_map = dict(code_counts)

    # Count unique rows
    row_ids = {v.row_id for v in comment_values}
    comment_count = len(comment_values)

    freqs = []
    for c in codes:
        cnt = count_map.get(c.id, 0)
        pct = round(cnt / comment_count * 100, 1) if comment_count else 0.0
        freqs.append(CodeFrequencyBrief(
            code_id=c.id, code_name=c.name, code_color=c.color,
            count=cnt, percentage=pct,
        ))

    return FrequencySet(
        row_count=len(row_ids),
        text_count=comment_count,
        frequencies=freqs,
    )


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/filtered-frequencies", response_model=FilteredFrequenciesResponse)
async def filtered_frequencies(
    project_id: int,
    body: FilteredFrequenciesRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get code frequencies for comment columns, optionally filtered by subgroup."""
    _get_project_or_404(db, project_id, user.id)
    columns = _validate_text_columns(db, project_id, body.column_ids)
    column_ids = [c.id for c in columns]

    # Load active codes
    codes = (
        db.query(Code)
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
        .all()
    )

    # Apply filters
    filtered_row_ids, filter_desc, filter_scope = _apply_filters(
        db, project_id, body.filters, column_ids,
    )

    # Get filtered comment values
    filtered_values = _get_non_empty_comment_values(
        db, column_ids,
        list(filtered_row_ids) if filtered_row_ids is not None else None,
    )

    filtered_set = _build_frequency_set(db, filtered_values, codes)

    # Overall (unfiltered)
    overall_set = None
    if body.include_overall and body.filters:
        all_values = _get_non_empty_comment_values(db, column_ids)
        overall_set = _build_frequency_set(db, all_values, codes)

    return FilteredFrequenciesResponse(
        filtered=filtered_set,
        overall=overall_set,
        filter_description=filter_desc,
        filter_scope=filter_scope,
    )


@router.post("/cross-tabulation", response_model=CrossTabulationResponse)
async def cross_tabulation(
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

    # Build the ordered list of cross-column values (these become the cross-tab
    # columns). They are the original text labels stored in value_text — both the
    # recode `mapping` (keyed on labels) and row_to_cross_value below key on
    # value_text, so the order set must be labels, not recode targets.
    #
    # Always derive the candidate set from values actually present in the data,
    # so we never render an empty column for a mapped-but-absent label nor drop a
    # present-but-unmapped value (e.g. a typo). When the cross column has a
    # primary recode, order the labels by the recode's numeric mapping so columns
    # read low→high (e.g. Standard → Premium); unmapped/non-numeric values sort
    # alphabetically after the mapped ones. Without a recode, order is alphabetical.
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

    raw_values = [
        v.value_text for v in (
            db.query(DatasetValue.value_text)
            .filter(
                DatasetValue.column_id == cross_col.id,
                DatasetValue.value_text.isnot(None),
                DatasetValue.value_text != "",
            )
            .distinct()
            .order_by(DatasetValue.value_text)
            .all()
        )
    ]

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

    # Build row_id -> cross_value mapping (same dataset as cross column)
    cross_dataset_id = cross_col.dataset_id
    cross_values_q = (
        db.query(DatasetValue.row_id, DatasetValue.value_text)
        .filter(
            DatasetValue.column_id == cross_col.id,
            DatasetValue.value_text.isnot(None),
            DatasetValue.value_text != "",
        )
        .all()
    )
    row_to_cross_value: dict[int, str] = {r.row_id: r.value_text for r in cross_values_q}

    # Get all rows in the cross column's dataset
    cross_dataset_row_ids = set(row_to_cross_value.keys())

    # Get comment values from the same dataset (or linked via participant)
    comment_values = _get_non_empty_comment_values(db, comment_col_ids)

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

    code_apps = (
        db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
        .filter(CodeApplication.dataset_value_id.in_(value_ids))
        .all()
    )
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
            .filter(DatasetRow.id.in_(cross_dataset_row_ids))
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
                DatasetRow.participant_id.in_(linked_participant_ids),
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
async def code_density(
    project_id: int,
    column_ids: str = Query(..., description="Comma-separated focal column IDs"),
    group_by_column_id: int | None = Query(None, description="Column to group by"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Average number of codes applied per comment, optionally grouped."""
    _get_project_or_404(db, project_id, user.id)
    col_id_list = parse_int_list(column_ids) or []
    if not col_id_list:
        raise HTTPException(status_code=400, detail="column_ids required")

    _validate_text_columns(db, project_id, col_id_list)

    # Get non-empty comment values
    comment_values = _get_non_empty_comment_values(db, col_id_list)
    value_ids = [v.id for v in comment_values]

    # Count codes per value
    code_counts_q = (
        db.query(CodeApplication.dataset_value_id, func.count(CodeApplication.id))
        .filter(CodeApplication.dataset_value_id.in_(value_ids))
        .group_by(CodeApplication.dataset_value_id)
        .all()
    ) if value_ids else []
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

        # Build row_id -> group_value
        group_values_q = (
            db.query(DatasetValue.row_id, DatasetValue.value_text)
            .filter(
                DatasetValue.column_id == group_by_column_id,
                DatasetValue.value_text.isnot(None),
                DatasetValue.value_text != "",
            )
            .all()
        )
        row_to_group: dict[int, str] = {r.row_id: r.value_text for r in group_values_q}

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
async def response_length_by_code(
    project_id: int,
    column_ids: str = Query(..., description="Comma-separated focal column IDs"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Average word count of comments by code applied."""
    _get_project_or_404(db, project_id, user.id)
    col_id_list = parse_int_list(column_ids) or []
    if not col_id_list:
        raise HTTPException(status_code=400, detail="column_ids required")

    _validate_text_columns(db, project_id, col_id_list)

    # Get non-empty comment values
    comment_values = _get_non_empty_comment_values(db, col_id_list)
    value_ids = [v.id for v in comment_values]

    # Compute word counts
    word_counts: dict[int, int] = {}  # value_id -> word_count
    for dv in comment_values:
        word_counts[dv.id] = len(dv.value_text.split()) if dv.value_text else 0

    # Load code applications
    code_apps = (
        db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
        .filter(CodeApplication.dataset_value_id.in_(value_ids))
        .all()
    ) if value_ids else []

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

    # Per-code: avg word count of values with that code
    code_results = []
    for code in codes:
        coded_value_ids = [vid for vid in value_ids if code.id in value_codes.get(vid, set())]
        if coded_value_ids:
            wc_sum = sum(word_counts[vid] for vid in coded_value_ids)
            avg = round(wc_sum / len(coded_value_ids), 1)
        else:
            avg = 0.0
        code_results.append(ResponseLengthCode(
            code_id=code.id,
            code_name=code.name,
            code_color=code.color,
            avg_words=avg,
            text_count=len(coded_value_ids),
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
async def export_cross_analysis(
    project_id: int,
    column_ids: str = Query(..., description="Comma-separated focal column IDs"),
    filters_json: str = Query("[]", description="JSON-encoded filters"),
    cross_column_id: int | None = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Export cross-analysis as CSV."""
    import json as json_mod

    _get_project_or_404(db, project_id, user.id)
    col_id_list = parse_int_list(column_ids) or []
    if not col_id_list:
        raise HTTPException(status_code=400, detail="column_ids required")

    columns = _validate_text_columns(db, project_id, col_id_list)

    # Parse filters
    try:
        filters_raw = json_mod.loads(filters_json)
        from ..schemas.text_analysis import SubgroupFilter
        filters = [SubgroupFilter(**f) for f in filters_raw] if filters_raw else []
    except (json_mod.JSONDecodeError, ValueError, TypeError):
        filters = []

    # Load codes
    codes = (
        db.query(Code)
        .filter(Code.project_id == project_id, Code.is_active == True)
        .order_by(Code.is_universal.desc(), Code.numeric_id)
        .all()
    )

    output = io.StringIO()
    writer = csv.writer(output)

    # Section 1: Filter description
    writer.writerow(["Cross-Analysis Export"])
    writer.writerow(["Columns", csv_safe(", ".join(c.column_name or c.column_text for c in columns))])

    if filters:
        filtered_row_ids, filter_desc, filter_scope = _apply_filters(
            db, project_id, filters, col_id_list,
        )
        writer.writerow(["Filters", csv_safe(filter_desc)])
    else:
        filtered_row_ids = None
        writer.writerow(["Filters", "None"])

    writer.writerow([])

    # Section 2: Frequency comparison
    writer.writerow(["Code Frequencies"])
    if filters:
        writer.writerow(["Code", "Filtered Count", "Filtered %", "Overall Count", "Overall %", "Difference (pp)"])
        all_values = _get_non_empty_comment_values(db, col_id_list)
        overall_set = _build_frequency_set(db, all_values, codes)
        filtered_values = _get_non_empty_comment_values(
            db, col_id_list,
            list(filtered_row_ids) if filtered_row_ids is not None else None,
        )
        filtered_set = _build_frequency_set(db, filtered_values, codes)
        overall_map = {f.code_id: f for f in overall_set.frequencies}
        for f in filtered_set.frequencies:
            o = overall_map.get(f.code_id)
            diff = round(f.percentage - (o.percentage if o else 0), 1)
            writer.writerow([
                csv_safe(f.code_name), f.count, f"{f.percentage}%",
                o.count if o else 0, f"{o.percentage if o else 0}%",
                f"{'+' if diff > 0 else ''}{diff}pp",
            ])
    else:
        writer.writerow(["Code", "Count", "%"])
        all_values = _get_non_empty_comment_values(db, col_id_list)
        freq_set = _build_frequency_set(db, all_values, codes)
        for f in freq_set.frequencies:
            writer.writerow([csv_safe(f.code_name), f.count, f"{f.percentage}%"])

    writer.writerow([])

    # Section 3: Response length
    writer.writerow(["Response Length by Code"])
    writer.writerow(["Code", "Avg Words", "Comment Count"])
    comment_values = _get_non_empty_comment_values(db, col_id_list)
    value_ids = [v.id for v in comment_values]
    word_counts_map = {v.id: len(v.value_text.split()) if v.value_text else 0 for v in comment_values}
    code_apps_all = (
        db.query(CodeApplication.dataset_value_id, CodeApplication.code_id)
        .filter(CodeApplication.dataset_value_id.in_(value_ids))
        .all()
    ) if value_ids else []
    val_codes: dict[int, set[int]] = defaultdict(set)
    for ca in code_apps_all:
        val_codes[ca.dataset_value_id].add(ca.code_id)

    for code in codes:
        coded_vids = [vid for vid in value_ids if code.id in val_codes.get(vid, set())]
        if coded_vids:
            avg_wc = round(sum(word_counts_map[vid] for vid in coded_vids) / len(coded_vids), 1)
        else:
            avg_wc = 0.0
        writer.writerow([csv_safe(code.name), avg_wc, len(coded_vids)])

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
