"""#1535 (1.5.9, D111–D115) — the analysis page's *Exports › Segments CSV* holds the passages on screen.

The page handed the route the `filterParams` it builds for `/frequencies` (#749: "nothing of a
kind selected = every source of it"), and the route had no document or clip parameter, so the
file agreed with the screen in 3 of 11 selections: one selected document or clip exported every
coded passage in the project, an interview beside a document dropped the document, the code
selection and the *Text* source were ignored, and a participant filter dropped every document
passage and clip (record: the internal design notes,
git-ignored).

**One table for both suites:** `frontend/src/lib/coded-segments-file.cases.json`. The client's
`lib/coded-segments-file.test.ts` holds `codedSegmentsFileRequest` (the file's query) and
`codeFrequenciesFileRequest` (the summary table's read, #1528 D87) EQUAL to it; this file sends
both over HTTP — FastAPI's query parsing is part of what is tested (an undeclared name is dropped
without a word, #1534) — and requires the file's distinct (code, *Unit ID*) pairs per source kind
to EQUAL the table's counts. Two coders, so a file at the application grain cannot pass by
coincidence: four passages carry a second coder's row.

Fixture (the review kit's, plus coder Bea, 9002):
  C1 (101): s1 Pat(P1) A+B, Bea A · s2 Interviewer A · s3 Pat Unclear · s4 Pat Bea-only B
  C2 (102): s5 Sam(P2) A
  D1 (201, linked to P2): d1 A+B, Bea A · d2 B          D2 (202, no participant): d3 A, Bea B
  O1 (301): k1 A+B, Bea B · k2 Unclear
  Survey: T1 (401) R1=P1 A+B, R2=P2 A · T2 (402) R1 B
"""
import csv
import io
import json
from collections import Counter
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from app.database import Base, SessionLocal, engine
from app.main import app
from app.models import (
    Code, CodeApplication, Conversation, Document, Observation, Participant, Segment, Speaker,
)
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.user import User
from app.services import coding_import as ci

CASES_PATH = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "coded-segments-file.cases.json"
CASES = json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]
BY_NAME = {c["name"]: c for c in CASES}

C1, C2, D1, D2, O1, T1, T2, P1, P2 = 101, 102, 201, 202, 301, 401, 402, 501, 502
A, B, UNC = 601, 602, 603
BEA = 9002
PASSAGE_KINDS = ("conversation", "document", "observation")


@pytest.fixture(scope="module")
def site():
    """The fixture project behind a real TestClient: (client, project id, csrf token, viewer)."""
    Base.metadata.create_all(bind=engine)
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            status = client.get("/api/auth/status").json()
            csrf, viewer = status["user"]["csrf_token"], status["user"]
            pid = client.post("/api/projects", json={"name": "Selection 1535"},
                              headers={"X-CSRF-Token": csrf}).json()["id"]
            _seed(pid, viewer["id"])
            yield client, pid, csrf, viewer
    finally:
        Base.metadata.drop_all(bind=engine)


