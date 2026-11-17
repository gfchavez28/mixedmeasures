"""#1530 / #1531 / #1532 (1.5.9, D95–D102) — a blind coder's files and lists hold her own coding.

Blind mode is client state (`useBlindMode`), so the server narrows only what a request
asks it to narrow. Before 1.5.9 the Export dialog's files, the Text Coding export, the
Quote Board's read and the analysis page's passage chips took no coder scope, and a
blind coder downloaded — or saw — her colleagues' coding by name, unit and rating
(measured on one scratch install, 2026-11-05; record:
the internal design notes, git-ignored).

Every test asks a door BOTH ways on one fixture: unscoped, the colleague's work is in
it (so the fixture can tell the two apart); scoped to Alice, none of it is, and her own
work still is. The #1608 section at the end adds a second fixture, `scored_project` (the
same project with Ana linked and the participant table built and refreshed). The first
fixture mirrors the review's kit (`drive_setup.py`):

  - coders Alice (2) and Bob (3); the conftest's testuser (1) codes nothing;
  - "Interview 1": an interviewer turn, then Ana's turns T1..T4;
  - a survey with one open-text question, answers R1 and R2, and a numeric column (so
    the R export has a qualifying dataset);
  - codes "Shared theme" (rated on 1–5), "Alice theme", "Bob theme";
  - Alice: T1 Shared theme rated 2, T2 Alice theme, R1 Alice theme;
  - Bob:   T1 Shared theme rated 5 + Bob theme, T3 Bob theme, R1 Bob theme, R2 Bob theme;
  - audit entries for both, and Bob's reveal; quotes on T1, T3 and R2.
"""
import asyncio
import csv
import io
import zipfile
from datetime import datetime, timedelta

import pytest
from openpyxl import load_workbook

from app.models.audit import AuditEntry
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.user import User
from app.services.audit import BLIND_MODE_REVEAL_ACTION
from app.services.coding_layers import in_coder_scope

PID = 1530
ALICE, BOB = 2, 3
SHARED, ALICE_THEME, BOB_THEME = 15350, 15351, 15352
T0, T1, T2, T3, T4 = 15300, 15301, 15302, 15303, 15304
TEXT_COL, NUM_COL = 15310, 15311
R1, R2 = 153101, 153102
SCOPE = str(ALICE)


def _run(coro):
    return asyncio.run(coro)


def _body(response) -> bytes:
    async def drain():
        out = []
        async for chunk in response.body_iterator:
            out.append(chunk if isinstance(chunk, bytes) else chunk.encode("utf-8"))
        return b"".join(out)
    return _run(drain())


def _filename(response) -> str:
    return response.headers["content-disposition"].split('filename="', 1)[1].rstrip('"')


@pytest.fixture
def blind_project(db_session):
    db = db_session
    db.add_all([
        User(id=ALICE, username="Alice", password_hash=None, coder_type="human"),
        User(id=BOB, username="Bob", password_hash=None, coder_type="human"),
        Project(id=PID, name="Blind drive", user_id=1),
    ])
    db.flush()
    db.add(Conversation(id=PID, project_id=PID, name="Interview 1"))
    db.add_all([
        Speaker(id=15300, project_id=PID, name="Interviewer", is_facilitator=1, color_index=0),
        Speaker(id=15301, project_id=PID, name="Ana", is_facilitator=0, color_index=1),
    ])
    db.flush()
    texts = ["Tell me about the service.", "The bus does not reach the clinic.",
             "The nurses were patient.", "I waited three hours for the forms.",
             "It got better after the move."]
    for i, (sid, text) in enumerate(zip((T0, T1, T2, T3, T4), texts)):
        db.add(Segment(id=sid, conversation_id=PID, sequence_order=i, text=text,
                       speaker_id=15300 if sid == T0 else 15301))
    db.add_all([
        Code(id=SHARED, project_id=PID, numeric_id=2, name="Shared theme",
             is_universal=False, is_active=True,
             magnitude_min=1.0, magnitude_max=5.0, magnitude_step=1.0),
        Code(id=ALICE_THEME, project_id=PID, numeric_id=3, name="Alice theme",
             is_universal=False, is_active=True),
        Code(id=BOB_THEME, project_id=PID, numeric_id=4, name="Bob theme",
             is_universal=False, is_active=True),
    ])
    db.add(Dataset(id=PID, project_id=PID, name="Survey"))
    db.flush()
    db.add_all([
        DatasetColumn(id=TEXT_COL, dataset_id=PID, column_code="q1", column_name="q1",
                      column_text="What did you think?", column_type=ColumnType.OPEN_TEXT,
                      sequence_order=0, display_order=0),
        DatasetColumn(id=NUM_COL, dataset_id=PID, column_code="x", column_name="x",
                      column_text="x", column_type=ColumnType.NUMERIC,
                      sequence_order=1, display_order=1),
        DatasetRow(id=15320, dataset_id=PID, row_identifier="R001"),
        DatasetRow(id=15321, dataset_id=PID, row_identifier="R002"),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=R1, row_id=15320, column_id=TEXT_COL, value_text="answer one"),
        DatasetValue(id=R2, row_id=15321, column_id=TEXT_COL, value_text="answer two"),
        DatasetValue(id=153103, row_id=15320, column_id=NUM_COL, value_text="1", value_numeric=1),
        DatasetValue(id=153104, row_id=15321, column_id=NUM_COL, value_text="2", value_numeric=2),
    ])
    db.flush()

    def seg(uid, sid, cid, magnitude=None):
        db.add(CodeApplication(code_id=cid, user_id=uid, segment_id=sid, magnitude=magnitude))

    def ans(uid, vid, cid):
        db.add(CodeApplication(code_id=cid, user_id=uid, dataset_value_id=vid))

    seg(ALICE, T1, SHARED, 2.0); seg(ALICE, T2, ALICE_THEME); ans(ALICE, R1, ALICE_THEME)
    seg(BOB, T1, SHARED, 5.0); seg(BOB, T1, BOB_THEME); seg(BOB, T3, BOB_THEME)
    ans(BOB, R1, BOB_THEME); ans(BOB, R2, BOB_THEME)

    base = datetime(2026, 11, 5, 9, 0, 0)
    for minutes, uid, action, entity_type, entity_id in [
        (1, ALICE, "code_applied", "code_application", T2),
        (2, BOB, "code_applied", "code_application", T3),
        (3, BOB, BLIND_MODE_REVEAL_ACTION, "blind_mode", None),
    ]:
        db.add(AuditEntry(project_id=PID, user_id=uid, action=action,
                          entity_type=entity_type, entity_id=entity_id,
                          timestamp=base + timedelta(minutes=minutes)))
    db.add_all([
        Excerpt(project_id=PID, segment_id=T1),
        Excerpt(project_id=PID, segment_id=T3),
        Excerpt(project_id=PID, dataset_value_id=R2),
    ])
    db.flush()
    return db


