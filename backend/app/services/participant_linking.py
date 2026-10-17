"""Participant-to-dataset linking helpers.

## #1054 — PLAN, then APPLY

`link_rows_by_identifier_column` used to load every row as an ORM object, create
participants one flush at a time, and look the dataset's role column up again FOR
EVERY ROW (`auto_fill_role_from_linked_row`) — 76 s on BES with the event loop
held the whole time, ~65% of it that one repeated lookup (cProfile). Now:

- **`plan_identifier_links` READS ONLY** — tuples through `db.connection()`, the
  role column once, one candidate read ordered by row id (HEAD's order, so the
  duplicate examples and the per-value decisions are unchanged), participants via
  `json_each`. No row-id list is bound, so no #960 ceiling (HEAD's three `.in_()`
  lists failed at 250,000 rows).
- **`apply_identifier_links` WRITES what the plan decided**, re-checking each
  decision in the statement's own WHERE clause; when the database no longer
  matches it raises `LinkPlanChanged` and the caller rolls the batch back.
- **The standalone endpoint commits every `LINK_WRITE_BATCH` rows** and re-plans
  at most `MAX_REPLANS` times. Import and append keep ONE apply inside their own
  transaction (`commit_every=None`) — nothing can change under a transaction that
  already holds the write lock.
- 🔴 **A batched link that stops AFTER a commit raises `LinkStopped` (#1231)**,
  whatever stopped it — another writer's lock, the ID column changed, the re-plan
  limit, anything unexpected — carrying how many records were linked. What
  committed stays, so the endpoint records it and answers with the count; it
  used to be a 500 the client read as "The records could not be linked." with
  5,000 of 12,000 linked. Before the first commit the original exception passes
  through untouched, and the session is rolled back only when one is converted.

Measured on BES over HTTP (2026-10-13; review:
the internal design notes): 76.4 s with the app frozen
→ 7.0 s, worst `/health` 0.20 s, 14 of 14 concurrent writes through. One
transaction of everything was not enough — it held the lock 5.0-5.4 s, and a coding
click waited 4.73 s, 0.27 s from SQLite's 5 s timeout. A double click: the second
request is refused at once (it waited 15 s, then failed).

⚠️ **Writes outside the ORM:** the apply flushes first and `expire_all()`s last,
or a loaded `DatasetRow` keeps reading `participant_id = None`.

⚠️ **The SQL lives inside the functions** — `test_metric_staleness_doors.py` finds
writers by walking function bodies, and a module-level statement would hide one.
"""

import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
import json
from typing import Iterator

from sqlalchemy import select, text
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from ..models.participant import Participant
from ..models.dataset import DatasetColumn, DatasetRow, DatasetValue, Dataset, ColumnType
from .identifier_match import IDENTIFIER_MAX_LENGTH, group_unique_by_key, normalize_key
from .missing_values import column_missing_rules, is_missing


# ⚠️ `IDENTIFIER_MAX_LENGTH` MOVED to `services/identifier_match.py` (row 49) and
# is imported above for this module's own use. An `__all__` re-exporting it was
# written here and REMOVED at close-out: its justification was "so existing
# importers are unchanged", and there are none — nothing outside this file has
# ever imported that constant or `DUPLICATE_VALUES_REPORT_CAP`, and nothing
# star-imports this module. A declaration whose stated reason names an empty
# population is #941's shape, in the same session that applied that rule to two
# surviving mutants.

DUPLICATE_VALUES_REPORT_CAP = 10

#: Rows linked per committed transaction on the standalone endpoint. Measured on
#: BES (prototype, 2026-10-13): 10,000 → longest hold 0.58-0.60 s; 5,000 → 0.35 s.
LINK_WRITE_BATCH = 5_000
#: Fresh plans after a batch found the database changed under it.
MAX_REPLANS = 2

#: `Participant.role` is `String(100)`; a longer cell is not a role (SQLite would
#: store it whole).
ROLE_MAX_LENGTH = 100


