"""#1592 — the analysis page's passage lists and the Quote Board say WHO applied each code.

With colleagues shown, every chip on *By Code* and on the Quote Board carried a *Remove code*
button; the remove door deletes only the CALLER's application (`routers/coding.py::remove_code`,
`DELETE /text-coding/code` since #879), so on a colleague's chip it removed nothing and said
nothing (driven, name-sweep run 16). These lists carried bare `applied_code_ids`, so the client
could not tell the viewer's chip from a colleague's. Each unit now carries
`applied_code_details` — `(code_id, user_id)` per application — and the client offers the
remove only where the viewer holds the code (`lib/coding-progress.ts::viewerMayRemoveChip`).

What this file holds the server to, over HTTP (so `response_model` validation runs — a builder
that dropped the field fails it, the splat trap):
  1. the details are the SAME applications as the chips (every arm: turn, document passage,
     clip, answer, and both Quote Board arms);
  2. they follow the chips' scope — while blind (`chips_follow_coder_ids`, #1531 D102; the
     board's `coder_ids`, D99) a colleague's id never reaches the wire;
  3. they follow the LAYER — under Consensus the coder is the consensus system user and under
     Machine the model, never the viewer, so no remove is offered over a coding the viewer's
     own remove would not touch.

Fixture (the #1530 blind kit's shape): coders Alice (2) and Bob (3); the conftest-style user 1
is the session. T1: Alice and Bob both "Shared"; T2: Bob only "Bob theme". A document passage
P1 and a clip K1 with the same split. Answer R1: Alice "Shared", Bob "Bob theme". Quotes on T1,
T2 and R1. A consensus row and a machine coder's row on T1.
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import get_current_user, get_or_create_consensus_user
from app.database import Base, get_db
from app.main import app
from app.models import (
    Code, CodeApplication, Conversation, Document, Observation, Project, Segment, User,
)
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.speaker import Speaker

PID = 1592
ALICE, BOB, MODEL = 2, 3, 4
SHARED, BOB_THEME = 15921, 15922
T1, T2, P1, P2, K1, K2 = 15931, 15932, 15933, 15934, 15935, 15936
R1 = 15941
TEXT_COL = 15942


@pytest.fixture
def http():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def _fk(dbapi_conn, _):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    db = Session()
    db.add_all([
        User(id=1, username="coder", password_hash="x", is_admin=True),
        User(id=ALICE, username="Alice", password_hash=None, coder_type="human"),
        User(id=BOB, username="Bob", password_hash=None, coder_type="human"),
        User(id=MODEL, username="Model", password_hash=None, coder_type="ai"),
    ])
    db.flush()
    db.add(Project(id=PID, name="1592", user_id=1))
    db.flush()
    db.add_all([
        Code(id=SHARED, project_id=PID, numeric_id=1, name="Shared", is_universal=False, is_active=True),
        Code(id=BOB_THEME, project_id=PID, numeric_id=2, name="Bob theme", is_universal=False, is_active=True),
        Conversation(id=PID, project_id=PID, name="Interview 1"),
        Document(id=PID, project_id=PID, name="Notes", source_filename="n.txt", source_format="txt"),
        Observation(id=PID, project_id=PID, name="Session 1"),
        Speaker(id=PID, project_id=PID, name="Ana", is_facilitator=0, color_index=1),
    ])
    db.flush()
    db.add_all([
        Segment(id=T1, conversation_id=PID, sequence_order=0, text="turn one", speaker_id=PID),
        Segment(id=T2, conversation_id=PID, sequence_order=1, text="turn two", speaker_id=PID),
        Segment(id=P1, document_id=PID, sequence_order=0, text="para one"),
        Segment(id=P2, document_id=PID, sequence_order=1, text="para two"),
        Segment(id=K1, observation_id=PID, sequence_order=0, text="clip one", start_time=1.0, end_time=2.0),
        Segment(id=K2, observation_id=PID, sequence_order=1, text="clip two", start_time=3.0, end_time=4.0),
    ])
    db.add(Dataset(id=PID, project_id=PID, name="Survey"))
    db.flush()
    db.add_all([
        DatasetColumn(id=TEXT_COL, dataset_id=PID, column_code="q1", column_name="q1",
                      column_text="What did you think?", column_type=ColumnType.OPEN_TEXT,
                      sequence_order=0, display_order=0),
        DatasetRow(id=15943, dataset_id=PID, row_identifier="R001"),
    ])
    db.flush()
    db.add(DatasetValue(id=R1, row_id=15943, column_id=TEXT_COL, value_text="an answer"))
    db.flush()
    # The split on every arm: the first unit both coders hold "Shared" (Bob also "Bob theme"
    # on the answer); the second unit is Bob's "Bob theme" alone.
    for first, second in ((T1, T2), (P1, P2), (K1, K2)):
        db.add_all([
            CodeApplication(segment_id=first, code_id=SHARED, user_id=ALICE),
            CodeApplication(segment_id=first, code_id=SHARED, user_id=BOB),
            CodeApplication(segment_id=second, code_id=BOB_THEME, user_id=BOB),
        ])
    db.add_all([
        CodeApplication(dataset_value_id=R1, code_id=SHARED, user_id=ALICE),
        CodeApplication(dataset_value_id=R1, code_id=BOB_THEME, user_id=BOB),
    ])
    consensus = get_or_create_consensus_user(db)
    db.add_all([
        CodeApplication(segment_id=T1, code_id=SHARED, user_id=consensus.id, origin="consensus"),
        CodeApplication(segment_id=T1, code_id=BOB_THEME, user_id=MODEL),
    ])
    db.add_all([
        Excerpt(project_id=PID, segment_id=T1),
        Excerpt(project_id=PID, segment_id=T2),
        Excerpt(project_id=PID, dataset_value_id=R1),
    ])
    db.commit()
    user = db.get(User, 1)
    consensus_id = consensus.id

    def _get_db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[get_current_user] = lambda: user
    client = TestClient(app, raise_server_exceptions=False)  # no `with`: no lifespan
    client.consensus_id = consensus_id
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        client.close()
        db.close()
        engine.dispose()


def _units(body) -> dict[int, dict]:
    """Every unit object in a response, keyed by its id (segment id or answer id)."""
    found: dict[int, dict] = {}

    def walk(o):
        if isinstance(o, dict):
            if "applied_code_ids" in o:
                found[o.get("dataset_value_id") or o.get("segment_id") or o["id"]] = o
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(body)
    return found


def _who(unit) -> set[tuple[int, int | None]]:
    return {(d["code_id"], d["user_id"]) for d in unit["applied_code_details"]}


def _get(http, path: str):
    r = http.get(f"/api/projects/{PID}{path}")
    assert r.status_code == 200, r.text
    return _units(r.json())


def _passages(http, code_id, query=""):
    return _get(http, f"/code-analysis/codes/{code_id}/segments?exclude_facilitator=false{query}")


def _answers(http, code_id, query=""):
    return _get(http, f"/code-analysis/codes/{code_id}/texts?x=1{query}")


def _board(http, query=""):
    return _get(http, f"/excerpts/starred?source=all{query}")


def _same_codes(unit):
    """Rule 1: the details are the chips' own applications — never a different set."""
    assert {c for c, _ in _who(unit)} == set(unit["applied_code_ids"]), unit