def _user(db):
    return db.get(User, 1)


# ── The Study CSV (wide) ────────────────────────────────────────────────────


def _study_csv(db, coder_ids=None):
    from app.routers.export import export_study_csv
    resp = _run(export_study_csv(PID, coder_ids=coder_ids, user=_user(db), db=db))
    rows = list(csv.reader(io.StringIO(_body(resp).decode("utf-8"))))
    header, data = rows[0], rows[1:]
    by_seg = {int(r[header.index("segment_id")]): dict(zip(header, r)) for r in data}
    return header, by_seg, resp


class TestTheStudyCsv:
    def test_a_one_is_the_scopes_own_coding(self, blind_project):
        db = blind_project
        header, unscoped, _ = _study_csv(db)
        _, scoped, _ = _study_csv(db, SCOPE)

        # Unscoped: Bob's two codings are there (the fixture can tell the two apart).
        assert unscoped[T3]["code_4"] == "1" and unscoped[T1]["code_4"] == "1"
        # Scoped to Alice: none of Bob's, all of hers.
        assert scoped[T3]["code_4"] == "0" and scoped[T1]["code_4"] == "0"
        assert scoped[T1]["code_2"] == "1" and scoped[T2]["code_3"] == "1"

    def test_every_segment_keeps_its_row_and_the_header_does_not_move(self, blind_project):
        """The zero rows are the denominator (#650); the scope never drops a case."""
        db = blind_project
        header, unscoped, _ = _study_csv(db)
        scoped_header, scoped, _ = _study_csv(db, SCOPE)
        assert scoped_header == header
        assert set(scoped) == set(unscoped) == {T0, T1, T2, T3, T4}

    def test_an_unattributed_coding_is_outside_any_scope(self, blind_project):
        """D95's stated consequence: the include list leaves out NULL-coder rows, as
        the analysis page's charts do."""
        db = blind_project
        db.add(CodeApplication(code_id=ALICE_THEME, user_id=None, segment_id=T4))
        db.flush()
        _, unscoped, _ = _study_csv(db)
        _, scoped, _ = _study_csv(db, SCOPE)
        assert unscoped[T4]["code_3"] == "1"
        assert scoped[T4]["code_3"] == "0"


# ── The Coded Segments CSV ──────────────────────────────────────────────────


def _coded_segments(db, coder_ids=None):
    from app.routers.export import export_coded_segments_csv
    resp = _run(export_coded_segments_csv(
        project_id=PID, code_ids=None, exclude_facilitator=False,
        conversation_ids=None, participant_ids=None, coder_ids=coder_ids,
        user=_user(db), db=db,
    ))
    text = _body(resp).decode("utf-8")
    return text, list(csv.DictReader(io.StringIO(text))), resp


class TestTheCodedSegmentsCsv:
    def test_rows_and_other_codes_are_the_scopes(self, blind_project):
        db = blind_project
        _, unscoped, _ = _coded_segments(db)
        _, scoped, _ = _coded_segments(db, SCOPE)

        assert {r["Coder"] for r in unscoped} == {"Alice", "Bob"}
        assert "5" in {r["Rating"] for r in unscoped}
        alice_t1 = next(r for r in unscoped if r["Coder"] == "Alice" and r["Code"] == "Shared theme")
        assert alice_t1["Other Codes"] == "Bob theme"   # the leak the review measured

        assert {r["Coder"] for r in scoped} == {"Alice"}
        assert {r["Code"] for r in scoped} == {"Shared theme", "Alice theme"}
        assert "5" not in {r["Rating"] for r in scoped}
        assert all("Bob theme" not in r["Other Codes"] for r in scoped)

    def test_line_one_is_still_the_header_and_the_file_still_imports(self, blind_project):
        """No preamble (D97): the coding import reads line 1 as the header, and this
        file is its input (row 49). Imported back as another coder, the scoped file
        reproduces Alice's layer exactly."""
        from app.services import coding_import as ci

        db = blind_project
        unscoped_text, _, _ = _coded_segments(db)
        text, _, _ = _coded_segments(db, SCOPE)
        assert text.splitlines()[0] == unscoped_text.splitlines()[0]

        plan = ci.build_plan(db, PID, ci.parse_rows(text), target_kind=ci.TARGET_SEGMENTS)
        assert plan.problems == []
        ci.apply_plan(db, PID, plan, {"Alice": ci.CoderDecision("create", new_username="Alice again")})
        again = db.query(User).filter(User.username == "Alice again").one()

        def layer(uid):
            return sorted(
                (a.segment_id, a.code_id, a.magnitude)
                for a in db.query(CodeApplication).filter(
                    CodeApplication.user_id == uid, CodeApplication.segment_id.isnot(None),
                )
            )
        assert layer(again.id) == layer(ALICE)


