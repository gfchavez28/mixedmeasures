"""#1527 (D83–D86, 1.5.9) — the co-occurrence figure counts what the page selected.

Measured by the 2026-11-04 review (the internal design notes,
git-ignored) on this file's fixture, before the fix:

- (a) **The N.** The figure drew ``total_coded_segments + total_coded_texts`` — the
  CONVERSATION total plus the text total — so source *Conversations* read N = 3 beside a
  matrix that counted 8 units (A's diagonal alone was 5), and a documents-only project
  read N = 0. D83: one field, ``n_units``, the count the matrix was taken over.
- (b) **An unselected kind counted in full.** With one interview selected the page sent
  no document or observation list, which the builders read as ALL: A read 4 where the
  Descriptives screen reads 1. D84: #1297's rule — absent = every source of the kind,
  ``""`` = none of it (`routers/helpers.py::parse_source_ids`,
  `code_analysis._none_of_this_kind`).
- (c) **The question selection was dropped at the unit level** (parsed, never passed).
- (d) **A coded "n/a" counted** — #1526 D80 took it out of the summary table, so the
  diagonal stopped agreeing with the frequency table beside it. D85.
- (e) **The CSV was another matrix:** no level, no questions (D86).

⚠️ Every fixture here straddles the old and new behaviour, and the discrimination tests
say so (#707a): a fixture on which the hybrid and the exact selection agree certifies
nothing.
"""
import csv
import io

import pytest
from fastapi import HTTPException

from app.models import (
    Code, CodeApplication, Conversation, Document, Observation, Participant, Project, Segment,
    Speaker, User,
)
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.routers.code_analysis import code_cooccurrence
from app.routers.export import export_code_cooccurrence_csv
from app.routers.helpers import parse_source_ids
from app.services import code_analysis as ca

PID, DOCS_ONLY = 1527, 1529
A, B, UNC = 15271, 15272, 15273
C1, C2 = 15276, 15277
D1, D2 = 15278, 15279
O1 = 15280
T1, T2 = 15281, 15282