def role_from_cell(raw: str | None, missing_rules) -> str | None:
    """The role a linked record's role cell gives its participant, or None.

    #1054 review D4 (§2.7 a): the cell was copied as it stood — padded, a
    recognised or declared missing value ("N/A", a declared "99"), or longer than
    the column holds. The same three rules the IDENTIFIER cell has always had.
    """
    if raw is None:
        return None
    value = raw.strip()
    if not value or is_missing(value, missing_rules) or len(value) > ROLE_MAX_LENGTH:
        return None
    return value


def _role_column(db: Session, dataset_id: int) -> DatasetColumn | None:
    """The dataset's role column — the FIRST by id when there are two (D4, §2.7 b:
    it was `.first()` with no order, so which one filled the role was the planner's).

    ⚠️ The order is stated, not pinned: SQLite's index scan returns the lowest id
    anyway, so removing it fails no test (mutation-checked 2026-10-13)."""
    return (
        db.query(DatasetColumn)
        .filter(
            DatasetColumn.dataset_id == dataset_id,
            DatasetColumn.column_type == ColumnType.DEMOGRAPHIC,
            DatasetColumn.demographic_subtype == "role",
        )
        .order_by(DatasetColumn.id)
        .first()
    )


LINK_BUSY_MESSAGE = (
    "Participants are already being linked in this project. Wait for that to "
    "finish, then run Link by column again if anything is left."
)


class LinkPlanChanged(RuntimeError):
    """What the plan was read from changed before it could be written.

    NOT a `ValueError`: the import routers turn `ValueError` into a refusal about
    the file, which would be false. Only the batched loop of the standalone
    endpoint, which plans with no lock held, can meet it, and it never leaves that
    loop: the loop rolls the batch back and plans again, and when that keeps
    happening it stops with `LinkStopped` (#1231).
    """


#: Why a batched link stopped after committing some of its work (#1231).
LINK_STOPPED_KEPT_CHANGING = "kept_changing"
LINK_STOPPED_BUSY = "busy"
LINK_STOPPED_COLUMN = "column"
LINK_STOPPED_ERROR = "error"


class LinkStopped(RuntimeError):
    """A batched link stopped after it had COMMITTED some batches (#1231).

    🔴 What committed is real and stays, so a stop is never "the records could not
    be linked": it carries how many were linked and why it stopped, and the
    endpoint records it and says it (`link_stopped_sentence`). Every exception that
    escapes the batch loop after a commit becomes one — another writer's lock (a
    project delete, an import, another program), the ID column changed under a
    re-plan, a re-plan limit, or anything unexpected. Before the first commit
    nothing changed, and the original exception goes through untouched.
    """

    def __init__(self, reason: str, *, linked: int, created: int):
        super().__init__(reason)
        self.reason = reason
        self.linked = linked
        self.created = created


def _stop_reason(exc: BaseException) -> str:
    """Why the batch loop stopped, from the exception that stopped it.

    The lock is recognised by the driver's words, as `routers/backup.py` does: a
    project delete, an import or another program holding SQLite's write lock past
    the busy timeout answers "database is locked". Anything unrecognised is an
    unexpected error, which still answers with the count.
    """
    if isinstance(exc, OperationalError) and "locked" in str(exc).lower():
        return LINK_STOPPED_BUSY
    if isinstance(exc, ValueError):  # the re-plan's identifier-column check
        return LINK_STOPPED_COLUMN
    return LINK_STOPPED_ERROR


_STOP_CAUSE = {
    LINK_STOPPED_KEPT_CHANGING: "the dataset kept changing while it was being linked",
    LINK_STOPPED_BUSY: "another change to the project was being saved and the link could not wait for it",
    LINK_STOPPED_COLUMN: "the ID column was changed while the records were being linked",
    LINK_STOPPED_ERROR: "of an unexpected error",
}
_STOP_REMEDY = {
    LINK_STOPPED_COLUMN: "Choose an ID column and run Link by column again to link the rest.",
}


