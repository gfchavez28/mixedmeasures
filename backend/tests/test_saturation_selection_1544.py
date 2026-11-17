"""#1544 — the saturation curve walks what the page selected, the comparison's rule (#1297).

Filed by the 2026-11-06e `/codebase-audit` (F5): with one conversation selected the curve
held every document and clip in the project, because the page sent an unselected kind as
ABSENT and the route folded ``""`` into ``None`` (`parse_int_list`), which
`get_saturation_data` read as every source of the kind. The rest of the page counts
EXACTLY the selection (the comparison, #1297; the co-occurrence, #1527 D84; the Segments
CSV, #1535; the Frequencies and Source Data CSVs, #1528).

The rule, as everywhere else on the page: a list ABSENT is every source of its kind; a list
PRESENT and EMPTY (``?document_ids=``) is none of it (`routers/helpers.py::parse_source_ids`,
`code_analysis._none_of_this_kind`). The client sends it through
`lib/qual-comparison.ts::saturationParams`.

⚠️ Asked over HTTP, so the query string's ``""`` reaches `parse_source_ids` exactly as the
browser sends it — a direct call of the route function passes whatever the test writes.
⚠️ Every selection below is one on which the old and the new reading DISAGREE (#707a); the
absent-lists case is the positive control, where they agree.
"""
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import get_current_user
from app.database import Base, get_db
from app.main import app
from app.models import (
    Code, CodeApplication, Conversation, Document, Observation, Project, Segment, User,
)
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue

PID = 1544
A, B, C, D = 15441, 15442, 15443, 15444
C1, C2 = 15451, 15452
D1, D2 = 15453, 15454
O1 = 15455
T1 = 15456


@pytest.fixture
def http():
    """Created in order C1, D1, C2, D2, O1 (import order is the curve's x-axis, #708).
    C1 {A} · D1 {B, C} · C2 {A, B} · D2 {A} · O1 {C}; one survey answer coded D, which no
    passage carries — so a curve that wrongly counted answers would show D."""
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def _fk(dbapi_conn, _):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    db = Session()
    db.add(User(id=1, username="coder", password_hash="x", is_admin=True))
    db.flush()
    db.add(Project(id=PID, name="1544", user_id=1))
    db.flush()
    db.add_all([
        Code(id=k, project_id=PID, numeric_id=n, name=name, is_universal=False, is_active=True)
        for k, n, name in ((A, 1, "A"), (B, 2, "B"), (C, 3, "C"), (D, 4, "D"))
    ])
    at = lambda day: datetime(2026, 1, day)  # noqa: E731
    db.add_all([
        Conversation(id=C1, project_id=PID, name="C1", created_at=at(1)),
        Document(id=D1, project_id=PID, name="D1", source_filename="d1.txt", source_format="txt",
                 created_at=at(2)),
        Conversation(id=C2, project_id=PID, name="C2", created_at=at(3)),
        Document(id=D2, project_id=PID, name="D2", source_filename="d2.txt", source_format="txt",
                 created_at=at(4)),
        Observation(id=O1, project_id=PID, name="O1", created_at=at(5)),
    ])
    db.flush()
    units = [
        (15461, dict(conversation_id=C1), [A]),
        (15462, dict(document_id=D1), [B, C]),
        (15463, dict(conversation_id=C2), [A, B]),
        (15464, dict(document_id=D2), [A]),
        (15465, dict(observation_id=O1, start_time=1.0, end_time=2.0), [C]),
    ]
    for i, (sid, parent, codes) in enumerate(units):
        db.add(Segment(id=sid, sequence_order=i, text=f"unit {sid}", word_count=2,
                       is_merge_result=False, **parent))
        db.flush()
        for code in codes:
            db.add(CodeApplication(segment_id=sid, code_id=code, user_id=1, origin="human"))
    db.add(Dataset(id=15470, project_id=PID, name="Survey"))
    db.flush()
    db.add(DatasetColumn(id=T1, dataset_id=15470, column_code="Q1", column_name="Q1",
                         column_text="Question 1", column_type=ColumnType.OPEN_TEXT,
                         sequence_order=0, display_order=0))
    db.add(DatasetRow(id=15471, dataset_id=15470))
    db.flush()
    db.add(DatasetValue(id=15472, row_id=15471, column_id=T1, value_text="an answer"))
    db.flush()
    db.add(CodeApplication(dataset_value_id=15472, code_id=D, user_id=1, origin="human"))
    db.commit()
    user = db.get(User, 1)

    def _get_db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_current_user] = lambda: user
    client = TestClient(app, raise_server_exceptions=False)  # no `with`: no lifespan
    client.engine = engine  # for the statement count below
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        client.close()
        db.close()
        engine.dispose()