class TestTheListsSayWhoAppliedEachCode:
    def test_every_passage_arm_names_both_coders(self, http):
        units = _passages(http, SHARED)
        for uid in (T1, P1, K1):
            assert _who(units[uid]) == {(SHARED, ALICE), (SHARED, BOB)}, uid
            _same_codes(units[uid])
        # The chips stay DISTINCT codes — one "Shared", however many coders hold it.
        assert units[T1]["applied_code_ids"] == [SHARED]

    def test_a_colleague_only_passage_names_the_colleague(self, http):
        units = _passages(http, BOB_THEME)
        for uid in (T2, P2, K2):
            assert _who(units[uid]) == {(BOB_THEME, BOB)}, uid
            _same_codes(units[uid])

    def test_an_answer_names_both_coders(self, http):
        units = _answers(http, SHARED)
        assert _who(units[R1]) == {(SHARED, ALICE), (BOB_THEME, BOB)}
        _same_codes(units[R1])

    def test_the_quote_board_names_who_on_both_arms(self, http):
        units = _board(http)
        assert (SHARED, ALICE) in _who(units[T1]) and (SHARED, BOB) in _who(units[T1])
        assert _who(units[T2]) == {(BOB_THEME, BOB)}
        assert _who(units[R1]) == {(SHARED, ALICE), (BOB_THEME, BOB)}
        for u in units.values():
            _same_codes(u)


class TestWhileBlindAColleaguesIdNeverRidesTheWire:
    def test_the_passage_chips_follow_the_scope(self, http):
        units = _passages(http, SHARED, f"&coder_ids={ALICE}&chips_follow_coder_ids=true")
        for uid in (T1, P1, K1):
            assert _who(units[uid]) == {(SHARED, ALICE)}, uid
        assert BOB not in {u for unit in units.values() for _, u in _who(unit)}

    def test_the_answer_chips_follow_the_scope(self, http):
        units = _answers(http, SHARED, f"&coder_ids={ALICE}&chips_follow_coder_ids=true")
        assert _who(units[R1]) == {(SHARED, ALICE)}

    def test_the_quote_board_follows_the_scope(self, http):
        units = _board(http, f"&coder_ids={ALICE}")
        assert _who(units[T1]) == {(SHARED, ALICE)}
        assert _who(units[T2]) == set() and units[T2]["applied_code_ids"] == []
        assert _who(units[R1]) == {(SHARED, ALICE)}

    def test_a_coder_filter_without_the_flag_keeps_the_whole_unit(self, http):
        """Positive control: a coder FILTER narrows which units list, never whose chips (D102)."""
        units = _passages(http, SHARED, f"&coder_ids={ALICE}")
        assert _who(units[T1]) == {(SHARED, ALICE), (SHARED, BOB)}


class TestTheLayerDecidesWhoseCodingAChipIs:
    def test_under_consensus_the_coder_is_the_consensus_user(self, http):
        units = _passages(http, SHARED, "&layer_scope=consensus")
        assert _who(units[T1]) == {(SHARED, http.consensus_id)}

    def test_under_the_machine_layer_the_coder_is_the_model(self, http):
        units = _passages(http, BOB_THEME, "&layer_scope=machine")
        assert _who(units[T1]) == {(BOB_THEME, MODEL)}

    def test_the_human_layer_leaves_both_out(self, http):
        units = _passages(http, SHARED)
        assert {u for _, u in _who(units[T1])} == {ALICE, BOB}