def _seed(pid: int, uid: int) -> None:
    db = SessionLocal()
    db.add(User(id=BEA, username="Bea", password_hash=None))
    db.add_all([
        Code(id=UNC, project_id=pid, numeric_id=1, name="Unclear", is_universal=True, is_active=True),
        Code(id=A, project_id=pid, numeric_id=100, name="A", is_universal=False, is_active=True),
        Code(id=B, project_id=pid, numeric_id=101, name="B", is_universal=False, is_active=True),
        Participant(id=P1, project_id=pid, identifier="P-01"),
        Participant(id=P2, project_id=pid, identifier="P-02"),
    ])
    db.flush()
    db.add_all([
        Speaker(id=1, project_id=pid, name="Pat", is_facilitator=0, participant_id=P1),
        Speaker(id=2, project_id=pid, name="Sam", is_facilitator=0, participant_id=P2),
        Speaker(id=3, project_id=pid, name="Interviewer", is_facilitator=1),
        Conversation(id=C1, project_id=pid, name="C1"),
        Conversation(id=C2, project_id=pid, name="C2"),
        Document(id=D1, project_id=pid, name="D1", source_filename="d1.txt", source_format="txt",
                 participant_id=P2),
        Document(id=D2, project_id=pid, name="D2", source_filename="d2.txt", source_format="txt"),
        Observation(id=O1, project_id=pid, name="O1"),
    ])
    db.flush()
    segs = [  # (id, parent, codes by the viewer, codes by Bea)
        (1001, dict(conversation_id=C1, speaker_id=1), [A, B], [A]),
        (1002, dict(conversation_id=C1, speaker_id=3), [A], []),
        (1003, dict(conversation_id=C1, speaker_id=1), [UNC], []),
        (1004, dict(conversation_id=C1, speaker_id=1), [], [B]),
        (1005, dict(conversation_id=C2, speaker_id=2), [A], []),
        (2001, dict(document_id=D1), [A, B], [A]),
        (2002, dict(document_id=D1), [B], []),
        (2003, dict(document_id=D2), [A], [B]),
        (3001, dict(observation_id=O1, start_time=1.0, end_time=2.0), [A, B], [B]),
        (3002, dict(observation_id=O1, start_time=3.0, end_time=4.0), [UNC], []),
    ]
    for i, (sid, parent, mine, beas) in enumerate(segs):
        db.add(Segment(id=sid, sequence_order=i, text=f"unit {sid}", word_count=2,
                       is_merge_result=False, **parent))
        db.flush()
        for coder, codes in ((uid, mine), (BEA, beas)):
            for c in codes:
                db.add(CodeApplication(segment_id=sid, code_id=c, user_id=coder, origin="human"))
    db.add(Dataset(id=4000, project_id=pid, name="Survey"))
    db.flush()
    for col_id, i in ((T1, 0), (T2, 1)):
        db.add(DatasetColumn(id=col_id, dataset_id=4000, column_code=f"Q{i}", column_name=f"Q{i}",
                             column_text=f"Question {i}", column_type=ColumnType.OPEN_TEXT,
                             sequence_order=i, display_order=i))
    db.flush()
    for rid, part in ((4101, P1), (4102, P2), (4103, None)):
        db.add(DatasetRow(id=rid, dataset_id=4000, participant_id=part))
    db.flush()
    for vid, rid, col, text, codes in [
        (4201, 4101, T1, "a real answer", [A, B]),
        (4202, 4102, T1, "another answer", [A]),
        (4203, 4101, T2, "second question", [B]),
    ]:
        db.add(DatasetValue(id=vid, row_id=rid, column_id=col, value_text=text))
        db.flush()
        for c in codes:
            db.add(CodeApplication(dataset_value_id=vid, code_id=c, user_id=uid, origin="human"))
    db.commit()
    db.close()


def _download(client, pid, query: dict):
    r = client.get(f"/api/projects/{pid}/export/coded-segments", params=query)
    assert r.status_code == 200, r.text[:300]
    return r, list(csv.DictReader(io.StringIO(r.text.lstrip("﻿"))))


def _file_units(rows) -> Counter:
    """Distinct (code, unit) pairs per (code, kind) — the file's rows are APPLICATIONS."""
    pairs = {(row["Code"], row["Source Type"], row["Unit ID"]) for row in rows}
    return Counter((code, kind) for code, kind, _unit in pairs)


