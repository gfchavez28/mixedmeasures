"""#1546 (D157 + D160) — a deleted turn's or answer's WORDS leave the audit trail with it.

The conversation door's `segment_updated` keeps a turn's old and new wording, and the
answer door's `value_updated` an answer's. Deleting the conversation or the dataset left
both, keyed on ids nobody holds, so a withdrawal made afterwards could not find them — the
link to the person went with the source — and the person's words stayed in the project and
the Excel *Audit Trail* after it said they were removed. Found by the 2026-11-06e
`/codebase-audit` (F4); the HTTP class below is its probe, kept wanted-side up.

D157 strips them at every delete (`services/deleted_source_audit.py`; the doors are found
by `test_deleted_source_words_doors.py`), and D160 strips what a delete before the fix left
(`repair_leftover_words`, in `run_data_repairs`).
"""
from __future__ import annotations

import asyncio
import io
import json
from types import SimpleNamespace

import openpyxl
import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models.audit import AuditEntry
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.routers import participants as participants_router
from app.routers.conversations import delete_conversation
from app.routers.dataset import delete_manual_column, delete_row
from app.services.audit import log_action
from app.services.data_repairs import run_data_repairs
from app.services.dataset_rows import materialise_manual_cells
from app.services.deleted_source_audit import SOURCE_DELETED_MARK, repair_leftover_words
from app.services.participant_dataset import create_participant_dataset, sync_rows
from tests.test_withdrawal_deleted_history import _edit, _merge, _project, _unmerge


def _run(coro):
    return asyncio.run(coro)


def _details(db, entry_id) -> dict:
    db.expire_all()
    return json.loads(db.get(AuditEntry, entry_id).details)


def _stripped(details: dict) -> bool:
    return details.get("redacted") == SOURCE_DELETED_MARK and not any(
        isinstance(v, str) for k, v in details.items() if k != "redacted"
    )


def _answer_edit(db, value: DatasetValue, dataset_id: int, old: str, new: str) -> int:
    """The answer door's entry, with its keys (`routers/dataset.py::update_value`)."""
    e = log_action(db, action="value_updated", entity_type="dataset_value", entity_id=value.id,
                   user_id=1, project_id=1,
                   details={"dataset_id": dataset_id, "column_id": value.column_id,
                            "old_value": old, "new_value": new})
    db.flush()
    return e.id


# ── The audit's probe, end to end over HTTP ─────────────────────────────────────


def _audit_blob():
    db = SessionLocal()
    try:
        return " ".join((d or "") for (d,) in db.query(AuditEntry.details))
    finally:
        db.close()


