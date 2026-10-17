"""#1053 — the record picker searches on the server and answers one page.

`GET …/datasets/{id}/linkable-rows` used to return every record with every value
for the browser to filter: 70.3 s and 72 MB on GSS, the app frozen throughout,
and a 30 s client limit it never met. `services/linkable_rows.py` now answers a
term with one ranked page and the total. These tests pin what a researcher relies
on: what matches, in what order, what the total means, how case folds, what the
label and the excerpt show, and that the statement keeps the plan that makes it
fast.
"""
import json
import sqlite3
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import event, text

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.participant import Participant
from app.models.project import Project
from app.models.user import User
from app.routers.dataset import get_linkable_rows
from app.services import linkable_rows as svc
from app.services.participant_dataset import (
    ACTION_LINK_PARTICIPANTS,
    create_participant_dataset,
    managed_dataset_refusal,
)

PID = 10
DID = 10


def _seed(db, columns, rows, *, pid=PID, did=DID, make_project=True):
    """``columns``: ``(id, heading, ColumnType)``; ``rows``: ``(id, record id, {column id: text})``
    or with a fourth item, ``submitted_at``."""
    if make_project:
        db.add(Project(id=pid, name=f"P{pid}", user_id=1))
        db.flush()
    db.add(Dataset(id=did, project_id=pid, name=f"Survey {did}"))
    db.flush()
    for order, (cid, heading, ctype) in enumerate(columns):
        db.add(DatasetColumn(id=cid, dataset_id=did, column_code=f"c{cid}", column_text=heading,
                             column_type=ctype, sequence_order=order, display_order=order))
    db.flush()
    for row in rows:
        rid, identifier, cells = row[:3]
        submitted = row[3] if len(row) > 3 else None
        db.add(DatasetRow(id=rid, dataset_id=did, row_identifier=identifier, submitted_at=submitted))
        db.flush()
        for cid, value in cells.items():
            db.add(DatasetValue(row_id=rid, column_id=cid, value_text=value))
    db.flush()


def _search(db, q="", *, limit=50, offset=0, pid=PID, did=DID):
    user = db.get(User, 1)
    return get_linkable_rows(project_id=pid, dataset_id=did, user=user, db=db,
                             q=q, limit=limit, offset=offset)


def _ids(page):
    return [r["row_id"] for r in page["rows"]]


NAME = (1, "Name", ColumnType.NOMINAL)
NOTE = (2, "Note", ColumnType.OPEN_TEXT)
SCORE = (3, "Score", ColumnType.NUMERIC)
PID_COL = (4, "Participant code", ColumnType.IDENTIFIER)


class TestWhatMatches:
    def test_every_value_and_the_record_id_are_searched(self, db_session):
        _seed(db_session, [NAME, SCORE], [
            (1, "R001", {1: "Ana", 3: "74"}),
            (2, "R002", {1: "Ben", 3: "12"}),
        ])
        assert _ids(_search(db_session, "ana")) == [1]
        assert _ids(_search(db_session, "74")) == [1], "a value outside the label is searched"
        assert _ids(_search(db_session, "R002")) == [2], "the record id is searched"
        assert _search(db_session, "zzz") == {
            "rows": [], "total": 0, "limit": 50, "offset": 0, "link_refusal": None,
        }

    def test_like_wildcards_in_a_term_are_literal(self, db_session):
        _seed(db_session, [NOTE], [
            (1, "R1", {2: "50%"}), (2, "R2", {2: "500"}),
            (3, "R3", {2: "a_b"}), (4, "R4", {2: "axb"}),
            (5, "R5", {2: "back\\slash"}), (6, "R6", {2: "backslash"}),
        ])
        assert _ids(_search(db_session, "50%")) == [1]
        assert _ids(_search(db_session, "a_b")) == [3]
        assert _ids(_search(db_session, "\\")) == [5]

    def test_ascii_case_is_folded(self, db_session):
        _seed(db_session, [NOTE], [(1, "R1", {2: "BREXIT"}), (2, "R2", {2: "other"})])
        for term in ("brexit", "Brexit", "BREXIT"):
            assert _ids(_search(db_session, term)) == [1], term

    def test_non_ascii_case_is_folded_like_the_old_browser_search(self, db_session):
        """`LIKE` folds ASCII only; without the fold function "élodie" stops finding
        "Élodie" — which the browser's `toLowerCase` search did."""
        _seed(db_session, [NAME], [(1, "R1", {1: "Élodie"}), (2, "R2", {1: "Elodie"})])
        assert _ids(_search(db_session, "élodie")) == [1]
        assert _ids(_search(db_session, "ÉLODIE")) == [1]

    def test_the_fold_is_casefold_not_lower(self, db_session):
        """"ß" folds to "ss": a term typed with it finds the capitalised spelling."""
        _seed(db_session, [NAME], [(1, "R1", {1: "STRASSE"}), (2, "R2", {1: "Strand"})])
        assert _ids(_search(db_session, "straße")) == [1]

    def test_a_declared_missing_value_counts_as_a_match(self, db_session):
        """Decision D5: GSS's `inapplicable` matches every record, and the
        excerpt is what makes that legible. Labels still skip it."""
        _seed(db_session, [NAME, NOTE], [(1, "R1", {1: "Ana", 2: "Refused"})])
        note = db_session.get(DatasetColumn, 2)
        note.missing_values = json.dumps([{"value": "Refused", "label": "Refused"}])
        db_session.flush()
        page = _search(db_session, "refused")
        assert _ids(page) == [1]
        assert page["rows"][0]["display_values"] == ["Ana"], "a missing value is never a label"
        assert page["rows"][0]["matched"]["excerpt"] == "Refused"

    def test_linked_records_are_offered_with_their_holder(self, db_session):
        _seed(db_session, [NAME], [(1, "R1", {1: "Ana"}), (2, "R2", {1: "Ana B"})])
        db_session.add(Participant(id=7, project_id=PID, identifier="P07", display_name="Ana Q"))
        db_session.flush()
        db_session.get(DatasetRow, 1).participant_id = 7
        db_session.flush()
        rows = {r["row_id"]: r for r in _search(db_session, "ana")["rows"]}
        assert rows[1]["linked_participant_id"] == 7
        assert rows[1]["linked_participant_name"] == "Ana Q"
        assert rows[2]["linked_participant_id"] is None
        assert rows[2]["linked_participant_name"] is None