def _curve(http, query: str = ""):
    r = http.get(f"/api/projects/{PID}/code-analysis/saturation{query}")
    assert r.status_code == 200, r.text
    body = r.json()
    return [p["source_label"] for p in body["points"]], body


def test_one_conversation_selected_is_a_one_source_curve(http):
    # What the page sends for "C1 selected, nothing else": the other kinds PRESENT and empty.
    labels, body = _curve(http, f"?conversation_ids={C1}&document_ids=&observation_ids=")
    assert labels == ["C1"]
    assert body["total_sources"] == 1
    assert body["total_unique_codes"] == 1  # A — never D1's B and C, or O1's C


def test_documents_only_is_the_documents_selected(http):
    labels, body = _curve(http, f"?conversation_ids=&document_ids={D1}&observation_ids=")
    assert labels == ["D1"]
    assert body["total_unique_codes"] == 2


def test_a_mixed_selection_interleaves_only_what_was_selected(http):
    labels, _ = _curve(http, f"?conversation_ids={C2}&document_ids=&observation_ids={O1}")
    assert labels == ["C2", "O1"]


def test_questions_only_is_an_empty_curve_never_the_whole_project(http):
    # A selection of survey questions alone: the curve has no answer arm, so it walks
    # nothing — the old reading walked all five sources.
    labels, body = _curve(http, "?conversation_ids=&document_ids=&observation_ids=")
    assert labels == []
    assert body["total_sources"] == 0
    assert body["total_unique_codes"] == 0


def test_control_absent_lists_are_every_source_in_import_order(http):
    labels, body = _curve(http)
    assert labels == ["C1", "D1", "C2", "D2", "O1"]
    assert [p["cumulative_unique_codes"] for p in body["points"]] == [1, 3, 3, 3, 3]
    assert body["total_unique_codes"] == 3  # D is an answer's code, not a passage's


def test_control_a_kind_left_absent_still_means_every_source_of_it(http):
    # A caller that names only conversations (no other key) keeps the old reading for the
    # other kinds — absent is every source; only a PRESENT empty list means none.
    labels, _ = _curve(http, f"?conversation_ids={C1}")
    assert labels == ["C1", "D1", "D2", "O1"]


def _codings_read(http, query: str) -> set[str]:
    """Which source kinds' CODINGS the request read — the statements joining code
    applications to a parent table."""
    seen: list[str] = []

    def _capture(conn, cursor, statement, *a):
        seen.append(statement)

    event.listen(http.engine, "before_cursor_execute", _capture)
    try:
        _curve(http, query)
    finally:
        event.remove(http.engine, "before_cursor_execute", _capture)
    pairs = [s for s in seen if "code_applications" in s]
    return {kind for kind, table in (("conversation", "JOIN conversations"),
                                     ("document", "JOIN documents"),
                                     ("observation", "JOIN observations"))
            if any(table in s for s in pairs)}


def test_a_kind_sent_as_none_is_not_read(http):
    # Cost, not correctness: the interleave drops an unselected kind either way, so
    # without the skip one selected interview still read every document's and clip's
    # codings to throw them away.
    assert _codings_read(http, f"?conversation_ids={C1}&document_ids=&observation_ids=") \
        == {"conversation"}
    # Control: absent lists read all three kinds (and the capture can see each).
    assert _codings_read(http, "") == {"conversation", "document", "observation"}