@pytest.fixture(scope="module")
def run():
    Base.metadata.create_all(bind=engine)
    with pytest.MonkeyPatch.context() as mp, TestClient(app) as c:
        mp.setattr(participants_router, "create_backup",
                   lambda *a, **k: SimpleNamespace(filename="probe.mmbackup"))
        st = c.get("/api/auth/status").json()
        H = {"X-CSRF-Token": st["user"]["csrf_token"]}
        pid = c.post("/api/projects", json={"name": "Probe 1546"}, headers=H).json()["id"]
        m = c.post(f"/api/projects/{pid}/participants",
                   json={"identifier": "WDQ1", "display_name": "Wanda"}, headers=H).json()
        db = SessionLocal()
        sp = Speaker(project_id=pid, name="Wanda", participant_id=m["id"], color_index=1)
        db.add(sp); db.flush()
        convA = Conversation(project_id=pid, name="A"); convB = Conversation(project_id=pid, name="B")
        db.add_all([convA, convB]); db.flush()
        sA = Segment(conversation_id=convA.id, speaker_id=sp.id, sequence_order=0,
                     text="SECRETAORIG words", word_count=2)
        sB = Segment(conversation_id=convB.id, speaker_id=sp.id, sequence_order=0,
                     text="LIVEBORIG words", word_count=2)
        db.add_all([sA, sB]); db.flush()
        ds = Dataset(project_id=pid, name="D1"); ds2 = Dataset(project_id=pid, name="D2")
        db.add_all([ds, ds2]); db.flush()
        cols = []
        for d in (ds, ds2):
            col = DatasetColumn(dataset_id=d.id, column_code="Q", column_text="Q", column_name="Q",
                                column_type=ColumnType.OPEN_TEXT, sequence_order=0,
                                display_order=0, source="manual")
            db.add(col); db.flush(); cols.append(col)
        rA = DatasetRow(dataset_id=ds.id, participant_id=m["id"], row_identifier="WDQ1")
        rB = DatasetRow(dataset_id=ds2.id, participant_id=m["id"], row_identifier="WDQ1")
        db.add_all([rA, rB]); db.flush()
        vA = DatasetValue(row_id=rA.id, column_id=cols[0].id, value_text="SECRETDORIG")
        vB = DatasetValue(row_id=rB.id, column_id=cols[1].id, value_text="LIVEDORIG")
        db.add_all([vA, vB]); db.commit()
        ids = dict(cA=convA.id, cB=convB.id, sA=sA.id, sB=sB.id, dA=ds.id, dB=ds2.id,
                   vA=vA.id, vB=vB.id)
        db.close()

        def ok(r):
            assert r.status_code < 300, (r.request.url, r.status_code, r.text[:300])
        ok(c.patch(f"/api/conversations/{ids['cA']}/segments/{ids['sA']}",
                   json={"text": "SECRETAEDIT words"}, headers=H))
        ok(c.patch(f"/api/conversations/{ids['cB']}/segments/{ids['sB']}",
                   json={"text": "LIVEBEDIT words"}, headers=H))
        ok(c.patch(f"/api/projects/{pid}/datasets/{ids['dA']}/values/{ids['vA']}",
                   json={"value_text": "SECRETDEDIT"}, headers=H))
        ok(c.patch(f"/api/projects/{pid}/datasets/{ids['dB']}/values/{ids['vB']}",
                   json={"value_text": "LIVEDEDIT"}, headers=H))
        before = _audit_blob()
        ok(c.delete(f"/api/projects/{pid}/conversations/{ids['cA']}", headers=H))
        ok(c.delete(f"/api/projects/{pid}/datasets/{ids['dA']}", headers=H))
        after_delete = _audit_blob()
        db = SessionLocal()
        marked = db.query(AuditEntry).filter(
            AuditEntry.project_id == pid,
            AuditEntry.details.like(f'%"redacted": "{SOURCE_DELETED_MARK}"%'),
        ).count()
        db.close()
        ok(c.post(f"/api/projects/{pid}/participants/{m['id']}/withdraw", headers=H))
        after = _audit_blob()
        x = c.get(f"/api/projects/{pid}/export/excel")
        ok(x)
        wb = openpyxl.load_workbook(io.BytesIO(x.content))
        trail = " ".join(str(v) for row in wb["Audit Trail"].iter_rows(values_only=True)
                         for v in row if v is not None)
        yield dict(before=before, after_delete=after_delete, after=after, trail=trail,
                   marked=marked)
        # The app's engine is shared by every HTTP test in the run: leave nothing behind
        # (`test_project_deletion.py` counts every segment in the database) — and no
        # deletion record either: the next project takes this id (SQLite reuses it), and
        # that test expects ONE record for its own.
        from app.services.audit import forget_project_audit
        from app.services.project_deletion import delete_project_tree

        db = SessionLocal()
        delete_project_tree(db, db.get(Project, pid))
        forget_project_audit(db, pid)
        db.commit()
        db.close()


SECRET = ("SECRETAORIG", "SECRETAEDIT", "SECRETDORIG", "SECRETDEDIT")
LIVE = ("LIVEBORIG", "LIVEBEDIT", "LIVEDORIG", "LIVEDEDIT")