class TestTheOrder:
    def test_exact_before_starts_with_before_contains(self, db_session):
        _seed(db_session, [NOTE], [
            (1, "R1", {2: "bobcat"}),
            (2, "R2", {2: "catalogue"}),
            (3, "R3", {2: " cat "}),
        ])
        assert _ids(_search(db_session, "cat")) == [3, 2, 1]

    def test_identity_outranks_any_other_value(self, db_session):
        """GSS's "23": a record whose id CONTAINS it beats one whose AGE IS 23 —
        and so does an identifier-typed column."""
        _seed(db_session, [SCORE, PID_COL], [
            (1, "R0001", {3: "23"}),
            (2, "R0123", {}),
            (3, "R0002", {4: "X230"}),
        ])
        assert _ids(_search(db_session, "23")) == [2, 3, 1]

    def test_a_record_counts_its_best_match(self, db_session):
        """Row 2's first-listed value is only a `contains`, its name is exact; a
        rank taken from any value but the best would put row 1 (a prefix) first."""
        _seed(db_session, [NOTE, NAME], [
            (1, "R1", {2: "maple tree", 1: "x"}),
            (2, "R2", {2: "a maple tree", 1: "maple"}),
        ])
        assert _ids(_search(db_session, "maple")) == [2, 1]

    def test_ties_follow_the_grids_two_key_order_not_id(self, db_session):
        """`dataset_row_order` is `submitted_at` NULLS LAST, then id — dates that
        run AGAINST the ids make the two orders disagree."""
        early = datetime(2026, 1, 1, tzinfo=timezone.utc)
        late = datetime(2026, 6, 1, tzinfo=timezone.utc)
        _seed(db_session, [NOTE], [
            (1, "R1", {2: "same"}, None),
            (2, "R2", {2: "same"}, late),
            (3, "R3", {2: "same"}, early),
        ])
        assert _ids(_search(db_session, "same")) == [3, 2, 1]
        assert _ids(_search(db_session)) == [3, 2, 1], "the empty term uses the same order"


class TestThePage:
    def test_the_total_counts_every_match_and_the_page_is_a_slice(self, db_session):
        _seed(db_session, [NOTE], [(i, f"R{i}", {2: "yes"}) for i in range(1, 6)])
        first = _search(db_session, "yes", limit=2)
        assert (first["total"], _ids(first)) == (5, [1, 2])
        assert _ids(_search(db_session, "yes", limit=2, offset=2)) == [3, 4]
        assert _ids(_search(db_session, "yes", limit=2, offset=4)) == [5]

    def test_an_offset_past_the_end_still_says_how_many_there_are(self, db_session):
        _seed(db_session, [NOTE], [(i, f"R{i}", {2: "yes"}) for i in range(1, 4)])
        page = _search(db_session, "yes", limit=2, offset=10)
        assert (page["rows"], page["total"]) == ([], 3)

    def test_the_empty_term_is_every_record(self, db_session):
        _seed(db_session, [NOTE], [(i, f"R{i}", {}) for i in range(1, 4)])
        page = _search(db_session, "   ")
        assert (page["total"], _ids(page)) == (3, [1, 2, 3])