# ── The Excel workbook ──────────────────────────────────────────────────────


def _workbook(db, coder_ids=None):
    from app.routers.export_excel import export_study_excel
    resp = export_study_excel(project_id=PID, coder_ids=coder_ids, user=_user(db), db=db)
    return load_workbook(io.BytesIO(_body(resp))), resp


def _rows(ws):
    return [[c.value for c in row] for row in ws.iter_rows()]


def _cell(ws, row_label_col: int, row_label, header):
    rows = _rows(ws)
    col = rows[0].index(header)
    return next(r[col] for r in rows[1:] if r[row_label_col] == row_label)


class TestTheWorkbook:
    def test_the_coding_sheets_hold_the_scopes_coding(self, blind_project):
        db = blind_project
        wb_all, _ = _workbook(db)
        wb, _ = _workbook(db, SCOPE)

        coded_all, coded = wb_all["Coded Data"], wb["Coded Data"]
        bob_col, shared_col = "4 - Bob theme", "2 - Shared theme"
        assert _cell(coded_all, 2, T3, bob_col) == "X"
        assert _cell(coded, 2, T3, bob_col) in (None, "")
        assert _cell(coded, 2, T1, shared_col) == "X"

        coders_all = {r[6] for r in _rows(wb_all["Ratings"])[1:]}
        assert coders_all == {"Alice", "Bob"}
        ratings = _rows(wb["Ratings"])[1:]
        assert {r[6] for r in ratings} == {"Alice"} and {r[7] for r in ratings} == {2}

        assert _cell(wb_all["Code-Source Matrix"], 0, "4 - Bob theme", "Interview 1 (conversation)") == 2
        assert _cell(wb["Code-Source Matrix"], 0, "4 - Bob theme", "Interview 1 (conversation)") in (None, "")
        assert _cell(wb["Code-Source Matrix"], 0, "2 - Shared theme", "Interview 1 (conversation)") == 1

        co_all = _rows(wb_all["Code Co-occurrence"])
        co = _rows(wb["Code Co-occurrence"])
        bob_idx = co_all[0].index("4 - Bob theme")
        assert next(r for r in co_all if r[0] == "4 - Bob theme")[bob_idx] == 2
        assert next(r for r in co if r[0] == "4 - Bob theme")[bob_idx] in (None, "")

    def test_the_ratings_sheets_cell_arm_is_scoped_too(self, blind_project):
        """The sheet's SECOND arm reads ratings on survey answers (#868 d) through a
        separate query; the kit rates no answer, so this test adds one each."""
        db = blind_project
        db.add_all([
            CodeApplication(code_id=SHARED, user_id=ALICE, dataset_value_id=R1, magnitude=3.0),
            CodeApplication(code_id=SHARED, user_id=BOB, dataset_value_id=R2, magnitude=4.0),
        ])
        db.flush()
        cell_rows = lambda wb: [r for r in _rows(wb["Ratings"])[1:] if r[0] == "dataset value"]
        assert {(r[6], r[7]) for r in cell_rows(_workbook(db)[0])} == {("Alice", 3), ("Bob", 4)}
        assert {(r[6], r[7]) for r in cell_rows(_workbook(db, SCOPE)[0])} == {("Alice", 3)}

    def test_the_codebook_counts_every_coder_either_way(self, blind_project):
        """#454's line, kept (D95): the Codebook page shows every coder's usage."""
        db = blind_project
        wb_all, _ = _workbook(db)
        wb, _ = _workbook(db, SCOPE)
        assert _rows(wb["Codebook"]) == _rows(wb_all["Codebook"])
        assert _cell(wb["Codebook"], 1, "Bob theme", "Usage Count") == 4

    def test_the_scope_sheet_is_appended_and_moves_nothing(self, blind_project):
        db = blind_project
        wb_all, _ = _workbook(db)
        wb, _ = _workbook(db, SCOPE)
        assert "Scope" not in wb_all.sheetnames
        assert wb.sheetnames == wb_all.sheetnames + ["Scope"]

        rows = _rows(wb["Scope"])
        assert "Alice" in rows[0][0] and "blind mode" in rows[0][0]
        holds = {r[0]: r[1] for r in rows[3:] if r[0]}
        assert set(holds) == set(wb_all.sheetnames)   # every other sheet is stated
        assert holds["Coded Data"] == "Coding by Alice only"
        assert holds["Audit Trail"] == "Entries by Alice only"
        assert holds["Codebook"].startswith("Every coder")
        assert holds["Memos"].startswith("Not coding")


