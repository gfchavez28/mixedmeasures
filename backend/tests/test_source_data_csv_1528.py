"""#1528 (D87–D89, 1.5.9) — the analysis page's two frequency files hold what the screen holds.

- **D88, the Source Data CSV** (`GET …/code-analysis/source-frequencies/csv`, the page's
  *Exports › Source Data CSV*). Its door omitted an unselected kind and the route parsed every
  source list with `parse_int_list`, which folds `""` into None — "every source of that kind" —
  so one selected interview listed every document, clip and question beside it (the
  2026-11-04 review's probe: six sources where the screen showed one). The route now keeps
  `""` (none) apart from absent (all) through `routers/helpers.py::parse_source_ids`, #1297's
  rule; the client half (always send `exclude_facilitator`, send `""` for an unselected kind)
  is `frontend/src/lib/qual-comparison.ts::sourceDataCsvParams`, pinned in
  `qual-comparison.frequency-files-1528.test.ts`.
- **D89** — the route is `def` (`test_endpoint_event_loop.py::MUST_BE_SYNC`).
- **D87, the Frequencies CSV** — its server route is DELETED: the file is the summary table's
  rows, written in the browser (`qual-summary-columns.ts::codeSummaryCsv`). Pinned here only
  as gone; its content is pinned beside the table.

⚠️ The fixture straddles the old and new readings (#707a): the discrimination test says so.
"""
import asyncio
import csv
import io

import pytest
from fastapi.routing import APIRoute

from app.main import app
from app.models import (
    Code, CodeApplication, Conversation, Document, Observation, Project, Segment, Speaker, User,
)
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.routers.code_analysis import source_frequencies_csv
from app.services.code_analysis import get_source_frequencies

PID = 15280
A = 15281
C1, C2, D1, O1, T1 = 15282, 15283, 15284, 15285, 15286


@pytest.fixture
def world(db_session):
    """C1 = {participant turn A · interviewer turn A}, C2 = {participant turn A}; D1 = {A};
    O1 = {a clip coded A}; one survey question T1 = {an answer coded A}."""
    db = db_session
    db.add(Project(id=PID, name="1528", user_id=1))
    db.flush()
    db.add_all([
        Code(id=A, project_id=PID, numeric_id=100, name="A", is_universal=False, is_active=True),
        Speaker(id=15290, project_id=PID, name="Pat", is_facilitator=0),
        Speaker(id=15291, project_id=PID, name="Interviewer", is_facilitator=1),
        Conversation(id=C1, project_id=PID, name="Interview 1"),
        Conversation(id=C2, project_id=PID, name="Interview 2"),
        Document(id=D1, project_id=PID, name="Policy", source_filename="p.txt", source_format="txt"),
        Observation(id=O1, project_id=PID, name="Clip set"),
        Dataset(id=15292, project_id=PID, name="Survey"),
    ])
    db.flush()
    db.add(DatasetColumn(id=T1, dataset_id=15292, column_code="Q1", column_name="Q1",
                         column_text="Question 1", column_type=ColumnType.OPEN_TEXT,
                         sequence_order=0, display_order=0))
    db.add(DatasetRow(id=15293, dataset_id=15292))
    db.flush()
    db.add(DatasetValue(id=15294, row_id=15293, column_id=T1, value_text="a real answer"))
    segs = [
        (15301, dict(conversation_id=C1, speaker_id=15290)),
        (15302, dict(conversation_id=C1, speaker_id=15291)),       # the interviewer
        (15303, dict(conversation_id=C2, speaker_id=15290)),
        (15304, dict(document_id=D1)),
        (15305, dict(observation_id=O1, start_time=1.0, end_time=2.0)),
    ]
    for i, (sid, kw) in enumerate(segs):
        db.add(Segment(id=sid, sequence_order=i, text=f"unit {sid}", word_count=2,
                       is_merge_result=False, **kw))
    db.flush()
    for sid, _ in segs:
        db.add(CodeApplication(segment_id=sid, code_id=A, user_id=1, origin="human"))
    db.add(CodeApplication(dataset_value_id=15294, code_id=A, user_id=1, origin="human"))
    db.flush()
    return db


