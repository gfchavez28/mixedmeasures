"""Participant-to-dataset linking helpers."""

from sqlalchemy.orm import Session

from ..models.participant import Participant
from ..models.dataset import DatasetColumn, DatasetRow, DatasetValue, Dataset, ColumnType
from .dataset_import import _is_na


IDENTIFIER_MAX_LENGTH = 100  # Participant.identifier is String(100)
DUPLICATE_VALUES_REPORT_CAP = 10


def link_rows_by_identifier_column(
    db: Session,
    *,
    project_id: int,
    dataset_id: int,
    column_id: int,
    row_ids: list[int] | None = None,
) -> dict:
    """#414 (DEC-10) — link dataset rows to Participants by an identifier column.

    The ONE place the match/create/trim/N-A/duplicate/conflict rules live;
    dataset import, append, and the retro link-by-column endpoint all call it.
    Caller owns the transaction (this flushes, never commits).

    Semantics (scoping doc §3):
    - Match key = ``Participant.identifier`` (unique per project — the same
      field the conversation import writes speaker names into), after
      trimming whitespace; comparison stays case-sensitive (DEC-2).
    - No match → create ``Participant(identifier=value, display_name=None)``
      (a code is not a name; DEC-3). uuid stamps via the model default.
    - A value on >1 candidate row links NOTHING (DEC-4 — never pick an
      arbitrary row; the partial unique index allows one row per participant
      per dataset anyway).
    - Blank / recognized-N/A / absent / over-length values → ``skipped_missing``.
    - An existing participant already linked to another row in THIS dataset →
      ``skipped_conflict`` (pre-checked; never rely on catching IntegrityError
      mid-loop under autoflush=False).
    - Rows already linked are NEVER touched (``already_linked``) — a manual
      link is user intent.

    Args:
        row_ids: candidate scope — None means every row in the dataset
            (retro/import); append passes just the new rows.

    Returns a report dict: linked, created, matched, skipped_missing,
    skipped_duplicate, skipped_conflict, already_linked, duplicate_values.
    """
    column = (
        db.query(DatasetColumn)
        .filter(DatasetColumn.id == column_id, DatasetColumn.dataset_id == dataset_id)
        .first()
    )
    if column is None or column.column_type != ColumnType.IDENTIFIER:
        raise ValueError(
            "Participant linking requires an identifier-type column in this dataset"
        )

    rows_q = db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset_id)
    if row_ids is not None:
        rows_q = rows_q.filter(DatasetRow.id.in_(row_ids))
    rows = rows_q.all()

    already_linked = sum(1 for r in rows if r.participant_id is not None)
    candidates = [r for r in rows if r.participant_id is None]

    value_by_row_id: dict[int, str] = {
        v.row_id: v.value_text
        for v in db.query(DatasetValue).filter(
            DatasetValue.column_id == column_id,
            DatasetValue.row_id.in_([r.id for r in candidates]),
        )
        if v.value_text is not None
    } if candidates else {}

    skipped_missing = 0
    rows_by_value: dict[str, list[DatasetRow]] = {}
    for row in candidates:
        raw = value_by_row_id.get(row.id)
        value = raw.strip() if raw else ""
        if not value or _is_na(value) or len(value) > IDENTIFIER_MAX_LENGTH:
            skipped_missing += 1
            continue
        rows_by_value.setdefault(value, []).append(row)

    duplicate_values = sorted(v for v, rs in rows_by_value.items() if len(rs) > 1)
    skipped_duplicate = sum(
        len(rows_by_value[v]) for v in duplicate_values
    )
    linkable = {v: rs[0] for v, rs in rows_by_value.items() if len(rs) == 1}

    existing_by_identifier: dict[str, Participant] = {
        p.identifier: p
        for p in db.query(Participant).filter(
            Participant.project_id == project_id,
            Participant.identifier.in_(list(linkable.keys())),
        )
    } if linkable else {}

    # Participants already linked to ANY row of this dataset (dataset-wide,
    # not candidate-scoped — the partial unique index is per dataset).
    linked_participant_ids: set[int] = {
        pid
        for (pid,) in db.query(DatasetRow.participant_id).filter(
            DatasetRow.dataset_id == dataset_id,
            DatasetRow.participant_id.isnot(None),
        )
    }

    skipped_conflict = 0
    to_link: list[tuple[DatasetRow, Participant]] = []
    to_create: list[tuple[DatasetRow, Participant]] = []
    for value, row in linkable.items():
        existing = existing_by_identifier.get(value)
        if existing is not None:
            if existing.id in linked_participant_ids:
                skipped_conflict += 1
                continue
            to_link.append((row, existing))
        else:
            participant = Participant(
                project_id=project_id, identifier=value, display_name=None,
            )
            db.add(participant)
            to_create.append((row, participant))

    if to_create:
        db.flush()  # participants need ids before the FK assignment (autoflush=False)

    for row, participant in to_link + to_create:
        row.participant_id = participant.id
        auto_fill_role_from_linked_row(db, participant, row)
    db.flush()

    return {
        "linked": len(to_link) + len(to_create),
        "created": len(to_create),
        "matched": len(to_link),
        "skipped_missing": skipped_missing,
        "skipped_duplicate": skipped_duplicate,
        "skipped_conflict": skipped_conflict,
        "already_linked": already_linked,
        "duplicate_values": duplicate_values[:DUPLICATE_VALUES_REPORT_CAP],
    }


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