# ── The Audit Trail (#1532, D100) ───────────────────────────────────────────


class TestTheAuditTrail:
    def test_a_coder_column_is_appended_and_names_who(self, blind_project):
        db = blind_project
        wb_all, _ = _workbook(db)
        rows = _rows(wb_all["Audit Trail"])
        assert rows[0] == ["Timestamp", "Action", "Entity Type", "Entity ID", "Details", "Coder"]
        reveal = next(r for r in rows[1:] if r[1] == BLIND_MODE_REVEAL_ACTION)
        assert reveal[5] == "Bob"
        assert {r[5] for r in rows[1:]} == {"Alice", "Bob"}

    def test_under_a_scope_it_is_the_scopes_entries(self, blind_project):
        db = blind_project
        wb, _ = _workbook(db, SCOPE)
        rows = _rows(wb["Audit Trail"])[1:]
        assert [(r[1], r[3], r[5]) for r in rows] == [("code_applied", T2, "Alice")]

    def test_every_reveal_survives_the_cap_and_the_last_row_counts_the_rest(
        self, blind_project, monkeypatch,
    ):
        """The cap dropped the oldest entries silently, reveals with them. Bob's reveal
        is the OLDEST entry here, so only the keep-every-reveal rule lists it."""
        from app.routers import export_excel

        db = blind_project
        newer = datetime(2026, 11, 6, 9, 0, 0)
        for i in range(4):
            db.add(AuditEntry(project_id=PID, user_id=ALICE, action="code_applied",
                              entity_type="code_application", entity_id=T2,
                              timestamp=newer + timedelta(minutes=i)))
        db.query(AuditEntry).filter(AuditEntry.action == BLIND_MODE_REVEAL_ACTION).one() \
            .timestamp = datetime(2026, 1, 1)
        db.flush()

        monkeypatch.setattr(export_excel, "AUDIT_TRAIL_SHEET_LIMIT", 3)
        wb, _ = _workbook(db)
        rows = _rows(wb["Audit Trail"])[1:]
        listed = [r for r in rows if r[1] is not None]
        assert len(listed) == 4                               # 3 newest + the old reveal
        assert listed[-1][1] == BLIND_MODE_REVEAL_ACTION       # newest first, reveal last
        # 7 entries in all, 4 listed: the last row says how many were left out.
        assert rows[-1][0].startswith("3 older entries are not listed")

        monkeypatch.setattr(export_excel, "AUDIT_TRAIL_SHEET_LIMIT", 1000)
        rows = _rows(_workbook(db)[0]["Audit Trail"])[1:]
        assert all(r[1] is not None for r in rows)            # nothing left out, no note

    def test_a_tie_on_the_timestamp_is_cut_by_the_newest_entry(self, blind_project, monkeypatch):
        """The timestamp has SECOND precision, so a burst of codings ties; the cap then
        keeps the newest by `id`, never whichever the plan reads first. Five tied entries,
        written oldest id first, across a cap of two."""
        from app.routers import export_excel

        db = blind_project
        tied = datetime(2026, 11, 7, 9, 0, 0)
        ids = []
        for i in range(5):
            e = AuditEntry(project_id=PID, user_id=ALICE, action="code_applied",
                           entity_type="code_application", entity_id=900 + i, timestamp=tied)
            db.add(e)
            db.flush()
            ids.append(e.entity_id)
        monkeypatch.setattr(export_excel, "AUDIT_TRAIL_SHEET_LIMIT", 2)
        rows = [r for r in _rows(_workbook(db, SCOPE)[0]["Audit Trail"])[1:] if r[1]]
        assert [r[3] for r in rows] == [ids[4], ids[3]]


# ── The R export ────────────────────────────────────────────────────────────


def _r_zip(db, coder_ids=None):
    from app.routers.export_r import export_r_data
    resp = export_r_data(project_id=PID, coder_ids=coder_ids, user=_user(db), db=db)
    zf = zipfile.ZipFile(io.BytesIO(_body(resp)))
    return {n: zf.read(n) for n in zf.namelist()}, resp


def _member(files: dict, suffix: str):
    return next((v for n, v in files.items() if n.endswith(suffix)), None)


class TestTheRExport:
    def test_agreement_is_left_out_for_a_narrower_scope_and_the_script_says_so(self, blind_project):
        db = blind_project
        full, _ = _r_zip(db)
        scoped, _ = _r_zip(db, SCOPE)

        # Unscoped: both agreement files (the fixture can tell the two apart).
        assert _member(full, "_irr.csv") is not None
        assert _member(full, "_irr_magnitude.csv") is not None
        assert "irr_raw <- read_csv(" in _member(full, ".R").decode("utf-8")

        assert {n.rsplit("_", 1)[-1] for n in scoped} == {"data.csv", "setup.R"}
        setup = _member(scoped, ".R").decode("utf-8")
        assert "# ---- Inter-rater reliability: left out ----" in setup
        assert "the coding of Alice" in setup
        assert "irr_raw <- read_csv(" not in setup and "kripp.alpha" not in setup

    def test_the_data_csv_and_the_codebook_comment_are_unchanged(self, blind_project):
        db = blind_project
        full, _ = _r_zip(db)
        scoped, _ = _r_zip(db, SCOPE)
        assert _member(scoped, "_data.csv") == _member(full, "_data.csv")
        uses = [ln for ln in _member(full, ".R").decode("utf-8").splitlines() if "uses)" in ln]
        assert uses, "the fixture's codebook comment carries usage counts"
        assert all(ln in _member(scoped, ".R").decode("utf-8") for ln in uses)

    def test_a_scope_that_holds_every_engaged_coder_keeps_agreement(self, blind_project):
        """'Narrower than the engaged coders', not 'any scope': a lead's explicit
        full list still gets the agreement sections."""
        db = blind_project
        files, _ = _r_zip(db, f"{ALICE},{BOB}")
        assert _member(files, "_irr.csv") is not None
        assert "left out ----" not in _member(files, ".R").decode("utf-8")