@pytest.fixture
def world(db_session):
    """C1 = {s1 P1 A+B · s2 interviewer A · s3 P1 Unclear only · s4 P1 uncoded}, C2 = {s5 A};
    D1 = {A+B, B}, D2 = {A}; O1 = {clip A+B, clip Unclear only}; questions T1 = {A+B, A,
    "n/a" B}, T2 = {B}. A second project holds ONE document paragraph coded A+B."""
    db = db_session
    db.add_all([Project(id=PID, name="1527", user_id=1),
                Project(id=DOCS_ONLY, name="1527 documents only", user_id=1)])
    db.flush()
    db.add_all([
        Code(id=UNC, project_id=PID, numeric_id=1, name="Unclear", is_universal=True, is_active=True),
        Code(id=A, project_id=PID, numeric_id=100, name="A", is_universal=False, is_active=True),
        Code(id=B, project_id=PID, numeric_id=101, name="B", is_universal=False, is_active=True),
        Code(id=15291, project_id=DOCS_ONLY, numeric_id=100, name="A", is_universal=False,
             is_active=True),
        Code(id=15292, project_id=DOCS_ONLY, numeric_id=101, name="B", is_universal=False,
             is_active=True),
        Participant(id=15274, project_id=PID, identifier="P-01"),
        Participant(id=15275, project_id=PID, identifier="P-02"),
    ])
    db.flush()
    db.add_all([
        Speaker(id=15283, project_id=PID, name="Pat", is_facilitator=0, participant_id=15274),
        Speaker(id=15284, project_id=PID, name="Sam", is_facilitator=0, participant_id=15275),
        Speaker(id=15285, project_id=PID, name="Interviewer", is_facilitator=1),
        Conversation(id=C1, project_id=PID, name="C1"),
        Conversation(id=C2, project_id=PID, name="C2"),
        Document(id=D1, project_id=PID, name="D1", source_filename="d1.txt", source_format="txt"),
        Document(id=D2, project_id=PID, name="D2", source_filename="d2.txt", source_format="txt"),
        Document(id=15290, project_id=DOCS_ONLY, name="Only", source_filename="o.txt",
                 source_format="txt"),
        Observation(id=O1, project_id=PID, name="O1"),
    ])
    db.flush()
    segs = [
        (15301, dict(conversation_id=C1, speaker_id=15283), [A, B]),
        (15302, dict(conversation_id=C1, speaker_id=15285), [A]),
        (15303, dict(conversation_id=C1, speaker_id=15283), [UNC]),
        (15304, dict(conversation_id=C1, speaker_id=15283), []),
        (15305, dict(conversation_id=C2, speaker_id=15284), [A]),
        (15311, dict(document_id=D1, conversation_id=None), [A, B]),
        (15312, dict(document_id=D1, conversation_id=None), [B]),
        (15313, dict(document_id=D2, conversation_id=None), [A]),
        (15321, dict(observation_id=O1, conversation_id=None, start_time=1.0, end_time=2.0), [A, B]),
        (15322, dict(observation_id=O1, conversation_id=None, start_time=3.0, end_time=4.0), [UNC]),
        (15391, dict(document_id=15290, conversation_id=None), [15291, 15292]),
    ]
    for i, (sid, kw, codes) in enumerate(segs):
        db.add(Segment(id=sid, sequence_order=i, text=f"unit {sid}", word_count=2,
                       is_merge_result=False, **kw))
        db.flush()
        for c in codes:
            db.add(CodeApplication(segment_id=sid, code_id=c, user_id=1, origin="human"))
    db.add(Dataset(id=15340, project_id=PID, name="Survey"))
    db.flush()
    for col_id, i in ((T1, 0), (T2, 1)):
        db.add(DatasetColumn(id=col_id, dataset_id=15340, column_code=f"Q{i}", column_name=f"Q{i}",
                             column_text=f"Question {i}", column_type=ColumnType.OPEN_TEXT,
                             sequence_order=i, display_order=i))
    db.flush()
    for rid in (15341, 15342, 15343):
        db.add(DatasetRow(id=rid, dataset_id=15340))
    db.flush()
    for vid, rid, col, text, codes in [
        (15351, 15341, T1, "a real answer", [A, B]),
        (15352, 15342, T1, "another answer", [A]),
        (15353, 15343, T1, "n/a", [B]),             # treat-as-empty by default, and coded
        (15354, 15341, T2, "second question", [B]),
    ]:
        db.add(DatasetValue(id=vid, row_id=rid, column_id=col, value_text=text))
        db.flush()
        for c in codes:
            db.add(CodeApplication(dataset_value_id=vid, code_id=c, user_id=1, origin="human"))
    db.flush()
    return db


def _route(db, pid=PID, **kw):
    """The screen's request, through the route (a `def` since D89) — every Query param given,
    so no FastAPI sentinel reaches the service."""
    params = dict(code_ids=None, exclude_facilitator=True, conversation_ids=None,
                  participant_ids=None, text_column_ids=None, document_ids=None, coder_ids=None,
                  layer_scope=None, source="conversations", level="segment", observation_ids=None)
    params.update(kw)
    return code_cooccurrence(project_id=pid, user=db.get(User, 1), db=db, **params)


def _csv(db, **kw):
    params = dict(code_ids=None, exclude_facilitator=True, conversation_ids=None,
                  participant_ids=None, source="conversations", document_ids=None,
                  coder_ids=None, layer_scope=None, observation_ids=None)
    params.update(kw)
    return export_code_cooccurrence_csv(project_id=PID, user=db.get(User, 1), db=db, **params)


def _csv_rows(db, **kw):
    import asyncio

    response = _csv(db, **kw)

    async def collect():
        out = b""
        async for chunk in response.body_iterator:
            out += chunk if isinstance(chunk, bytes) else chunk.encode()
        return out.decode()

    return list(csv.reader(io.StringIO(asyncio.run(collect()))))