class TestWhatARowShows:
    def test_the_label_is_up_to_three_identifying_values_trimmed_and_cut(self, db_session):
        long = "x" * 50
        _seed(db_session, [NAME, SCORE, NOTE, PID_COL, (5, "More", ColumnType.NOMINAL)], [
            (1, "R1", {1: " Ana ", 3: "74", 2: long, 4: "P1", 5: "fourth"}),
        ])
        label = _search(db_session)["rows"][0]["display_values"]
        assert label == ["Ana", "x" * 39 + "…", "P1"]

    def test_matched_names_the_column_and_shows_the_words(self, db_session):
        _seed(db_session, [NAME, (6, "Marital status", ColumnType.NUMERIC)], [
            (1, "R1", {1: "Ana", 6: "Widowed, never\nmarried before the war and after it too"}),
        ])
        db_session.get(DatasetColumn, 6).column_name = "  "  # blank short name falls back
        db_session.flush()
        matched = _search(db_session, "never married")["rows"]
        assert matched == []  # the newline is in the VALUE; the term has a space
        matched = _search(db_session, "never")["rows"][0]["matched"]
        assert matched["column_id"] == 6
        assert matched["column_label"] == "Marital status"
        assert matched["excerpt"] == "Widowed, never married before the war…"

    def test_the_excerpt_is_cut_at_words_when_the_context_has_them(self, db_session):
        """25 characters either side lands MID-WORD at both ends of row 1 ("d|elta",
        "kilo|gram"), so those part-words go; on row 2 both ends land exactly on a word
        boundary, so no whole word is dropped; row 3 has no space to cut at."""
        mid_word = "alpha bravo charlie delta echoes foxtrot golf needle hotels india juliet kilogram lima"
        on_spaces = "alpha bravo charlie delta echo needle hotel india juliet kilos lima"
        unbroken = "x" * 40 + "needle" + "y" * 40
        _seed(db_session, [NAME, (8, "Long", ColumnType.NUMERIC)], [
            (1, "R1", {1: "Ana", 8: mid_word}), (2, "R2", {1: "Ben", 8: on_spaces}),
            (3, "R3", {1: "Cy", 8: unbroken}),
        ])
        excerpts = {r["row_id"]: r["matched"]["excerpt"] for r in _search(db_session, "needle")["rows"]}
        assert excerpts[1] == "…echoes foxtrot golf needle hotels india juliet…"
        assert excerpts[2] == "…bravo charlie delta echo needle hotel india juliet kilos…"
        assert excerpts[3] == "…" + "x" * 25 + "needle" + "y" * 25 + "…"

    def test_no_excerpt_when_the_label_or_record_id_already_shows_the_match(self, db_session):
        # A value outside the label ALSO holds each term, so only the two rules keep
        # the excerpt away.
        _seed(db_session, [NAME, SCORE], [(1, "R100", {1: "Ana", 3: "ana at stop r100"})])
        assert _search(db_session, "ana")["rows"][0]["matched"] is None
        assert _search(db_session, "r10")["rows"][0]["matched"] is None
        assert _search(db_session)["rows"][0]["matched"] is None

    def test_the_excerpt_cuts_the_original_text_after_a_fold_that_changes_length(self, db_session):
        """"ß" casefolds to TWO characters, so an index into the folded text is
        not an index into the original; the excerpt must still show the original."""
        before = "ß" * 30
        _seed(db_session, [NAME, (7, "Street", ColumnType.NUMERIC)], [
            (1, "R1", {1: "Ana", 7: f"{before}Hauptstraße 5"}),
        ])
        excerpt = _search(db_session, "HAUPTSTRAßE")["rows"][0]["matched"]["excerpt"]
        assert excerpt == "…" + "ß" * 25 + "Hauptstraße 5"


class TestTheDoor:
    def test_a_table_the_tool_maintains_answers_with_its_refusal(self, db_session):
        db_session.add(Project(id=PID, name="P", user_id=1))
        db_session.flush()
        managed = create_participant_dataset(db_session, PID)
        db_session.flush()
        page = _search(db_session, did=managed.id)
        assert page["rows"] == [] and page["total"] == 0
        assert page["link_refusal"] == managed_dataset_refusal(managed, ACTION_LINK_PARTICIPANTS)
        assert page["link_refusal"]

    def test_an_ordinary_dataset_carries_no_refusal(self, db_session):
        _seed(db_session, [NAME], [(1, "R1", {1: "Ana"})])
        assert _search(db_session)["link_refusal"] is None

    def test_another_projects_dataset_is_not_found(self, db_session):
        _seed(db_session, [NAME], [(1, "R1", {1: "Ana"})])
        db_session.add(Project(id=11, name="Other", user_id=1))
        db_session.flush()
        with pytest.raises(HTTPException) as exc:
            _search(db_session, pid=11, did=DID)
        assert exc.value.status_code == 404