# ── The Text Coding export ──────────────────────────────────────────────────


def _text_csv(db, coder_ids=None, coded_only=False):
    from app.routers.text_coding import export_coded_texts
    resp = export_coded_texts(project_id=PID, coded_only=coded_only, column_ids=None,
                              coder_ids=coder_ids, user=_user(db), db=db)
    rows = list(csv.DictReader(io.StringIO(_body(resp).decode("utf-8-sig"))))
    return {r["Record ID"]: r for r in rows}, resp


class TestTheTextCodingExport:
    def test_an_answers_codes_are_the_scopes(self, blind_project):
        db = blind_project
        unscoped, _ = _text_csv(db)
        scoped, _ = _text_csv(db, SCOPE)
        assert set(unscoped["R001"]["Applied Codes"].split("; ")) == {"Alice theme", "Bob theme"}
        assert unscoped["R002"]["Applied Codes"] == "Bob theme"
        assert scoped["R001"]["Applied Codes"] == "Alice theme"
        assert scoped["R002"]["Applied Codes"] == ""

    def test_coded_only_means_coded_by_the_scope(self, blind_project):
        db = blind_project
        assert set(_text_csv(db, coded_only=True)[0]) == {"R001", "R002"}
        assert set(_text_csv(db, SCOPE, coded_only=True)[0]) == {"R001"}


# ── The Cross-analysis CSV (#1531, D97 — build session B) ───────────────────


def _cross_csv(db, coder_ids=None, layer_scope=None):
    from app.routers.text_analysis import export_cross_analysis
    resp = export_cross_analysis(
        project_id=PID, column_ids=str(TEXT_COL), filters_json="[]",
        coder_ids=coder_ids, layer_scope=layer_scope, db=db, user=_user(db),
    )
    return list(csv.reader(io.StringIO(_body(resp).decode("utf-8"))))


def _frequency_counts(rows):
    start = rows.index(["Code", "Count", "%"]) + 1
    end = rows.index([], start)
    return {r[0]: int(r[1]) for r in rows[start:end]}


class TestTheCrossAnalysisCsv:
    """The panel already sent its coder filter's scope (the route took `coder_ids`); the
    file never said whose coding it held. While blind the panel sends the viewer's own
    (D99), so the header says so beside *Filters* (D97's table)."""

    def test_a_scoped_file_says_whose_coding_it_holds_beside_the_filters(self, blind_project):
        db = blind_project
        unscoped = _cross_csv(db)
        scoped = _cross_csv(db, SCOPE)
        assert scoped.index(["Coders", "Alice"]) == scoped.index(["Filters", "None"]) + 1
        assert not any(r[:1] == ["Coders"] for r in unscoped)   # no scope, no line
        # The counts under the line are the scope's: the fixture tells the two apart.
        assert _frequency_counts(unscoped).get("Bob theme") == 2
        assert _frequency_counts(scoped).get("Bob theme", 0) == 0
        assert _frequency_counts(scoped).get("Alice theme") == 1

    def test_the_consensus_layer_says_no_coders(self, blind_project):
        """One synthetic coder: the reads skip `coder_ids` there, so the file must not
        claim a scope it did not apply."""
        assert not any(r[:1] == ["Coders"] for r in _cross_csv(blind_project, SCOPE, "consensus"))


# ── The Quote Board's read (#1531, D99) ─────────────────────────────────────


def _starred(db, coder_ids=None, code_ids=None):
    from app.routers.excerpts import list_quoted_excerpts
    resp = list_quoted_excerpts(
        project_id=PID, source="all", code_ids=code_ids, conversation_ids=None,
        document_ids=None, text_column_ids=None, exclude_facilitator=False,
        participant_ids=None, coder_ids=coder_ids, user=_user(db), db=db,
    )
    return {(e.segment_id or e.dataset_value_id): e for e in resp.excerpts}


class TestTheQuoteBoard:
    def test_a_quotes_codes_are_the_scopes_and_every_quote_stays(self, blind_project):
        db = blind_project
        unscoped = _starred(db)
        scoped = _starred(db, SCOPE)
        assert set(scoped) == set(unscoped) == {T1, T3, R2}   # an excerpt has no author
        assert BOB_THEME in unscoped[T3].applied_code_ids
        assert BOB_THEME in unscoped[T1].applied_code_ids
        assert scoped[T3].applied_code_ids == [] and scoped[T3].applied_codes == []
        assert scoped[T1].applied_code_ids == [SHARED]
        assert scoped[R2].applied_code_ids == []

    def test_the_code_filter_matches_only_the_scopes_applications(self, blind_project):
        """Filtered by a colleague's code, the board would otherwise show which quotes
        the colleague coded with it."""
        db = blind_project
        assert set(_starred(db, code_ids=str(BOB_THEME))) == {T1, T3, R2}
        assert _starred(db, SCOPE, code_ids=str(BOB_THEME)) == {}
        assert set(_starred(db, SCOPE, code_ids=str(SHARED))) == {T1}