class TestOverHttp:
    def test_POSITIVE_CONTROL_every_sentinel_was_in_the_trail(self, run):
        for s in SECRET + LIVE:
            assert s in run["before"], s

    def test_the_deletes_take_their_sources_words(self, run):
        left = [s for s in SECRET if s in run["after_delete"]]
        assert not left, f"still in audit_entries after the deletes: {left}"

    def test_the_entries_stay_and_say_why(self, run):
        """D157 keeps the trail that an edit happened (D9's shape): one turn edit and one
        answer edit, each marked."""
        assert run["marked"] == 2, run["marked"]

    def test_CONTROL_a_delete_takes_only_its_own_sources_words(self, run):
        for s in LIVE:
            assert s in run["after_delete"], s

    def test_after_the_withdrawal_none_of_her_words_remain(self, run):
        left = [s for s in SECRET + LIVE if s in run["after"]]
        assert not left, f"in audit_entries after the withdrawal: {left}"
        in_trail = [s for s in SECRET + LIVE if s in run["trail"]]
        assert not in_trail, f"in the Excel Audit Trail: {in_trail}"


# ── Each door, called directly ──────────────────────────────────────────────────


def _survey(db, n_rows=2, n_cols=2):
    db.add(Project(id=1, name="P", user_id=1))
    db.flush()
    ds = Dataset(project_id=1, name="Survey")
    db.add(ds)
    db.flush()
    cols = []
    for i in range(n_cols):
        col = DatasetColumn(dataset_id=ds.id, column_code=f"Q{i}", column_text=f"Q{i}",
                            column_name=f"Q{i}", column_type=ColumnType.OPEN_TEXT,
                            sequence_order=i, display_order=i, source="manual")
        db.add(col)
        db.flush()
        cols.append(col)
    cells = {}
    for r in range(n_rows):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{r}")
        db.add(row)
        db.flush()
        for c, col in enumerate(cols):
            v = DatasetValue(row_id=row.id, column_id=col.id, value_text=f"answer {r}{c}")
            db.add(v)
            db.flush()
            cells[(r, c)] = (row, v, _answer_edit(db, v, ds.id, f"OLD{r}{c}", f"answer {r}{c}"))
    db.commit()
    return ds, cols, cells


class TestTheAnswerDoors:
    def test_a_record_delete_takes_its_answers_words_and_no_others(self, db_session):
        db = db_session
        ds, _, cells = _survey(db)
        row0 = cells[(0, 0)][0]
        _run(delete_row(1, ds.id, row0.id, user=db.get(User, 1), db=db))
        assert _stripped(_details(db, cells[(0, 0)][2]))
        assert _stripped(_details(db, cells[(0, 1)][2]))
        assert _details(db, cells[(1, 0)][2])["old_value"] == "OLD10"

    def test_a_column_delete_takes_its_answers_words_and_no_others(self, db_session):
        db = db_session
        ds, cols, cells = _survey(db)
        _run(delete_manual_column(1, ds.id, cols[0].id, user=db.get(User, 1), db=db))
        assert _stripped(_details(db, cells[(0, 0)][2]))
        assert _stripped(_details(db, cells[(1, 0)][2]))
        assert _details(db, cells[(0, 1)][2])["old_value"] == "OLD01"

    def test_the_participant_tables_reap_takes_its_answers_words(self, db_session):
        """A column the researcher added to the participant table is edited by hand; a
        refresh after a participant is deleted reaps their record (`sync_rows`)."""
        db = db_session
        db.add(Project(id=1, name="P", user_id=1))
        db.flush()
        for ident in ("E-01", "E-02"):
            db.add(Participant(project_id=1, identifier=ident))
        db.flush()
        table = create_participant_dataset(db, 1)
        notes = DatasetColumn(dataset_id=table.id, column_code="N", column_text="Notes",
                              column_name="Notes", column_type=ColumnType.OPEN_TEXT,
                              sequence_order=50, display_order=50, source="manual")
        db.add(notes)
        db.flush()
        materialise_manual_cells(db, table.id)
        entries = {}
        for p in db.query(Participant).filter(Participant.project_id == 1):
            row = db.query(DatasetRow).filter(
                DatasetRow.dataset_id == table.id, DatasetRow.participant_id == p.id).one()
            cell = db.query(DatasetValue).filter(
                DatasetValue.row_id == row.id, DatasetValue.column_id == notes.id).one()
            entries[p.identifier] = _answer_edit(db, cell, table.id, "", f"NOTE {p.identifier}")
        db.delete(db.query(Participant).filter(Participant.identifier == "E-01").one())
        db.flush()
        sync_rows(db, table)
        assert _stripped(_details(db, entries["E-01"]))
        assert _details(db, entries["E-02"])["new_value"] == "NOTE E-02"


