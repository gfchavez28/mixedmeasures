"""Comment analysis frequency computation service.

Counts code applications on comment (open-ended) columns,
optionally filtered by row IDs.
"""

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from ..models.code_application import CodeApplication
from ..models.code import Code
from ..models.text_coding_config import TextCodingConfig, is_empty_text, parse_treat_as_empty
from ..routers.helpers import TEXT_TYPES
from .coding_layers import LAYER_CONSENSUS, layer_origin_filter


def _validate_text_columns(
    db: Session, project_id: int, column_ids: list[int],
) -> list[DatasetColumn]:
    """Validate column_ids belong to project and are comment types.

    Raises ValueError if any column is missing or not a comment type.
    """
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
        raise ValueError(
            f"Column IDs {missing} not found or not text columns in this project"
        )
    return columns


def treat_as_empty_for_project(db: Session, project_id: int) -> list[str]:
    """The project's treat-as-empty strings (defaults when no config row).

    Read-only on purpose: analysis GETs must not create a TextCodingConfig row
    (unlike the workbench's get-or-create `_get_config`).
    """
    raw = (
        db.query(TextCodingConfig.treat_as_empty)
        .filter(TextCodingConfig.project_id == project_id)
        .scalar()
    )
    return parse_treat_as_empty(raw)


def get_non_empty_comment_values(
    db: Session, column_ids: list[int], treat_as_empty: list[str],
    row_ids: list[int] | None = None,
) -> list[DatasetValue]:
    """Get substantive DatasetValues for text columns, optionally filtered by row IDs.

    `treat_as_empty` is required (#519): every text-analysis denominator must match
    the coding-progress gauge, which drops blank AND recognized non-substantive
    strings ("N/A", …) — a NULL/''-only filter over-counted by the N/A values.
    This is the single place the "which texts count" decision lives; new
    text-analysis surfaces must route through it, never hand-roll the filter.
    """
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
    return [v for v in q.all() if not is_empty_text(v.value_text, treat_as_empty)]


def compute_comment_frequencies(
    db: Session,
    project_id: int,
    column_ids: list[int],
    row_ids: list[int] | None = None,
    coder_ids: list[int] | None = None,
    layer_scope: str | None = None,
) -> dict:
    """Count code applications on comment columns, optionally filtered by row IDs.

    Loads active codes for the project internally. Inactive codes are excluded.

    `coder_ids` None/empty → all coders (Track J · J1). `layer_scope` selects the
    coder layer (Track J · J2 slab 3b): None/'human' (default) excludes the derived
    consensus layer; 'consensus' shows ONLY it (then `coder_ids` is moot — consensus
    is one synthetic coder). This is the single live frequency core: the
    `filtered-frequencies` endpoint + the CSV export both call it.

    Returns:
        {
            "row_count": int,
            "text_count": int,
            "frequencies": [
                {
                    "code_id": int,
                    "code_name": str,
                    "code_color": str,
                    "count": int,
                    "percentage": float,
                }
            ],
        }
    """
    _validate_text_columns(db, project_id, column_ids)

    # Load active codes for the project
    codes = (
        db.query(Code)
        .filter(Code.project_id == project_id, Code.is_active == True)  # noqa: E712
        .order_by(Code.is_universal.desc(), Code.numeric_id)
        .all()
    )

    treat_as_empty = treat_as_empty_for_project(db, project_id)
    comment_values = get_non_empty_comment_values(db, column_ids, treat_as_empty, row_ids)
    value_ids = [v.id for v in comment_values]

    if not value_ids:
        return {
            "row_count": 0,
            "text_count": 0,
            "frequencies": [
                {
                    "code_id": c.id, "code_name": c.name, "code_color": c.color,
                    "count": 0, "percentage": 0.0,
                }
                for c in codes
            ],
        }

    # Count coded comments per code. Track J · J2: distinct dataset values, not
    # raw rows — under per-coder layers two coders coding one value with one code
    # are two rows and would otherwise push the percentage past 100%.
    code_counts_q = (
        db.query(CodeApplication.code_id, func.count(func.distinct(CodeApplication.dataset_value_id)))
        .filter(CodeApplication.dataset_value_id.in_(value_ids), layer_origin_filter(layer_scope))
    )
    if coder_ids and layer_scope != LAYER_CONSENSUS:
        code_counts_q = code_counts_q.filter(CodeApplication.user_id.in_(coder_ids))
    count_map = dict(code_counts_q.group_by(CodeApplication.code_id).all())

    row_ids = {v.row_id for v in comment_values}
    comment_count = len(comment_values)

    freqs = []
    for c in codes:
        cnt = count_map.get(c.id, 0)
        pct = round(cnt / comment_count * 100, 1) if comment_count else 0.0
        freqs.append({
            "code_id": c.id,
            "code_name": c.name,
            "code_color": c.color,
            "count": cnt,
            "percentage": pct,
        })

    return {
        "row_count": len(row_ids),
        "text_count": comment_count,
        "frequencies": freqs,
    }