class TestThePlan:
    def _captured_search(self, db, term):
        captured = []

        def grab(conn, cursor, statement, parameters, context, executemany):
            captured.append((statement, parameters))

        engine = db.get_bind()
        event.listen(engine, "before_cursor_execute", grab)
        try:
            _search(db, term)
        finally:
            event.remove(engine, "before_cursor_execute", grab)
        searches = [c for c in captured if "UNION ALL" in c[0] and "GROUP BY" in c[0]]
        # Self-check: the statement captured IS the search, or the plan below
        # describes something else and passes by accident.
        assert len(searches) == 1, [c[0][:80] for c in captured]
        return searches[0]

    @pytest.mark.parametrize("term", ["maple", "élodie"])
    def test_values_are_sought_by_row_never_walked_by_column(self, db_session, term):
        """`column_id IN (the dataset's columns)` flips SQLite onto the column index
        and walks every value of the dataset (2.6 s vs 0.95 s on GSS)."""
        _seed(db_session, [NAME, NOTE], [(i, f"R{i}", {1: "maple", 2: "élodie"}) for i in range(1, 4)])
        statement, parameters = self._captured_search(db_session, term)
        raw = db_session.connection().connection.dbapi_connection
        plan = " | ".join(row[3] for row in raw.execute("EXPLAIN QUERY PLAN " + statement, parameters))
        assert "ix_dataset_values_row_id" in plan, plan
        assert "ix_dataset_values_column_id" not in plan, plan

    def test_no_record_list_meets_the_bind_ceiling(self, db_session):
        """The old endpoint bound every row id into one `IN (…)` (#960). With the
        connection's limit lowered below the dataset's size, a bound list fails —
        and the search, which binds none, answers."""
        _seed(db_session, [NOTE], [(i, f"R{i}", {2: "yes"}) for i in range(1, 61)])
        raw = db_session.connection().connection.dbapi_connection
        raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 40)
        try:
            # Discrimination: the lowered limit really refuses a 60-element list.
            with pytest.raises(sqlite3.OperationalError, match="too many SQL variables"):
                raw.execute(f"SELECT 1 WHERE 1 IN ({','.join('?' * 60)})", list(range(60)))
            page = _search(db_session, "yes", limit=50)
            assert (page["total"], len(page["rows"])) == (60, 50)
            assert _search(db_session, limit=50)["total"] == 60
        finally:
            raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 250_000)


def test_the_search_term_and_page_are_bounded_over_http():
    """FastAPI validates the query only over HTTP — a direct call would take any
    value — so the 422s are driven through the real app."""
    from starlette.testclient import TestClient

    from app.database import Base, SessionLocal, engine
    from app.main import app

    Base.metadata.create_all(bind=engine)
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            headers = {"X-CSRF-Token": client.get("/api/auth/status").json()["user"]["csrf_token"]}
            pid = client.post("/api/projects", json={"name": "Bounds"}, headers=headers).json()["id"]
            created = client.post(f"/api/projects/{pid}/datasets", json={"name": "Blank"}, headers=headers)
            assert created.status_code in (200, 201), created.text
            url = f"/api/projects/{pid}/datasets/{created.json()['id']}/linkable-rows"
            assert client.get(url, params={"limit": 0}).status_code == 422
            assert client.get(url, params={"limit": svc.MAX_LINKABLE_PAGE_SIZE + 1}).status_code == 422
            assert client.get(url, params={"offset": -1}).status_code == 422
            assert client.get(url, params={"q": "x" * (svc.MAX_SEARCH_TERM_LENGTH + 1)}).status_code == 422
            ok = client.get(url, params={"q": "é", "limit": svc.MAX_LINKABLE_PAGE_SIZE})
            assert ok.status_code == 200, ok.text
            assert ok.json() == {"rows": [], "total": 0, "limit": 200, "offset": 0, "link_refusal": None}
    finally:
        db = SessionLocal()
        try:
            for t in ("datasets", "audit_entries", "sessions", "projects", "users"):
                db.execute(text(f"DELETE FROM {t}"))
            db.commit()
        finally:
            db.close()
        Base.metadata.drop_all(bind=engine)


def test_the_client_mirrors_the_page_size_and_the_term_limit():
    """`frontend/src/lib/linkable-rows.ts` sends one page and caps the box at the
    server's term limit; a drift would ask for a page the server sizes
    differently, or let a researcher type a term the server refuses (422)."""
    from pathlib import Path

    src = (Path(__file__).resolve().parents[2] / "frontend/src/lib/linkable-rows.ts").read_text()
    assert f"export const RECORD_PAGE_SIZE = {svc.LINKABLE_PAGE_SIZE}\n" in src
    assert f"export const RECORD_SEARCH_MAX_LENGTH = {svc.MAX_SEARCH_TERM_LENGTH}\n" in src