def link_stopped_sentence(e: LinkStopped) -> str:
    """What the researcher reads when a link stopped part-way: why, then the count."""
    if e.linked == 0:  # only a re-plan limit reached before any batch committed
        count = "No record was linked."
    elif e.linked == 1:
        count = "1 record was linked before it stopped and stays linked."
    else:
        count = f"{e.linked:,} records were linked before it stopped and stay linked."
    again = "Run Link by column again to finish." if e.linked else "Run Link by column again."
    remedy = _STOP_REMEDY.get(e.reason, again)
    return f"Linking stopped because {_STOP_CAUSE[e.reason]}. {count} {remedy}"


class LinkBusy(RuntimeError):
    """Another link is running in this project (`link_turn`)."""


_turns = threading.Lock()
_turn_holders: set[int] = set()


@contextmanager
def link_turn(project_id: int) -> Iterator[None]:
    """Hold this project's link turn, or raise `LinkBusy` without waiting.

    As `def`, two links run side by side: a double click 0.3 s apart made the second
    one fail after 15 s, and two links can create the same participant. One at a
    time per project, like `participant_scores.participant_table_turn` (#1073 c),
    in-process like it — another PROCESS meets the unique indexes instead.
    """
    with _turns:
        if project_id in _turn_holders:
            raise LinkBusy(LINK_BUSY_MESSAGE)
        _turn_holders.add(project_id)
    try:
        yield
    finally:
        with _turns:
            _turn_holders.discard(project_id)


@dataclass
class LinkPlan:
    project_id: int
    dataset_id: int
    column_id: int
    already_linked: int = 0
    skipped_missing: int = 0
    skipped_duplicate: int = 0
    skipped_conflict: int = 0
    duplicate_values: list[str] = field(default_factory=list)
    #: (row_id, participant_id, raw cell, identifier, role fill or None)
    to_link: list[tuple] = field(default_factory=list)
    #: (row_id, identifier, raw cell, role or None, role_auto_filled_from or None)
    to_create: list[tuple] = field(default_factory=list)