def _diag(payload, name):
    names = [c["name"] for c in payload["codes"]]
    return payload["matrix"][names.index(name)][names.index(name)]


def _pair(payload, a="A", b="B"):
    names = [c["name"] for c in payload["codes"]]
    return payload["matrix"][names.index(a)][names.index(b)]


# ── D83: the N is the count the matrix was taken over ──────────────────────────


class TestTheNCountsWhatTheMatrixCounted:
    @pytest.mark.parametrize("source,expected", [
        # 3 turns (s1, s3 Unclear only, s5) + 3 paragraphs + 2 clips
        ("conversations", 8),
        # T1's two substantive answers + T2's one ("n/a" is not a unit, D85)
        ("text", 3),
        ("all", 11),
    ])
    def test_every_unit_kind_is_in_the_n(self, world, source, expected):
        payload = _route(world, source=source)
        assert payload["n_units"] == expected
        assert "total_coded_segments" not in payload and "total_coded_texts" not in payload

    def test_no_cell_of_the_diagonal_exceeds_the_n(self, world):
        """The contradiction on screen before: N 3 beside A on 5."""
        for source in ("conversations", "text", "all"):
            payload = _route(world, source=source)
            for c in payload["codes"]:
                assert _diag(payload, c["name"]) <= payload["n_units"], (source, c["name"])

    def test_the_fixture_tells_the_old_n_from_the_new(self, world):
        """#707a: the old N (conversation total + text total) differs here."""
        _cooccur, total_units, conv_total, text_total, _doc = ca.build_code_cooccurrence_matrix(
            world, PID, source="conversations")
        assert conv_total + text_total != total_units
        assert _route(world, source="conversations")["n_units"] == total_units

    def test_a_documents_only_project_has_an_n(self, world):
        payload = _route(world, pid=DOCS_ONLY)
        assert _pair(payload) == 1
        assert payload["n_units"] == 1

    def test_the_source_level_n_is_the_sources(self, world):
        payload = _route(world, source="all", level="source")
        assert payload["n_units"] == 7  # C1, C2, D1, D2, O1, T1, T2


# ── D84: exactly the selection, at both levels ──────────────────────────────────


def _one_interview(**extra):
    """As the page sends one selected interview since D84 (`comparisonSourceParams`)."""
    return dict(conversation_ids=str(C1), document_ids="", observation_ids="",
                text_column_ids="", **extra)


class TestTheFigureCountsExactlyTheSelection:
    def test_an_unselected_kind_counts_nothing_at_the_unit_level(self, world):
        payload = _route(world, **_one_interview())
        assert _diag(payload, "A") == 1   # s1 only (s2 is the interviewer's)
        assert payload["n_units"] == 2    # s1 and s3

    def test_an_unselected_kind_counts_nothing_at_the_source_level(self, world):
        payload = _route(world, level="source", **_one_interview())
        assert payload["n_units"] == 1
        assert _diag(payload, "A") == 1

    def test_absent_still_means_every_source(self, world):
        """Nothing selected sends no list at all — every source, as before."""
        payload = _route(world, source="conversations")
        assert _diag(payload, "A") == 5

    def test_the_fixture_tells_the_hybrid_from_the_exact_selection(self, world):
        """#707a: the reading before D84 (other kinds absent) differs on this fixture."""
        hybrid = _route(world, conversation_ids=str(C1))
        exact = _route(world, **_one_interview())
        assert _diag(hybrid, "A") == 4 and _diag(exact, "A") == 1

    @pytest.mark.parametrize("level,n,a,b", [("segment", 2, 1, 2), ("source", 1, 1, 1)])
    def test_one_document_alone_counts_no_other_kind(self, world, level, n, a, b):
        """Source *All* with one document selected: every other kind is sent empty, and
        each must count nothing — conversations and questions included (the first
        mutation run found no fixture that reached those two guards)."""
        payload = _route(world, source="all", level=level, document_ids=str(D1),
                         conversation_ids="", observation_ids="", text_column_ids="")
        assert payload["n_units"] == n
        assert _diag(payload, "A") == a and _diag(payload, "B") == b
        assert _diag(payload, "Unclear") == 0   # the turn and the clip marked Unclear are out

    def test_the_question_selection_reaches_the_unit_level(self, world):
        payload = _route(world, source="text", text_column_ids=str(T1))
        assert _diag(payload, "B") == 1   # T1's real answer only; T2's B is not selected
        assert payload["n_units"] == 2

    def test_a_kind_sent_empty_under_text_counts_nothing(self, world):
        payload = _route(world, source="text", text_column_ids="", conversation_ids=str(C1))
        assert payload["n_units"] == 0 and all(v == 0 for row in payload["matrix"] for v in row)

    @pytest.mark.parametrize("raw,expected", [(None, None), ("", []), ("3,4", [3, 4])])
    def test_parse_source_ids_keeps_absent_apart_from_empty(self, raw, expected):
        assert parse_source_ids(raw) == expected