def _rows(db, **kw) -> list[list[str]]:
    """The route, called directly (a `def` since D89), every `Query` param given so no FastAPI
    sentinel reaches the service; returns the parsed CSV."""
    params = dict(code_ids=None, conversation_ids=None, text_column_ids=None, document_ids=None,
                  exclude_facilitator=True, participant_ids=None, group_by_subtype=None,
                  coder_ids=None, layer_scope=None, observation_ids=None)
    params.update(kw)
    resp = source_frequencies_csv(project_id=PID, user=db.get(User, 1), db=db, **params)

    async def collect():
        parts = []
        async for chunk in resp.body_iterator:
            parts.append(chunk if isinstance(chunk, str) else chunk.decode())
        return "".join(parts)
    return list(csv.reader(io.StringIO(asyncio.run(collect()))))


def _sources(rows) -> dict[str, list[str]]:
    """Source label → its row, the TOTAL row left out."""
    return {r[0]: r for r in rows[1:] if r[0] != "TOTAL"}


#: What the page sends since D88 for "Interview 1 selected" (`sourceDataCsvParams`): every kind
#: present, an unselected one as `""`.
ONE_INTERVIEW = dict(conversation_ids=str(C1), text_column_ids="", document_ids="", observation_ids="")


def test_one_selected_interview_is_the_only_source_in_the_file(world):
    assert set(_sources(_rows(world, **ONE_INTERVIEW))) == {"Interview 1"}


def test_the_fixture_could_tell_the_two_readings_apart(world):
    """#707a: under the old reading (`""` folded into None = every source of the kind) the same
    selection lists the document, the clip set and the question as well."""
    old = get_source_frequencies(world, PID, conversation_ids=[C1], text_column_ids=None,
                                 document_ids=None, observation_ids=None)
    assert {s["source_type"] for s in old["sources"]} == {
        "conversation", "document", "observation", "text_column"}
    assert len(old["sources"]) == 4


def test_nothing_sent_is_still_every_source(world):
    """The positive control: an ABSENT list is every source of the kind (the Export dialog's and
    an empty selection's reading), so the route did not turn into "none" across the board."""
    assert len(_sources(_rows(world))) == 5     # C1, C2, D1, O1, T1


def test_a_kind_sent_empty_is_none_of_it_for_every_kind(world):
    for kind, keep in (("document_ids", "Policy"), ("observation_ids", "Clip set")):
        others = {k: "" for k in ("conversation_ids", "text_column_ids", "document_ids",
                                  "observation_ids") if k != kind}
        selected = {kind: str(D1 if kind == "document_ids" else O1)}
        assert set(_sources(_rows(world, **others, **selected))) == {keep}, kind
    only_question = dict(conversation_ids="", document_ids="", observation_ids="", text_column_ids=str(T1))
    assert len(_sources(_rows(world, **only_question))) == 1


def test_interviewer_turns_are_counted_when_the_page_includes_them(world):
    """The route honours `exclude_facilitator` when it is SENT — the defect was the door, which
    sent it only when true (the route defaults to true); `sourceDataCsvParams` always sends it."""
    header = _rows(world, **ONE_INTERVIEW)[0]
    col = header.index("A (Count)")
    included = _sources(_rows(world, **ONE_INTERVIEW, exclude_facilitator=False))["Interview 1"]
    excluded = _sources(_rows(world, **ONE_INTERVIEW, exclude_facilitator=True))["Interview 1"]
    assert (included[col], excluded[col]) == ("2", "1")


def test_the_server_frequencies_csv_is_gone():
    """D87: the Frequencies CSV is written in the browser from the summary table's read; the
    server file that counted another payload is not mended but deleted (#833's rule)."""
    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    assert "/api/projects/{project_id}/export/code-cooccurrence" in paths   # the walk sees exports
    assert not any(p.endswith("/export/code-frequencies") for p in paths)