def _screen_units(client, pid, csrf, body) -> Counter:
    """The Descriptives summary table's own read, per (code, kind), passage kinds only."""
    r = client.post(f"/api/projects/{pid}/code-analysis/source-frequencies", json=body,
                    headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200, r.text[:300]
    sf = r.json()
    names = {str(c["id"]): c["name"] for c in sf["codes"]}
    out: Counter = Counter()
    for s in sf["sources"]:
        if s["source_type"] not in PASSAGE_KINDS:
            continue
        for cid, entry in (s.get("code_counts") or {}).items():
            if entry["count"]:
                out[(names[cid], s["source_type"])] += entry["count"]
    return out


# ── 1. The file is the screen, selection by selection ─────────────────────────

FILE_CASES = [c for c in CASES if c["file"] is not None]


@pytest.mark.parametrize("case", FILE_CASES, ids=[c["name"] for c in FILE_CASES])
def test_the_file_holds_the_passages_the_screen_counts(site, case):
    client, pid, csrf, _viewer = site
    _response, rows = _download(client, pid, case["file"]["query"])
    screen = _screen_units(client, pid, csrf, case["screen"])
    assert screen, "the screen counts nothing here — the case cannot tell a right file from an empty one"
    assert _file_units(rows) == screen


def test_the_application_grain_is_not_the_unit_grain_here(site):
    """Discrimination: with Bea's rows the file has MORE rows than units, so a test comparing row
    counts with the screen would fail — the comparison above is over distinct units on purpose,
    and the fixture makes the two differ."""
    client, pid, _csrf, _viewer = site
    _response, rows = _download(client, pid, BY_NAME["nothing_selected_all"]["file"]["query"])
    assert len(rows) > sum(_file_units(rows).values())


@pytest.mark.parametrize("name", ["nothing_selected_text", "t1_only_text_mode"])
def test_a_selection_with_no_passage_counts_no_passage_on_screen(site, name):
    """D114's premise, measured: where the client sends nothing (the door is disabled with
    *"The selection holds none"*), the screen indeed counts no interview, document or clip."""
    client, pid, csrf, _viewer = site
    assert BY_NAME[name]["file"] is None
    assert _screen_units(client, pid, csrf, BY_NAME[name]["screen"]) == Counter()


# ── 2. Each decision, stated on the rows ───────────────────────────────────────

def _sources(rows) -> set[str]:
    return {row["Source"] for row in rows}


def test_D111_one_document_is_that_document(site):
    client, pid, _csrf, _viewer = site
    _r, rows = _download(client, pid, BY_NAME["d1_only"]["file"]["query"])
    assert _sources(rows) == {"D1"}


def test_D111_one_clip_is_that_clip(site):
    client, pid, _csrf, _viewer = site
    _r, rows = _download(client, pid, BY_NAME["o1_only"]["file"]["query"])
    assert _sources(rows) == {"O1"}


def test_D111_an_interview_beside_a_document_keeps_both(site):
    client, pid, _csrf, _viewer = site
    _r, rows = _download(client, pid, BY_NAME["c1_and_d1"]["file"]["query"])
    assert _sources(rows) == {"C1", "D1"}


def test_D111_an_absent_kind_is_every_source_of_it(site):
    """`conversation_ids` alone no longer means "turns only": an absent document or clip list
    is every source of that kind (`parse_source_ids`), a present empty one none."""
    client, pid, _csrf, _viewer = site
    _r, rows = _download(client, pid, {"conversation_ids": str(C1)})
    assert _sources(rows) == {"C1", "D1", "D2", "O1"}
    _r, rows = _download(client, pid, {"conversation_ids": str(C1), "document_ids": "", "observation_ids": ""})
    assert _sources(rows) == {"C1"}
    _r, rows = _download(client, pid, {"conversation_ids": "", "document_ids": "", "observation_ids": ""})
    assert rows == []


def test_D112_the_selected_code_only(site):
    client, pid, _csrf, _viewer = site
    _r, rows = _download(client, pid, BY_NAME["c1_code_a_only"]["file"]["query"])
    assert {row["Code"] for row in rows} == {"A"}


def test_D113_the_file_reads_the_participant_filter_as_the_screens_do(site):
    """D113 makes the file follow the screens; since #1536 (D116/D117, 1.5.9) the screens keep a
    turn by its speaker, a document passage by the participant its document is linked to, and no
    clip — so P2's file holds C2's turn and D1 (linked to P2), never D2 (linked to no one) or O1.
    Before #1536 it held D2 and O1 as the screens did; before #1535, C2's one turn alone."""
    client, pid, _csrf, _viewer = site
    _r, rows = _download(client, pid, BY_NAME["everything_participant_p2"]["file"]["query"])
    assert _sources(rows) == {"C2", "D1"}
    turns = {row["Speaker"] for row in rows if row["Source Type"] == "conversation"}
    assert turns == {"Sam"}


def test_the_coder_scope_still_narrows_a_selection(site):
    """#1530 D98 beside D111: Bea's rows only, on the two sources selected."""
    client, pid, _csrf, _viewer = site
    _r, rows = _download(client, pid, BY_NAME["c1_and_d1_second_coder_only"]["file"]["query"])
    assert {row["Coder"] for row in rows} == {"Bea"}
    assert _sources(rows) == {"C1", "D1"}


# ── 3. The name (D115) and the Export dialog's file ────────────────────────────

def _filename(response) -> str:
    return response.headers["content-disposition"].split('filename="')[1].rstrip('"')


@pytest.mark.parametrize("case", FILE_CASES, ids=[c["name"] for c in FILE_CASES])
def test_D115_every_page_file_says_it_is_a_selection(site, case):
    """The page always sends `exclude_facilitator`, so every page file is named a selection
    whenever it is `true` or anything else narrows — and the name sits before `_coder-`."""
    client, pid, _csrf, _viewer = site
    response, _rows = _download(client, pid, case["file"]["query"])
    name = _filename(response)
    narrows = (case["file"]["query"].get("exclude_facilitator") == "true"
               or any(k in case["file"]["query"] for k in
                      ("conversation_ids", "document_ids", "observation_ids", "code_ids", "participant_ids")))
    assert ("_selection" in name) is narrows, name
    if "coder_ids" in case["file"]["query"]:
        assert name.endswith("_selection_coder-Bea.csv"), name


def test_D115_each_parameter_alone_names_a_selection(site):
    client, pid, _csrf, _viewer = site
    for query in ({"document_ids": str(D1)}, {"code_ids": str(A)}, {"participant_ids": str(P1)},
                  {"exclude_facilitator": "true"}, {"conversation_ids": ""}):
        response, _rows = _download(client, pid, query)
        assert "_selection" in _filename(response), query
    response, _rows = _download(client, pid, {"exclude_facilitator": "false"})
    assert "_selection" not in _filename(response)


def test_the_export_dialogs_file_is_every_passage_and_named_as_before(site):
    """The Export dialog sends no list (`ExportDialog.tsx`): every coded passage, interviewer
    turns included (#1075), every coder's row, and no `_selection` — a blind viewer's scope
    alone names the coder only."""
    client, pid, _csrf, _viewer = site
    response, rows = _download(client, pid, {})
    assert len(rows) == 17                # 12 applications by the viewer + 5 of Bea's
    assert _sources(rows) == {"C1", "C2", "D1", "D2", "O1"}
    assert any(row["Is Facilitator"] == "Yes" for row in rows)
    assert "_selection" not in _filename(response)
    response, _rows = _download(client, pid, {"coder_ids": str(BEA)})
    assert _filename(response).endswith("_coder-Bea.csv")
    assert "_selection" not in _filename(response)


# ── 4. A page file is still the coding import's input ──────────────────────────

def test_a_page_file_imports_back_exactly(site):
    """`coding-import.md` §2: this file is the segments arm's input. One selected document's
    file, imported back as two new coders, reproduces both coders' rows on that document —
    `TestTheExportIsAnImport`'s shape, through the page's own query."""
    client, pid, _csrf, viewer = site
    _r, rows = _download(client, pid, BY_NAME["d1_only"]["file"]["query"])
    body = _r.text.lstrip("﻿")
    db = SessionLocal()
    try:
        plan = ci.build_plan(db, pid, ci.parse_rows(body), target_kind=ci.TARGET_SEGMENTS)
        assert plan.problems == []
        ci.apply_plan(db, pid, plan, {
            viewer["username"]: ci.CoderDecision("create", new_username="Viewer again"),
            "Bea": ci.CoderDecision("create", new_username="Bea again"),
        })

        def rows_of(username):
            uid = db.query(User.id).filter(User.username == username).scalar()
            return sorted(db.query(CodeApplication.segment_id, CodeApplication.code_id)
                          .filter(CodeApplication.user_id == uid,
                                  CodeApplication.segment_id.in_([2001, 2002])).all())

        assert rows_of("Viewer again") == rows_of(viewer["username"])
        assert rows_of("Bea again") == rows_of("Bea")
        assert len(rows_of("Viewer again")) + len(rows_of("Bea again")) == len(rows)
    finally:
        db.rollback()
        db.close()
