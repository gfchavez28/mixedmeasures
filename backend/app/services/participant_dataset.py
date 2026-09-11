"""The tool-maintained participant dataset (row 45 (i) step 3).

One dataset per project whose ROWS ARE the project's participants, so a
per-person number — a rating score, a hand-entered case attribute — can be an
ordinary `DatasetColumn` and reach every consumer with no change to any of them.

🔴 **"LOCKED SPINE, OPEN COLUMNS" (developer, 2026-09-08).** The rows are the
tool's; the columns are the researcher's.

  REFUSED — delete a record · append a file · re-link a row to a participant ·
  delete the dataset. All four touch the row set, which is DERIVED from
  `Participant`, so allowing them would let the table disagree with the thing it
  is a projection of.

  ALLOWED — rename / describe / recolour · add a variable · edit a cell in a
  column the researcher made · export.

**The refusal set follows from ONE PROPERTY rather than a list**, which is what
stops the next affordance needing a new decision: *does this change the row set?*
`managed_dataset_refusal` is the only place that question is answered, and
`tests/test_participant_dataset.py` fails the suite for a row-set endpoint that
does not ask it — because a machine-made dataset RENDERS like a hand-made one
and inherits every affordance it has.

🔴 **THE TOOL'S OWN COLUMNS NEEDED A GUARD AFTER ALL — #926, 2026-09-10, and
this paragraph used to say the opposite.** What it said was true and was not the
whole population: `update_manual_column`, `delete_manual_column` and
`update_value` (the cell edit) do refuse anything whose `source != "manual"`, so
renaming through the manual PATCH, deleting, and typing into a cell were all
covered. **The four doors in `routers/recode.py` ask a different question — they
refuse `source == "computed"` — and `managed` is not `computed`.** So the type,
the value-label dictionary, the missing declaration and a recode rule were all
writable on a participant score column. MEASURED live: a score column retyped
`numeric` → `open_text` from the Data view persisted, SURVIVED a refresh, and
turned the toolbar's *Code Text* button on.

`managed_column_refusal` below is the predicate; `routers/recode.py` calls it at
five doors (the fifth is `copy_to`, which reaches a target column's cells without
`create_definition`). ⚠️ **The rule is `source == "managed"`, never
`!= "manual"`** — retyping an IMPORTED column is a shipped feature.

`"managed"` is still deliberately not `"computed"`: that value carries the #806
refusals AND a recompute path this column does not have, and a score column must
stay an ordinary numeric variable to every reader.

⚠️ **`Participant.role` is NOT mirrored into a column, deliberately.**
`code_analysis._build_participant_group_map` reads it directly for
`subtype == "role"` and needs no dataset at all, so a column would be a second
source for one fact — free to disagree with the first.

## The sync reconciles; it does not listen

Six sites create or delete a `Participant` (three routers, the linking service,
and `project_portability` — which builds them by REFLECTION and so is invisible
to a `Participant(` grep), and a seventh could appear tomorrow. Hooking all of
them is the enumeration debt this codebase keeps paying down, so `sync_rows`
compares the two SETS instead: every participant gets a row, every row without a
live participant goes. Idempotent, bounded by participant count, and immune to a
new participant-creating path.

⚠️ **Reaping is not optional.** `DatasetRow.participant_id` is `SET NULL`, and
`withdrawal_redaction.py:299` deletes the participant outright — so without the
reap a withdrawal leaves an orphan row that the refusals above make undeletable.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from ..models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from ..models.participant import Participant
from .dataset_rows import materialise_manual_cells

#: The only managed kind today. A second would be a new value here plus its own
#: builder — never a boolean, which could not tell two spines apart.
MANAGED_KIND_PARTICIPANTS = "participants"

MANAGED_KINDS = frozenset({MANAGED_KIND_PARTICIPANTS})

#: `DatasetColumn.source` for a column the TOOL maintains. Not an enum anywhere —
#: `source` is a plain `String(20)` — and this value is read-only for free
#: through the three `source != "manual"` gates (see the module docstring).
MANAGED_COLUMN_SOURCE = "managed"

#: The default name. The researcher may rename it — renaming does not touch the
#: row set, so it is on the allowed side of the line.
DEFAULT_PARTICIPANT_DATASET_NAME = "Participants"

#: The identifier column's heading. `ColumnType.IDENTIFIER` is a member of NO
#: eligibility frozenset (#414), so this column can never pollute an analysis,
#: and it makes the table self-describing in the grid and in every export.
#:
#: 🔴 **"Participant ID", not "Participant" (#928, 2026-09-11).** The grid also
#: renders its own built-in participant-link column, headed *Participant*, so the
#: table showed two adjacent columns with ONE string on the surface a researcher
#: reads to check who is in the study. The two say different things — the link
#: column shows the person's NAME, this one shows the identifier they are matched
#: by — so the fix is for each heading to say which.
#:
#: ⚠️ **Nothing MATCHES on this string**, checked before changing it:
#: `_identifier_column` finds the column by `source` + `column_type`, and
#: `participant_linking.link_rows_by_identifier_column` takes a column id. The
#: entry's own warning ("the heading is no longer the constant the linking code
#: matches on") describes a coupling that does not exist.
PARTICIPANT_IDENTIFIER_COLUMN = "Participant ID"

#: Headings this module has written itself in the past, and may therefore
#: correct in place. **Membership is a claim that WE wrote it**, which is what
#: makes the repair safe: a researcher's own rename never appears here, so it is
#: never clobbered (#924's rule, reached from the other side — the tool may
#: re-derive a heading only while the heading is still the one it last wrote).
_LEGACY_IDENTIFIER_HEADINGS = frozenset({"Participant"})

# ── The refusal vocabulary ───────────────────────────────────────────────────
#
# One action per QUESTION, not per endpoint: `append` covers two endpoints and
# `link_participants` three, because a refusal is about what the caller is trying
# to do to the row set, not about which door they came through.

ACTION_DELETE_DATASET = "delete_dataset"
ACTION_DELETE_ROW = "delete_row"
ACTION_ADD_ROW = "add_row"
ACTION_APPEND = "append"
ACTION_LINK_PARTICIPANTS = "link_participants"

MANAGED_ACTIONS = (
    ACTION_DELETE_DATASET,
    ACTION_DELETE_ROW,
    ACTION_ADD_ROW,
    ACTION_APPEND,
    ACTION_LINK_PARTICIPANTS,
)

#: Written to be shown verbatim. Each says what the tool maintains and what the
#: researcher can do instead — a refusal that only forbids teaches nothing.
_REFUSALS: dict[str, str] = {
    ACTION_DELETE_DATASET: (
        "This table's records are your project's participants, so it is kept in "
        "step with them rather than deleted here. Remove a participant on the "
        "Participants page and their record goes with them."
    ),
    ACTION_DELETE_ROW: (
        "This record is a participant, so it is removed by deleting that "
        "participant on the Participants page — not from this table. You can "
        "still delete a variable you added here."
    ),
    # Row 47 — the fifth action, and it arrived exactly as the design predicted
    # a new affordance would: the fail-closed route scan matched `POST
    # …/{id}/rows` on its PATH and required an answer here, rather than anyone
    # remembering that a new record-creating door existed.
    ACTION_ADD_ROW: (
        "Records here are your project's participants, so a record is added by "
        "adding a participant on the Participants page. You can add a variable "
        "to this table and fill it in for everyone."
    ),
    ACTION_APPEND: (
        "Records here come from your project's participants, so a file cannot "
        "add to them. Import the file as its own dataset, or add a variable to "
        "this one and fill it in."
    ),
    ACTION_LINK_PARTICIPANTS: (
        "Every record here is already one participant, so links are maintained "
        "for you and cannot be changed by hand."
    ),
}


def managed_dataset_refusal(dataset: Dataset | None, action: str) -> str | None:
    """The sentence refusing ``action`` on ``dataset``, or None to allow it.

    THE predicate. An ordinary dataset (``managed_kind`` is None) allows
    everything, so a call site can ask unconditionally and needs no branch of
    its own. Fails closed on an unknown action, because that is a wiring bug
    rather than user input.
    """
    if action not in _REFUSALS:
        raise ValueError(
            f"unknown managed-dataset action {action!r}; expected one of "
            f"{sorted(_REFUSALS)}"
        )
    if dataset is None or dataset.managed_kind is None:
        return None
    return _REFUSALS[action]


# ── The tool's own COLUMNS (#926) ────────────────────────────────────────────
#
# 🔴 The sibling of the row-set vocabulary above, and it exists because this
# module's own docstring was WRONG. It said a managed column "is read-only
# through gates that already exist", naming `update_manual_column`,
# `delete_manual_column` and `update_value` — all three of which do refuse
# anything whose `source != "manual"`. What nobody checked is that the FOUR
# doors in `routers/recode.py` ask a different question: they refuse
# `source == "computed"`, and `managed` is not `computed`.
#
# MEASURED live on the pd_audit corpus (2026-09-10 ux-audit): a score column
# was retyped `numeric` → `open_text` from the Data view's header popover. It
# persisted, SURVIVED a refresh, and turned the toolbar's *Code Text* button on
# — the tool's own participant scores offered to Text Coding as codeable text,
# and gone from every numeric consumer (`VALUE_NUMERIC_TYPES`), i.e. from the
# pickers, comparisons, charts and the R export. A `missing_values` declaration
# was written to the same column through the Variables view.
#
# 🔴 THE PREDICATE IS `source == "managed"` AND NOTHING WIDER. The obvious
# `!= "manual"` would also refuse `imported`, and retyping an imported column is
# a shipped feature (the import wizard's per-column override and the Variables
# view's type control both depend on it). `test_managed_columns.py` pins that
# an imported column can still be retyped, so the wider predicate fails loudly.

ACTION_CHANGE_TYPE = "change_type"
ACTION_VALUE_LABELS = "value_labels"
ACTION_MISSING_VALUES = "missing_values"
ACTION_RECODE = "recode"

MANAGED_COLUMN_ACTIONS = (
    ACTION_CHANGE_TYPE,
    ACTION_VALUE_LABELS,
    ACTION_MISSING_VALUES,
    ACTION_RECODE,
)

#: Shown verbatim, and each names what the researcher CAN do instead — the same
#: standard the row-set refusals are held to. All four say *this column is
#: derived*, because that is the one fact that makes the refusal make sense.
_COLUMN_REFUSALS: dict[str, str] = {
    ACTION_CHANGE_TYPE: (
        "This variable is maintained by the tool — its values are recomputed "
        "from your coding — so its type is part of what it is. Add a variable "
        "of your own if you need one of a different type."
    ),
    ACTION_VALUE_LABELS: (
        "This variable is maintained by the tool, and its values are computed "
        "scores rather than codes, so there is nothing to label. Refresh the "
        "table to bring the scores up to date."
    ),
    ACTION_MISSING_VALUES: (
        "This variable is maintained by the tool. An empty cell already means "
        "“no usable rating”, and the next refresh would overwrite "
        "anything declared here."
    ),
    ACTION_RECODE: (
        "This variable is maintained by the tool, so a rule applied to it "
        "would be overwritten by the next refresh. Derive a new variable from "
        "it instead — the derived one is yours to recode."
    ),
}


def managed_column_refusal(column: DatasetColumn | None, action: str) -> str | None:
    """The sentence refusing ``action`` on ``column``, or None to allow it.

    THE predicate for the tool's own columns, mirroring
    :func:`managed_dataset_refusal` for the tool's own rows. An ordinary column
    allows everything, so a call site asks unconditionally.

    ⚠️ **RENAMING IS DELIBERATELY NOT HERE.** "Locked spine, open columns" puts
    rename/describe/recolour on the allowed side, and `managed_spec` exists so
    that a rename cannot orphan the cells a refresh rewrites — the column is
    found by its spec, never by its name. `update_column_header` is therefore
    correctly ungated, which is also what lets a researcher correct a heading
    left stale by a code rename (#924's entry says they cannot; measured
    2026-09-10, they can).
    """
    if action not in _COLUMN_REFUSALS:
        raise ValueError(
            f"unknown managed-column action {action!r}; expected one of "
            f"{sorted(_COLUMN_REFUSALS)}"
        )
    if column is None or column.source != MANAGED_COLUMN_SOURCE:
        return None
    return _COLUMN_REFUSALS[action]


@dataclass(frozen=True)
class SyncReport:
    """What one reconcile actually changed."""

    added: int = 0
    removed: int = 0
    relabelled: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.added or self.removed or self.relabelled)


def get_participant_dataset(db: Session, project_id: int) -> Dataset | None:
    """The project's participant dataset, or None. At most one can exist —
    `uq_datasets_project_managed_kind` makes that structural."""
    return (
        db.query(Dataset)
        .filter(
            Dataset.project_id == project_id,
            Dataset.managed_kind == MANAGED_KIND_PARTICIPANTS,
        )
        .first()
    )


def _identifier_column(db: Session, dataset: Dataset) -> DatasetColumn | None:
    return (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.dataset_id == dataset.id,
            DatasetColumn.source == MANAGED_COLUMN_SOURCE,
            DatasetColumn.column_type == ColumnType.IDENTIFIER,
        )
        .first()
    )


def create_participant_dataset(
    db: Session,
    project_id: int,
    *,
    name: str = DEFAULT_PARTICIPANT_DATASET_NAME,
) -> Dataset:
    """Build the participant dataset and fill it. Idempotent by the index.

    🔴 **The first `Dataset` in this codebase constructed without a FILE.**
    `services/dataset_import.py` was the only constructor, which is why queue
    row 47 ("author a dataset by hand") wants this path too — a researcher
    creating an empty table needs exactly this minus the participant spine.

    Flushes; the caller owns the transaction.
    """
    existing = get_participant_dataset(db, project_id)
    if existing is not None:
        return existing

    dataset = Dataset(
        project_id=project_id,
        name=name,
        description=(
            "One record per participant, kept in step with your project's "
            "participants. Add variables here to hold what you know about each "
            "person."
        ),
        managed_kind=MANAGED_KIND_PARTICIPANTS,
        # `source` here is IMPORT PROVENANCE ("LimeSurvey", "Qualtrics") and is a
        # different column from `DatasetColumn.source`. Nothing was imported.
        source=None,
    )
    db.add(dataset)
    db.flush()

    db.add(DatasetColumn(
        dataset_id=dataset.id,
        column_text=PARTICIPANT_IDENTIFIER_COLUMN,
        column_type=ColumnType.IDENTIFIER,
        sequence_order=0,
        display_order=0,
        source=MANAGED_COLUMN_SOURCE,
    ))
    db.flush()

    sync_rows(db, dataset)
    return dataset


def sync_rows(db: Session, dataset: Dataset) -> SyncReport:
    """Reconcile the row set against `Participant`. Idempotent.

    Three things happen, and the second is the one that is easy to forget:

      1. every participant with no row gets one;
      2. every row whose participant is GONE is deleted — `participant_id` is
         `SET NULL`, so a deleted or withdrawn participant leaves an orphan that
         the refusals would otherwise make permanent;
      3. the identifier cell follows `Participant.identifier` when it is edited.

    ⚠️ Deliberately NOT called from a GET. A recompute on read risks the SQLite
    lock races DEC-C refused for consensus, and `GET …/data` is the endpoint that
    was paginated for scale (#800). The row set is a snapshot refreshed
    deliberately, exactly as the scores are.
    """
    if dataset.managed_kind != MANAGED_KIND_PARTICIPANTS:
        raise ValueError(
            f"sync_rows expects the participants dataset, got "
            f"managed_kind={dataset.managed_kind!r}"
        )

    participants = {
        p.id: p
        for p in db.query(Participant).filter(
            Participant.project_id == dataset.project_id
        )
    }
    rows = db.query(DatasetRow).filter(DatasetRow.dataset_id == dataset.id).all()

    # (2) reap first: a row whose participant is gone, and any row the FK's
    # SET NULL has already orphaned. Done BEFORE inserting so a participant that
    # somehow held two rows cannot collide on the unique index.
    removed = 0
    for row in rows:
        if row.participant_id is None or row.participant_id not in participants:
            db.delete(row)
            removed += 1
    if removed:
        db.flush()

    live = {r.participant_id: r for r in rows if r.participant_id in participants}
    column = _identifier_column(db, dataset)

    # #928 — repair a table built before the heading was disambiguated. Scoped to
    # headings THIS module wrote, so a researcher who renamed the column keeps
    # their name; a fix that only changed the constant would leave every existing
    # table showing the duplicate it was filed for.
    if column is not None and column.column_text in _LEGACY_IDENTIFIER_HEADINGS:
        column.column_text = PARTICIPANT_IDENTIFIER_COLUMN

    # (1) insert the missing, in a stable order so record identifiers are
    # deterministic across a rebuild.
    added = 0
    for participant_id in sorted(set(participants) - set(live)):
        row = DatasetRow(
            dataset_id=dataset.id,
            participant_id=participant_id,
            row_identifier=participants[participant_id].identifier,
        )
        db.add(row)
        db.flush()
        live[participant_id] = row
        added += 1
        if column is not None:
            db.add(DatasetValue(
                row_id=row.id,
                column_id=column.id,
                value_text=participants[participant_id].identifier,
            ))
    # ⚠️ LOAD-BEARING. Production and tests both run `autoflush=False`, so the
    # cells added above are INVISIBLE to the query in (3) until they are
    # flushed — and (3) would then add a SECOND cell for the same
    # `(row_id, column_id)`, which the unique index rejects at commit time with
    # an IntegrityError far from its cause. Found by the tests below, not by
    # reading; it is the #439/#440 family reached from the insert side.
    if added:
        db.flush()

    # (3) an identifier can be edited on the Participants page; the row label and
    # the cell both follow it, or the table names people by a stale code.
    relabelled = 0
    if live:
        cells = {}
        if column is not None:
            cells = {
                v.row_id: v
                for v in db.query(DatasetValue).filter(
                    DatasetValue.column_id == column.id,
                    DatasetValue.row_id.in_([r.id for r in live.values()]),
                )
            }
        for participant_id, row in live.items():
            identifier = participants[participant_id].identifier
            touched = False
            if row.row_identifier != identifier:
                row.row_identifier = identifier
                touched = True
            if column is not None:
                cell = cells.get(row.id)
                if cell is None:
                    db.add(DatasetValue(
                        row_id=row.id, column_id=column.id, value_text=identifier,
                    ))
                    touched = True
                elif cell.value_text != identifier:
                    cell.value_text = identifier
                    touched = True
            if touched:
                relabelled += 1

    db.flush()

    # (4) #897 — a row the researcher can type into. A variable they added here
    # is `source="manual"`, and `create_manual_column` only ever gives a cell to
    # the rows that existed AT THAT MOMENT — so before this, a participant who
    # joined afterwards had no cell for it and the grid discarded every edit
    # silently (`update_value` is addressed by an existing `DatasetValue.id`).
    #
    # ⚠️ Deliberately scoped to EVERY row, not the ones just added: this is a
    # RECONCILE like the three steps above it, so it also repairs a table that
    # already carries the gap. Bounded by the participant count.
    materialise_manual_cells(db, dataset.id)

    return SyncReport(added=added, removed=removed, relabelled=relabelled)