# ── D85: an answer the project treats as no response is not a unit ──────────────


class TestANoResponseAnswerLeavesTheMatrix:
    def test_at_the_unit_level(self, world):
        payload = _route(world, source="text")
        assert _diag(payload, "B") == 2   # T1's real answer + T2's; the coded "n/a" is out
        assert _diag(payload, "A") == 2   # positive control: real answers still count

    def test_at_the_source_level(self, world):
        """A question whose only B answer is "n/a" does not carry B."""
        world.query(CodeApplication).filter(CodeApplication.dataset_value_id == 15351,
                                            CodeApplication.code_id == B).delete()
        world.flush()
        payload = _route(world, source="text", level="source", text_column_ids=str(T1))
        assert _diag(payload, "B") == 0
        assert _diag(payload, "A") == 1

    def test_the_diagonal_agrees_with_the_summary_table(self, world):
        """#1335 D46's promise, restored after #1526 D80 moved the table."""
        payload = _route(world, source="text", text_column_ids=f"{T1},{T2}")
        sf = ca.get_source_frequencies(world, PID, conversation_ids=[], document_ids=[],
                                       observation_ids=[], text_column_ids=[T1, T2])
        for code_id, name in ((A, "A"), (B, "B")):
            table = sum((s.get("code_counts") or {}).get(str(code_id), {}).get("count", 0)
                        for s in sf["sources"])
            assert _diag(payload, name) == table, name


# ── D86: the CSV is the matrix the screen shows ─────────────────────────────────


class TestTheCsvIsTheScreensMatrix:
    @pytest.mark.parametrize("level", ["segment", "source"])
    def test_the_file_equals_the_screen_under_a_selection(self, world, level):
        scope = dict(source="all", **_one_interview())
        scope["text_column_ids"] = str(T1)
        screen = _route(world, level=level, **scope)
        rows = _csv_rows(world, level=level, **scope)
        header = rows[1]
        for i, row_code in enumerate(screen["codes"]):
            line = next(r for r in rows[2:] if r[0] == row_code["name"])
            for j, col_code in enumerate(screen["codes"]):
                assert int(line[header.index(col_code["name"])]) == screen["matrix"][i][j]

    def test_the_source_level_file_says_so(self, world):
        rows = _csv_rows(world, level="source")
        assert rows[0] == [f"{ca.COOCCURRENCE_SOURCE_LEVEL_NOTE} {ca.COOCCURRENCE_RULE}"]
        assert _csv_rows(world)[0] == [ca.COOCCURRENCE_RULE]

    def test_the_file_takes_the_questions(self, world):
        rows = _csv_rows(world, source="text", text_column_ids=str(T1))
        header = rows[1]
        b = next(r for r in rows[2:] if r[0] == "B")
        assert int(b[header.index("B")]) == 1

    def test_an_unknown_level_is_refused(self, world):
        with pytest.raises(HTTPException) as e:
            _csv(world, level="passage")
        assert e.value.status_code == 400