class TestAConversationTakesItsLineage:
    """A merge result an Unmerge deleted keeps its edit's words — the walk needs them while
    its originals live (#1473 b). Deleting the conversation takes them too."""

    def test_the_deleted_merge_results_edit_goes_with_the_conversation(self, db_session):
        db = db_session
        _project(db)
        p = _merge(db, [2, 3])
        entry = _edit(db, p.id, p.text, p.text + " MERGEEDIT")
        _unmerge(db, p.id)
        db.commit()
        assert "MERGEEDIT" in _details(db, entry)["new_text"], "precondition: the walk's to keep"
        _run(delete_conversation(1, 1, user=db.get(User, 1), db=db))
        assert _stripped(_details(db, entry))

    def test_its_turns_own_edits_go_and_another_conversations_stay(self, db_session):
        db = db_session
        _project(db)
        db.add(Conversation(id=2, project_id=1, name="Other"))
        db.flush()
        other = Segment(conversation_id=2, speaker_id=2, sequence_order=0, text="Elsewhere.")
        db.add(other)
        db.flush()
        mine = _edit(db, 1, "Wren's private words here.", "Wren's EDITED words.")
        theirs = _edit(db, other.id, "Elsewhere.", "Elsewhere, EDITED.")
        db.commit()
        _run(delete_conversation(1, 1, user=db.get(User, 1), db=db))
        assert _stripped(_details(db, mine))
        assert _details(db, theirs)["new_text"] == "Elsewhere, EDITED."


# ── D160: what a delete before the fix left ─────────────────────────────────────


