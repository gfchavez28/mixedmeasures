"""Participant-to-dataset linking helpers."""

from sqlalchemy.orm import Session

from ..models.participant import Participant
from ..models.dataset import DatasetColumn, DatasetRow, DatasetValue, Dataset, ColumnType


def auto_fill_role_from_linked_row(
    db: Session,
    participant: Participant,
    dataset_row: DatasetRow,
) -> bool:
    """Auto-fill participant.role from a linked dataset row's role column.

    Only fills if participant.role is empty and the dataset has a
    demographic column with subtype='role'.
    Returns True if role was auto-filled.
    """
    if participant.role:
        return False

    role_col = (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.dataset_id == dataset_row.dataset_id,
            DatasetColumn.column_type == ColumnType.DEMOGRAPHIC,
            DatasetColumn.demographic_subtype == "role",
        )
        .first()
    )
    if not role_col:
        return False

    role_value = (
        db.query(DatasetValue)
        .filter(
            DatasetValue.row_id == dataset_row.id,
            DatasetValue.column_id == role_col.id,
        )
        .first()
    )
    if not role_value or not role_value.value_text:
        return False

    dataset = db.query(Dataset).filter(Dataset.id == dataset_row.dataset_id).first()
    dataset_name = dataset.name if dataset else "Unknown"

    participant.role = role_value.value_text
    participant.role_auto_filled_from = (
        f"{dataset_name} \u00b7 {dataset_row.row_identifier or 'Row'}"
    )
    return True