def plan_identifier_links(
    db: Session,
    *,
    project_id: int,
    dataset_id: int,
    column_id: int,
    row_ids: list[int] | None = None,
) -> LinkPlan:
    """#414 (DEC-10) — decide every link, READING ONLY. The ONE place the rules live.

    Semantics (scoping doc §3):
    - Match key = ``Participant.identifier`` (unique per project — the same
      field the conversation import writes speaker names into), after
      trimming whitespace; comparison stays case-sensitive (DEC-2).
    - No match → create ``Participant(identifier=value, display_name=None)``
      (a code is not a name; DEC-3).
    - A value on >1 candidate row links NOTHING (DEC-4 — never pick an
      arbitrary row; the partial unique index allows one row per participant
      per dataset anyway).
    - Blank / recognized-N/A / absent / over-length values → ``skipped_missing``.
    - An existing participant already linked to another row in THIS dataset →
      ``skipped_conflict``.
    - Rows already linked are NEVER touched (``already_linked``) — a manual
      link is user intent.
    - A participant with no role takes the row's cell in the dataset's role
      column (the first by id), with where it came from.

    Args:
        row_ids: candidate scope — None means every row in the dataset
            (retro/import); append passes just the new rows.
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
    # #592: column-aware, though benign under the invariant that identifier
    # columns can't carry a declaration — this keeps the linking rule on the
    # ONE missing predicate rather than a private _is_na copy.
    missing_rules = column_missing_rules(column)
    plan = LinkPlan(project_id=project_id, dataset_id=dataset_id, column_id=column_id)

    conn = db.connection()
    dataset_name = conn.execute(select(Dataset.name).where(Dataset.id == dataset_id)).scalar()
    # The role column, ONCE (it was re-queried per row: ~65% of HEAD's 76 s on BES).
    role_column = _role_column(db, dataset_id)
    role_column_id = role_column.id if role_column is not None else None
    role_rules = column_missing_rules(role_column) if role_column is not None else None

    sql = [
        "SELECT r.id, r.participant_id, r.row_identifier, v.value_text,",
        "rv.value_text" if role_column_id is not None else "NULL",
        "FROM dataset_rows r",
        "LEFT JOIN dataset_values v ON v.row_id = r.id AND v.column_id = :col",
    ]
    params: dict = {"col": column_id, "ds": dataset_id}
    if role_column_id is not None:
        sql.append("LEFT JOIN dataset_values rv ON rv.row_id = r.id AND rv.column_id = :role_col")
        params["role_col"] = role_column_id
    sql.append("WHERE r.dataset_id = :ds")
    if row_ids is not None:
        sql.append("AND r.id IN (SELECT value FROM json_each(:ids))")
        params["ids"] = json.dumps([int(i) for i in row_ids])
    # HEAD's order (it read rows with no ORDER BY, i.e. by rowid). It decides which
    # row a duplicated value names first in the report. ⚠️ Unpinned: SQLite returns
    # this scan in rowid order anyway, so removing the clause fails no test.
    sql.append("ORDER BY r.id")

    origin = dataset_name if dataset_name is not None else "Unknown"
    usable: list[tuple[str, tuple]] = []
    for row_id, participant_id, row_identifier, raw, role_raw in conn.execute(
        text("\n".join(sql)), params
    ):
        if participant_id is not None:
            plan.already_linked += 1
            continue
        value = normalize_key(raw)
        if not value or is_missing(value, missing_rules) or len(value) > IDENTIFIER_MAX_LENGTH:
            plan.skipped_missing += 1
            continue
        role_cell = role_from_cell(role_raw, role_rules)
        role_from = f"{origin} · {row_identifier or 'Row'}" if role_cell else None
        usable.append((value, (row_id, raw, role_cell, role_from)))

    # The "a value on >1 candidate links NOTHING" rule (DEC-4) lives in
    # `services/identifier_match.py` since 2026-09-22 — row 49's coding import
    # asks the same question of a different key space, and two implementations of
    # a refusal is how the two drift apart (#733).
    linkable, duplicate_values = group_unique_by_key(usable)
    plan.skipped_duplicate = len(usable) - len(linkable)
    plan.duplicate_values = duplicate_values
    if not linkable:
        return plan

    existing: dict[str, tuple[int, str | None]] = {
        identifier: (pid, role)
        for pid, identifier, role in conn.execute(
            text(
                "SELECT id, identifier, role FROM participants WHERE project_id = :p "
                "AND identifier IN (SELECT value FROM json_each(:keys))"
            ),
            {"p": project_id, "keys": json.dumps(list(linkable), ensure_ascii=False)},
        )
    }
    # Participants already linked to ANY row of this dataset (dataset-wide,
    # not candidate-scoped — the partial unique index is per dataset).
    linked_participant_ids = {
        pid for (pid,) in conn.execute(
            select(DatasetRow.participant_id).where(
                DatasetRow.dataset_id == dataset_id, DatasetRow.participant_id.isnot(None),
            )
        )
    }

    for value, (row_id, raw, role_cell, role_from) in linkable.items():
        hit = existing.get(value)
        if hit is None:
            plan.to_create.append((row_id, value, raw, role_cell, role_from))
            continue
        pid, role = hit
        if pid in linked_participant_ids:
            plan.skipped_conflict += 1
            continue
        fill = (role_cell, role_from) if (not role and role_cell) else None
        plan.to_link.append((row_id, pid, raw, value, fill))
    return plan


def apply_identifier_links(
    db: Session,
    plan: LinkPlan,
    *,
    link_slice: slice = slice(None),
    create_slice: slice = slice(None),
) -> tuple[int, int]:
    """WRITE what the plan decided (or one slice of it); returns (matched, created).

    Each statement re-checks its decision in its WHERE clause, and a row count that
    falls short raises `LinkPlanChanged` with nothing rolled back here — the caller
    rolls the batch back and plans again. The races, each run against the
    prototype (review §2.5): a row linked by hand meanwhile (`participant_id IS
    NULL`), a participant created with an id we were about to create (`ON CONFLICT
    DO NOTHING` + the count), the identifier cell edited (the cell still holds the
    planned text), the dataset deleted (the update matches nothing), a matched
    participant renamed or deleted, a manual link to our participant (`NOT EXISTS`).
    """
    db.flush()
    conn = db.connection()
    to_link = plan.to_link[link_slice]
    to_create = plan.to_create[create_slice]

    created_ids: dict[str, int] = {}
    if to_create:
        # One-row statements, executed many: a batched INSERT … RETURNING packs rows
        # into one statement sized against the bind limit, which the ceiling test's
        # lowered limit refuses. The ids are read back by identifier instead.
        inserted = conn.execute(
            sqlite_insert(Participant.__table__).on_conflict_do_nothing(
                index_elements=["project_id", "identifier"]
            ),
            [
                {"project_id": plan.project_id, "identifier": identifier,
                 "display_name": None, "role": role, "role_auto_filled_from": role_from}
                for _row_id, identifier, _raw, role, role_from in to_create
            ],
        ).rowcount
        if inserted != len(to_create):
            raise LinkPlanChanged(
                "a participant this link was about to create was added meanwhile"
            )
        created_ids = {
            identifier: pid
            for pid, identifier in conn.execute(
                text(
                    "SELECT id, identifier FROM participants WHERE project_id = :p "
                    "AND identifier IN (SELECT value FROM json_each(:keys))"
                ),
                {"p": plan.project_id,
                 "keys": json.dumps([c[1] for c in to_create], ensure_ascii=False)},
            )
        }

    links = [(row_id, pid, raw, identifier) for row_id, pid, raw, identifier, _fill in to_link]
    links += [(row_id, created_ids[identifier], raw, identifier)
              for row_id, identifier, raw, _role, _from in to_create]
    if links:
        # ONE prepared statement per row, seeking by primary key. ⚠️ Not
        # `UPDATE … FROM json_each(:map)`: SQLite planned that with the dataset's
        # rows OUTSIDE the JSON array — 122,382² on BES, killed at 10 minutes.
        updated = conn.execute(
            text(
                "UPDATE dataset_rows SET participant_id = :pid "
                "WHERE id = :rid AND dataset_id = :ds AND participant_id IS NULL "
                "AND EXISTS (SELECT 1 FROM dataset_values v WHERE v.row_id = :rid "
                "            AND v.column_id = :col AND v.value_text = :raw) "
                "AND EXISTS (SELECT 1 FROM participants p WHERE p.id = :pid "
                "            AND p.project_id = :p AND p.identifier = :ident) "
                "AND NOT EXISTS (SELECT 1 FROM dataset_rows r2 WHERE r2.dataset_id = :ds "
                "                AND r2.participant_id = :pid)"
            ),
            [
                {"rid": row_id, "pid": pid, "raw": raw, "ident": identifier,
                 "ds": plan.dataset_id, "col": plan.column_id, "p": plan.project_id}
                for row_id, pid, raw, identifier in links
            ],
        ).rowcount
        if updated != len(links):
            raise LinkPlanChanged(f"{len(links) - updated} records changed while linking")

    fills = [(pid, fill) for _row_id, pid, _raw, _identifier, fill in to_link if fill]
    if fills:
        conn.execute(
            text(
                "UPDATE participants SET role = :role, role_auto_filled_from = :origin, "
                "updated_at = CURRENT_TIMESTAMP WHERE id = :pid AND (role IS NULL OR role = '')"
            ),
            [{"pid": pid, "role": role, "origin": origin} for pid, (role, origin) in fills],
        )

    # Row 45 step 4 — this is the bulk link path (import, append, and the retro
    # link-by-column endpoint all reach it), so it is the highest-volume score
    # input there is: every newly linked row makes that person's coded passages
    # reachable. Imported here rather than at module scope to keep the import
    # graph acyclic — `participant_scores` reads the rollup, which reads the
    # resolver, which reads this module's neighbours.
    if links:
        from .participant_scores import mark_participant_scores_stale
        mark_participant_scores_stale(db, plan.project_id)
    db.expire_all()
    return len(to_link), len(to_create)


def link_report(plan: LinkPlan, matched: int, created: int) -> dict:
    return {
        "linked": matched + created,
        "created": created,
        "matched": matched,
        "skipped_missing": plan.skipped_missing,
        "skipped_duplicate": plan.skipped_duplicate,
        "skipped_conflict": plan.skipped_conflict,
        "already_linked": plan.already_linked,
        "duplicate_values": plan.duplicate_values[:DUPLICATE_VALUES_REPORT_CAP],
    }


def link_rows_by_identifier_column(
    db: Session,
    *,
    project_id: int,
    dataset_id: int,
    column_id: int,
    row_ids: list[int] | None = None,
    commit_every: int | None = None,
) -> dict:
    """#414 — link dataset rows to Participants by an identifier column.

    Dataset import, append, and the retro link-by-column endpoint all call it; the
    rules are `plan_identifier_links`'.

    ``commit_every=None`` (import, append): the caller owns the transaction — one
    apply, flushed, never committed. ``commit_every=N`` (the standalone endpoint):
    apply in transactions of N records, COMMITTING each, and plan again (at most
    `MAX_REPLANS` times) when a batch finds the database changed — so an
    interrupted link leaves some records linked, and running it again finishes it.
    A stop after a commit raises `LinkStopped` with the count (#1231); before the
    first commit the original exception passes through.

    Returns a report dict: linked, created, matched, skipped_missing,
    skipped_duplicate, skipped_conflict, already_linked, duplicate_values.
    """
    if commit_every is None:
        plan = plan_identifier_links(
            db, project_id=project_id, dataset_id=dataset_id, column_id=column_id,
            row_ids=row_ids,
        )
        matched, created = apply_identifier_links(db, plan)
        return link_report(plan, matched, created)

    matched = created = 0
    try:
        for _attempt in range(MAX_REPLANS + 1):
            plan = plan_identifier_links(
                db, project_id=project_id, dataset_id=dataset_id, column_id=column_id,
                row_ids=row_ids,
            )
            # Records this call linked before a re-plan read them as already linked.
            ours = matched + created
            try:
                for i in range(0, len(plan.to_link), commit_every):
                    m, _c = apply_identifier_links(
                        db, plan, link_slice=slice(i, i + commit_every), create_slice=slice(0, 0),
                    )
                    db.commit()
                    matched += m
                for i in range(0, len(plan.to_create), commit_every):
                    _m, c = apply_identifier_links(
                        db, plan, link_slice=slice(0, 0), create_slice=slice(i, i + commit_every),
                    )
                    db.commit()
                    created += c
            except LinkPlanChanged:
                db.rollback()
                continue
            report = link_report(plan, matched, created)
            report["already_linked"] = max(plan.already_linked - ours, 0)
            return report
    except Exception as exc:
        # #1231: after a commit, ANY exception is a stop part-way — the batches that
        # committed stay. It was an `OperationalError` straight to a 500 the client
        # read as "could not be linked", with 5,000 of 12,000 linked (executed).
        # Re-raise FIRST and roll back only on conversion: a pass-through hands the
        # session to the caller's arms untouched, as before #1231.
        if matched + created == 0:
            raise
        db.rollback()  # the batch in flight; the router's audit commit must not carry it
        raise LinkStopped(
            _stop_reason(exc), linked=matched + created, created=created,
        ) from exc
    raise LinkStopped(LINK_STOPPED_KEPT_CHANGING, linked=matched + created, created=created)


def auto_fill_role_from_linked_row(
    db: Session,
    participant: Participant,
    dataset_row: DatasetRow,
) -> bool:
    """Auto-fill participant.role from a linked dataset row's role column.

    Only fills if participant.role is empty and the dataset has a
    demographic column with subtype='role'. The single-row link doors call it;
    the bulk path decides the same thing in `plan_identifier_links`.
    Returns True if role was auto-filled.
    """
    if participant.role:
        return False

    role_col = _role_column(db, dataset_row.dataset_id)
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
    role = role_from_cell(role_value.value_text if role_value else None,
                          column_missing_rules(role_col))
    if not role:
        return False

    dataset = db.query(Dataset).filter(Dataset.id == dataset_row.dataset_id).first()
    dataset_name = dataset.name if dataset else "Unknown"

    participant.role = role
    participant.role_auto_filled_from = (
        f"{dataset_name} · {dataset_row.row_identifier or 'Row'}"
    )
    return True