def _legacy(db):
    """Every shape the repair must tell apart, each with its own sentinel."""
    _project(db)
    out = {}
    # (a) a turn of a conversation deleted before the fix
    db.add(Conversation(id=2, project_id=1, name="Gone"))
    db.flush()
    gone = Segment(conversation_id=2, speaker_id=2, sequence_order=0, text="Gone turn.")
    db.add(gone)
    db.flush()
    out["dead_turn"] = _edit(db, gone.id, "Gone turn.", "GONETURN")
    # (c) a merge result an Unmerge deleted, whose originals live: the walk's
    p = _merge(db, [2, 3])
    out["lifetime"] = _edit(db, p.id, p.text, "LIFETIME")
    _unmerge(db, p.id)
    # (d) a live turn's own edit
    out["live_turn"] = _edit(db, 4, "Ola again speaks.", "LIVETURN")
    db.delete(db.get(Conversation, 2))                     # the pre-fix delete: no strip
    db.flush()
    # (e) a turn an import gave the deleted turn's id: its entry is the old holder's
    db.add(Conversation(id=3, project_id=1, name="Imported"))
    db.flush()
    reused = Segment(conversation_id=3, speaker_id=3, sequence_order=0, text="New turn.")
    db.add(reused)
    db.flush()
    assert reused.id == gone.id, "precondition: SQLite reused the id"
    log_action(db, action="imported", entity_type="conversation", entity_id=3,
               user_id=1, project_id=1, details={"name": "Imported"})
    out["reused_own"] = _edit(db, reused.id, "New turn.", "REUSEDOWN")
    # answers: (b) a deleted answer, (f) another column's entry on a reused id, (g) own
    ds = Dataset(project_id=1, name="S")
    db.add(ds)
    db.flush()
    cols = []
    for i in range(2):
        col = DatasetColumn(dataset_id=ds.id, column_code=f"Q{i}", column_text=f"Q{i}",
                            column_name=f"Q{i}", column_type=ColumnType.OPEN_TEXT,
                            sequence_order=i, display_order=i, source="manual")
        db.add(col)
        db.flush()
        cols.append(col)
    row, row2 = DatasetRow(dataset_id=ds.id, row_identifier="R1"), DatasetRow(
        dataset_id=ds.id, row_identifier="R2")
    db.add_all([row, row2])
    db.flush()
    keep = DatasetValue(row_id=row.id, column_id=cols[0].id, value_text="kept")
    db.add(keep)
    db.flush()
    out["live_answer"] = _answer_edit(db, keep, ds.id, "LIVEANSWER", "kept")
    dead = DatasetValue(row_id=row2.id, column_id=cols[0].id, value_text="x")
    db.add(dead)
    db.flush()
    out["other_column"] = _answer_edit(db, dead, ds.id, "OTHERCOLUMN", "x")
    db.delete(dead)                                        # pre-fix: no strip
    db.flush()
    reborn = DatasetValue(row_id=row2.id, column_id=cols[1].id, value_text="y")
    db.add(reborn)
    db.flush()
    assert reborn.id == dead.id, "precondition: SQLite reused the id"
    gone_value = DatasetValue(row_id=row.id, column_id=cols[1].id, value_text="z")
    db.add(gone_value)
    db.flush()
    out["dead_answer"] = _answer_edit(db, gone_value, ds.id, "DEADANSWER", "z")
    db.delete(gone_value)
    db.commit()
    return out


STRIPPED = ("dead_turn", "dead_answer", "other_column")
KEPT = ("lifetime", "live_turn", "reused_own", "live_answer")


class TestTheRepair:
    def test_it_strips_the_leftovers_and_keeps_what_a_live_row_or_the_walk_claims(self, db_session):
        db = db_session
        ids = _legacy(db)
        assert repair_leftover_words(db) == len(STRIPPED)
        db.commit()
        for k in STRIPPED:
            assert _stripped(_details(db, ids[k])), k
        for k in KEPT:
            d = _details(db, ids[k])
            assert "redacted" not in d, (k, d)

    def test_a_settled_install_pays_reads_only(self, db_session):
        """Startup runs it every launch; once it has run it must write nothing (#1033)."""
        db = db_session
        _legacy(db)
        assert repair_leftover_words(db) == len(STRIPPED)  # precondition: it had work
        db.commit()
        statements: list[str] = []

        def spy(conn, cursor, statement, *args):
            statements.append(statement.lstrip().split(None, 1)[0].upper())

        bind = db.get_bind()
        event.listen(bind, "before_cursor_execute", spy)
        try:
            assert repair_leftover_words(db) == 0
            db.commit()
        finally:
            event.remove(bind, "before_cursor_execute", spy)
        assert statements, "the spy saw nothing — it is not watching this engine"
        assert not {"UPDATE", "DELETE", "INSERT"} & set(statements), statements

    def test_it_runs_from_run_data_repairs(self, db_session):
        """Entered at the startup list, not at the service (`app-lifespan.md`)."""
        db = db_session
        ids = _legacy(db)
        run_data_repairs(lambda: Session(bind=db.get_bind()))
        for k in STRIPPED:
            assert _stripped(_details(db, ids[k])), k
        assert "redacted" not in _details(db, ids["lifetime"])
