"""Comment analysis frequency computation service.

Counts code applications on comment (open-ended) columns,
optionally filtered by row IDs.
"""

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models.dataset import Dataset, DatasetColumn, DatasetValue
from ..models.code_application import CodeApplication
from ..models.code import Code
from ..routers.helpers import TEXT_TYPES


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


def _get_non_empty_comment_values(
    db: Session, column_ids: list[int], row_ids: list[int] | None = None,
) -> list[DatasetValue]:
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


def compute_comment_frequencies(
    db: Session,
    project_id: int,
    column_ids: list[int],
    row_ids: list[int] | None = None,
) -> dict:
    """Count code applications on comment columns, optionally filtered by row IDs.

    Loads active codes for the project internally. Inactive codes are excluded.

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

    comment_values = _get_non_empty_comment_values(db, column_ids, row_ids)
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

    # Count code applications
    code_counts = (
        db.query(CodeApplication.code_id, func.count(CodeApplication.id))
        .filter(CodeApplication.dataset_value_id.in_(value_ids))
        .group_by(CodeApplication.code_id)
        .all()
    )
    count_map = dict(code_counts)

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