# ── The analysis page's passage lists (#1531, D102) ─────────────────────────


def _passages(db, code_id, coder_ids, chips_follow_coder_ids):
    from app.routers.code_analysis import code_segments_with_context
    resp = _run(code_segments_with_context(
        project_id=PID, code_id=code_id, context_size=0, exclude_facilitator=False,
        conversation_ids=None, participant_ids=None, document_ids=None,
        coder_ids=coder_ids, layer_scope=None, limit=200, offset=0,
        chips_follow_coder_ids=chips_follow_coder_ids, user=_user(db), db=db,
    ))
    found = {}

    def walk(o):
        if isinstance(o, dict):
            if "applied_code_ids" in o and "id" in o:
                found[o["id"]] = sorted(o["applied_code_ids"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(resp)
    return found


def _answers(db, code_id, coder_ids, chips_follow_coder_ids):
    from app.routers.code_analysis import code_comments_with_context
    resp = _run(code_comments_with_context(
        project_id=PID, code_id=code_id, participant_ids=None, text_column_ids=None,
        coder_ids=coder_ids, layer_scope=None, limit=200, offset=0,
        chips_follow_coder_ids=chips_follow_coder_ids, user=_user(db), db=db,
    ))
    found = {}

    def walk(o):
        if isinstance(o, dict):
            if "applied_code_ids" in o:
                found[o.get("dataset_value_id", o.get("id"))] = sorted(o["applied_code_ids"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(resp)
    return found


class TestThePassageChips:
    def test_while_blind_a_passages_chips_are_her_own(self, blind_project):
        db = blind_project
        # The coder FILTER keeps the whole unit's codes as context (unchanged).
        assert _passages(db, SHARED, SCOPE, False)[T1] == sorted([SHARED, BOB_THEME])
        # Asked while blind, the chips follow the scope that chose the passage.
        assert _passages(db, SHARED, SCOPE, True)[T1] == [SHARED]

    def test_the_flag_without_a_scope_narrows_nothing(self, blind_project):
        db = blind_project
        assert _passages(db, SHARED, None, True)[T1] == sorted([SHARED, BOB_THEME])

    def test_a_document_passage_and_a_clip_follow_it_too(self, blind_project):
        """The passage list has three segment arms, each with its own chip query; the
        kit has only a conversation, so this test adds a document and a recording."""
        from app.models.document import Document
        from app.models.observation import Observation

        db = blind_project
        db.add_all([
            Document(id=PID, project_id=PID, name="Field notes",
                     source_filename="notes.txt", source_format="txt"),
            Observation(id=PID, project_id=PID, name="Session 1"),
        ])
        db.flush()
        doc_seg, clip = 15305, 15306
        db.add_all([
            Segment(id=doc_seg, document_id=PID, sequence_order=0, text="A paragraph."),
            Segment(id=clip, observation_id=PID, sequence_order=0, text="a clip",
                    start_time=1.0, end_time=4.0),
        ])
        db.flush()
        for sid in (doc_seg, clip):
            db.add_all([
                CodeApplication(code_id=SHARED, user_id=ALICE, segment_id=sid),
                CodeApplication(code_id=BOB_THEME, user_id=BOB, segment_id=sid),
            ])
        db.flush()

        both = sorted([SHARED, BOB_THEME])
        context = _passages(db, SHARED, SCOPE, False)
        blind = _passages(db, SHARED, SCOPE, True)
        assert context[doc_seg] == both and context[clip] == both
        assert blind[doc_seg] == [SHARED] and blind[clip] == [SHARED]

    def test_an_answers_chips_follow_the_same_rule(self, blind_project):
        db = blind_project
        assert _answers(db, ALICE_THEME, SCOPE, False)[R1] == sorted([ALICE_THEME, BOB_THEME])
        assert _answers(db, ALICE_THEME, SCOPE, True)[R1] == [ALICE_THEME]


# ── File names (D97) ────────────────────────────────────────────────────────


class TestTheFileNames:
    def test_each_scoped_server_file_ends_with_the_coder(self, blind_project):
        db = blind_project
        responses = {
            "study csv": (_study_csv(db)[2], _study_csv(db, SCOPE)[2], ".csv"),
            "coded segments": (_coded_segments(db)[2], _coded_segments(db, SCOPE)[2], ".csv"),
            "workbook": (_workbook(db)[1], _workbook(db, SCOPE)[1], ".xlsx"),
            "r export": (_r_zip(db)[1], _r_zip(db, SCOPE)[1], ".zip"),
            "text coding": (_text_csv(db)[1], _text_csv(db, SCOPE)[1], ".csv"),
        }
        for label, (unscoped, scoped, ext) in responses.items():
            assert "_coder-" not in _filename(unscoped), label
            assert _filename(scoped).endswith(f"_coder-Alice{ext}"), (label, _filename(scoped))

    def test_a_name_with_nothing_ascii_left_is_the_coders_id(self, blind_project):
        from app.routers.helpers import coder_scope_filename_suffix
        db = blind_project
        db.get(User, ALICE).username = "Алиса"
        db.get(User, BOB).username = "Bob Smith/2"
        db.flush()
        assert coder_scope_filename_suffix(db, [ALICE]) == f"_coder-{ALICE}"
        assert coder_scope_filename_suffix(db, [BOB]) == "_coder-Bob_Smith_2"
        assert coder_scope_filename_suffix(db, None) == ""
        assert coder_scope_filename_suffix(db, [ALICE, BOB]).count("_coder-") == 1


# ── The shared seam ─────────────────────────────────────────────────────────


def test_the_python_twin_reads_a_scope_as_sql_does():
    assert in_coder_scope(ALICE, None) and in_coder_scope(None, None)
    assert in_coder_scope(ALICE, []) and in_coder_scope(None, [])
    assert in_coder_scope(ALICE, [ALICE])
    assert not in_coder_scope(BOB, [ALICE])
    assert not in_coder_scope(None, [ALICE])   # SQL's IN leaves a NULL out


# ── #1608 — participant scores: the doors whose VALUES come from ratings ─────
#
# D95 classed the datasets workbook "not a coding view" on a fixture with no score
# columns. The participant table's rating columns roll up every coder's ratings, so
# while blind they are withheld wherever a blind coder reads that table. Here Ana's
# T1 carries Alice's 2 and Bob's 5: the shared snapshot reads 3.5 (Bob's rating is
# read off it exactly: 2 × 3.5 − 2 = 5), Alice's own live score 2.0.


@pytest.fixture
def scored_project(blind_project):
    from app.models.participant import Participant
    from app.services import participant_scores as ps
    from app.services.participant_dataset import create_participant_dataset, get_participant_dataset

    db = blind_project
    ana = Participant(project_id=PID, identifier="Ana")
    db.add(ana)
    db.flush()
    db.get(Speaker, 15301).participant_id = ana.id
    db.flush()
    create_participant_dataset(db, PID)
    ps.refresh_participant_dataset(db, PID)
    dataset = get_participant_dataset(db, PID)
    rating_cols = {
        (ps.parse_managed_spec(c.managed_spec) or {}).get("kind"): c
        for c in db.query(DatasetColumn).filter(DatasetColumn.dataset_id == dataset.id)
        if ps.parse_managed_spec(c.managed_spec)
    }
    return {"db": db, "dataset": dataset, "ana": ana, "cols": rating_cols}


def _grid(db, dataset_id, coder_ids=None):
    from app.routers.dataset import get_dataset_data
    return _run(get_dataset_data(PID, dataset_id, limit=200, offset=0,
                                 user=_user(db), db=db, coder_ids=coder_ids))


def _rating_headers(names):
    return sorted(n for n in names if n and ("(score)" in n or "(rated passages)" in n))


class TestTheLiveRollupTakesAScope:
    def test_a_self_scope_is_her_own_rating(self, scored_project):
        from app.services.magnitude_rollup import compute_magnitude_rollup
        db, ana = scored_project["db"], scored_project["ana"]

        def mean(coder_ids):
            (score,) = [s for s in compute_magnitude_rollup(db, PID, coder_ids=coder_ids).scores
                        if s.participant_id == ana.id and s.code_id == SHARED]
            return score.mean, score.min_raters_per_target

        assert mean(None) == (3.5, 2)                 # the team's: the shared snapshot's basis
        assert mean([ALICE]) == (2.0, 1)              # hers alone — the sole-voter arm
        assert mean([BOB]) == (5.0, 1)
        assert mean([ALICE, BOB]) == (3.5, 2)         # a scope of every voter changes nothing

    def test_the_voter_count_is_taken_under_the_same_scope(self, scored_project):
        """The ≥N-voter filter counts voters INSIDE the scope, as the ballots do: with
        Alice alone, T1 has one voter, so a two-voter gather finds nothing."""
        from app.services.consensus import SEGMENT_SCOPE_PROJECT, gather_target_votes
        db = scored_project["db"]

        def targets(coder_ids):
            votes = gather_target_votes(db, PID, segment_scope=SEGMENT_SCOPE_PROJECT,
                                        min_voters=2, group_units=False, coder_ids=coder_ids)
            return sorted(b.target_id for b in votes.ballots())

        assert targets(None) == [T1, R1]
        assert targets([ALICE]) == []
        assert targets([ALICE, BOB]) == [T1, R1]

    def test_the_writer_and_the_refresh_ask_for_every_coder(self):
        """The two callers that must NOT follow a viewer say so in their source — a
        scope there would write one viewer's judgement into a layer everyone reads."""
        import inspect
        from app.services import consensus, participant_scores
        assert "coder_ids=None," in inspect.getsource(consensus.materialize_consensus_for_project)
        assert "compute_magnitude_rollup(db, project_id, coder_ids=None)" in inspect.getsource(
            participant_scores._refresh_in_turn)


class TestTheParticipantTableWhileBlind:
    def test_the_data_view_leaves_the_rating_columns_out_and_counts_them(self, scored_project):
        db, ds = scored_project["db"], scored_project["dataset"]
        full = _grid(db, ds.id)
        score_col = scored_project["cols"]["magnitude_score"]
        assert _rating_headers(c.column_text for c in full.columns) == [
            "Shared theme (rated passages)", "Shared theme (score)"]
        cells = [r.values.get(str(score_col.id)) for r in full.rows]
        assert [c.value_numeric for c in cells if c] == [3.5]   # the leak, unscoped
        assert full.withheld_rating_columns == 0

        scoped = _grid(db, ds.id, SCOPE)
        assert _rating_headers(c.column_text for c in scoped.columns) == []
        assert all(str(c.id) not in r.values for r in scoped.rows
                   for c in scored_project["cols"].values())
        assert scoped.withheld_rating_columns == 2
        # Everything else is unchanged: the identifier column and its cells.
        kept = {c.id for c in scoped.columns}
        assert kept == {c.id for c in full.columns} - {c.id for c in scored_project["cols"].values()}
        assert scoped.dataset.column_count == full.dataset.column_count - 2

    def test_a_scope_holding_every_rater_keeps_them(self, scored_project):
        """'Narrower than the raters', as the R export's agreement files (#1530 D98) —
        a lead's explicit full list still sees the scores."""
        db, ds = scored_project["db"], scored_project["dataset"]
        assert _grid(db, ds.id, f"{ALICE},{BOB}").withheld_rating_columns == 0

    def test_an_archived_colleagues_ratings_still_withhold(self, scored_project):
        """Fail closed (the #1541 class): the snapshot was refreshed while Bob was
        active and still holds his 5, though the rollup would leave him out now."""
        db, ds = scored_project["db"], scored_project["dataset"]
        db.get(User, BOB).archived = True
        db.flush()
        assert _grid(db, ds.id, SCOPE).withheld_rating_columns == 2

    def test_a_column_computed_from_a_score_is_withheld_with_it(self, scored_project):
        import json as _json
        db, ds = scored_project["db"], scored_project["dataset"]
        score_col = scored_project["cols"]["magnitude_score"]
        db.add(DatasetColumn(dataset_id=ds.id, column_code="band", column_name="band",
                             column_text="Score band", column_type=ColumnType.NUMERIC,
                             source="computed", expression="x", sequence_order=90,
                             depends_on_column_ids=_json.dumps([score_col.id])))
        db.flush()
        scoped = _grid(db, ds.id, SCOPE)
        assert "Score band" not in [c.column_text for c in scoped.columns]
        assert scoped.withheld_rating_columns == 3
        assert "Score band" in [c.column_text for c in _grid(db, ds.id).columns]

    def test_another_dataset_is_never_touched(self, scored_project):
        db = scored_project["db"]
        assert _grid(db, PID, SCOPE).withheld_rating_columns == 0
        assert [c.column_text for c in _grid(db, PID, SCOPE).columns] == [
            c.column_text for c in _grid(db, PID).columns]

    def test_the_participant_profile_leaves_them_out(self, scored_project):
        from app.routers.participants import get_participant
        db, ana = scored_project["db"], scored_project["ana"]

        def shown(coder_ids=None):
            detail = _run(get_participant(PID, ana.id, user=_user(db), db=db, coder_ids=coder_ids))
            return {d.column_text: d.value for d in detail.linked_demographics}

        assert shown()["Shared theme (score)"] == "3.500"   # the leak, unscoped
        assert _rating_headers(shown(SCOPE)) == []

    def test_the_datasets_workbook_leaves_them_out_and_says_so(self, scored_project):
        from app.routers.export_excel import export_datasets_excel
        from app.services.participant_scores import RATING_COLUMNS_WITHHELD_NOTE
        db, ds = scored_project["db"], scored_project["dataset"]

        def book(coder_ids=None):
            resp = export_datasets_excel(PID, user=_user(db), db=db, coder_ids=coder_ids)
            return load_workbook(io.BytesIO(_body(resp)), read_only=False), _filename(resp)

        full, full_name = book()
        sheet = full[ds.name]
        full_headers = [c.value for c in next(sheet.iter_rows(max_row=1))]
        assert len(_rating_headers(full_headers)) == 0  # headers are column CODES …
        full_dict = [r[2] for r in full["Data Dictionary"].iter_rows(min_row=2, values_only=True)]
        assert _rating_headers(full_dict) == ["Shared theme (rated passages)", "Shared theme (score)"]
        assert "_coder-" not in full_name

        scoped, scoped_name = book(SCOPE)
        scoped_dict = list(scoped["Data Dictionary"].iter_rows(min_row=2, values_only=True))
        assert _rating_headers(r[2] for r in scoped_dict) == []
        assert scoped_dict[-1][0].startswith(RATING_COLUMNS_WITHHELD_NOTE)
        assert scoped_dict[-1][0].endswith("This file holds Alice's view.")
        assert len(next(scoped[ds.name].iter_rows(max_row=1))) == len(full_headers) - 2
        assert scoped_name.endswith("_coder-Alice.xlsx")
        # Another dataset's sheet is data, not coding: identical.
        assert [tuple(r) for r in scoped["Survey"].iter_rows(values_only=True)] == [
            tuple(r) for r in full["Survey"].iter_rows(values_only=True)]

    def test_the_r_data_leaves_them_out_and_the_script_says_so(self, scored_project):
        db = scored_project["db"]
        full, _ = _r_zip(db)
        scoped, _ = _r_zip(db, SCOPE)
        full_header = _member(full, "_data.csv").decode("utf-8-sig").splitlines()[0]
        scoped_header = _member(scoped, "_data.csv").decode("utf-8-sig").splitlines()[0]
        assert full_header.count("Shared") == 2 or full_header.count("shared") == 2, full_header
        assert "hared" not in scoped_header
        setup = _member(scoped, ".R").decode("utf-8")
        assert "# 2 participant-table rating column(s) left out." in setup
        assert "left out." not in _member(full, ".R").decode("utf-8").split("# ---- Helpers")[0]
