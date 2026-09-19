"""#956 — the text read paths and the merge-codes cascade survive SQLite's
bound-parameter ceiling.

**The ceiling is lowered, not reached.** SQLite's `SQLITE_MAX_VARIABLE_NUMBER` is
250,000, and building a 250,000-value project in a test costs ~7 s and ~870 MB
(#842's depth pass) — which is why `test_portability_scale_bound.py` had to guard
its two functions by reading their SOURCE. But the limit is a per-connection
runtime setting (`sqlite3.Connection.setlimit`), so these tests drop it to
`LIMIT` on the test connection and build a fixture a few times larger. Every
call below then crosses the ceiling exactly as a BES-sized selection does, and
the property is asserted where it lives: the request completes, with the right
numbers.

⚠️ **The discrimination assertion is load-bearing** (backend/tests/the internal design notes,
#707a): `test_the_lowered_limit_really_refuses_a_bound_list` proves a plain
`.in_()` over the fixture's own id set RAISES under the same limit. Without it,
a limit that silently failed to apply would leave every other test green.

⚠️ **Scope.** These are #956's sites — the rows × columns text paths and the
`code_ids` staleness cascade. A 2026-09-13 classification of every `.in_()` in
`app/` found ~75 more that grow with row, participant or segment counts; those
are filed separately and are NOT covered here.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest
from sqlalchemy.exc import OperationalError

from app.models import (
    Code, CodeApplication, Conversation, Dataset, DatasetColumn, DatasetRow,
    DatasetValue, Note, Participant, Project, Segment, User,
)
from app.models.consensus_stale_target import ConsensusStaleTarget
from app.models.dataset import ColumnType
from app.routers.text_analysis import (
    code_density, cross_tabulation, export_cross_analysis, filtered_frequencies,
    response_length_by_code,
)
from app.routers.text_coding import coding_progress, export_coded_texts, list_records
from app.schemas.text_analysis import CrossTabulationRequest, FilteredFrequenciesRequest, SubgroupFilter
from app.services.consensus_staleness import mark_consensus_stale
from app.services.id_set import in_id_set

PID = 9560
LIMIT = 40          # bound parameters per statement, on the test connection
ROWS = 60           # records per dataset → 120 text values, 60 rows, 60 participants
SEGMENTS = 50       # coded conversation segments for the staleness cascade


def _lower_limit(db) -> None:
    raw = db.connection().connection.dbapi_connection
    raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, LIMIT)


def _body(resp) -> str:
    async def collect():
        parts = []
        async for chunk in resp.body_iterator:
            parts.append(chunk if isinstance(chunk, str) else chunk.decode())
        return "".join(parts)
    return asyncio.run(collect())


@pytest.fixture
def corpus(db_session):
    """Two datasets linked through participants, every text value coded.

    Dataset A holds two open-text columns (the focal texts); dataset B holds a
    categorical column in ANOTHER dataset, so `cross_tabulation` takes its
    participant-linked arm — the two `.in_()` sites the same-dataset arm skips.
    """
    db = db_session
    db.add(User(id=2, username="coder-b", password_hash="x"))
    db.add(Project(id=PID, name="Ceiling", user_id=1))
    db.flush()

    ds_a = Dataset(project_id=PID, name="Survey")
    ds_b = Dataset(project_id=PID, name="Profile")
    db.add_all([ds_a, ds_b])
    db.flush()
    text_1 = DatasetColumn(dataset_id=ds_a.id, column_name="Q1", column_text="Q1",
                           column_type=ColumnType.OPEN_TEXT, sequence_order=1)
    text_2 = DatasetColumn(dataset_id=ds_a.id, column_name="Q2", column_text="Q2",
                           column_type=ColumnType.OPEN_TEXT, sequence_order=2)
    group = DatasetColumn(dataset_id=ds_b.id, column_name="Region", column_text="Region",
                          column_type=ColumnType.NOMINAL, sequence_order=1)
    db.add_all([text_1, text_2, group])
    db.flush()

    code = Code(project_id=PID, name="Theme", numeric_id=1)
    db.add(code)
    db.flush()

    for i in range(ROWS):
        person = Participant(project_id=PID, identifier=f"P{i:03d}")
        db.add(person)
        db.flush()
        row_a = DatasetRow(dataset_id=ds_a.id, row_identifier=f"A{i:03d}", participant_id=person.id)
        row_b = DatasetRow(dataset_id=ds_b.id, row_identifier=f"B{i:03d}", participant_id=person.id)
        db.add_all([row_a, row_b])
        db.flush()
        db.add(DatasetValue(row_id=row_b.id, column_id=group.id,
                            value_text="North" if i % 2 else "South"))
        for column in (text_1, text_2):
            value = DatasetValue(row_id=row_a.id, column_id=column.id,
                                 value_text=f"answer {i} to {column.column_name}")
            db.add(value)
            db.flush()
            db.add(CodeApplication(dataset_value_id=value.id, code_id=code.id, user_id=1))
            db.add(Note(dataset_value_id=value.id, content=f"note {i}", sequence_number=1))

    conversation = Conversation(project_id=PID, name="Interview")
    db.add(conversation)
    db.flush()
    for i in range(SEGMENTS):
        segment = Segment(conversation_id=conversation.id, sequence_order=i, text=f"turn {i}")
        db.add(segment)
        db.flush()
        db.add(CodeApplication(segment_id=segment.id, code_id=code.id, user_id=1))
    db.flush()

    return {
        "db": db, "user": db.get(User, 1), "code": code.id,
        "text_cols": [text_1.id, text_2.id], "group": group.id,
        "csv": f"{text_1.id},{text_2.id}",
    }


# ── the helper ──────────────────────────────────────────────────────────────

def test_the_lowered_limit_really_refuses_a_bound_list(corpus):
    """DISCRIMINATION: under the same limit, the pre-#956 spelling raises."""
    db = corpus["db"]
    ids = [v for (v,) in db.query(DatasetValue.id).all()]
    assert len(ids) > LIMIT, "the fixture must be larger than the lowered limit"
    _lower_limit(db)
    with pytest.raises(OperationalError, match="too many SQL variables"):
        db.query(CodeApplication.id).filter(CodeApplication.dataset_value_id.in_(ids)).all()


def test_in_id_set_matches_in_exactly_and_crosses_the_limit(corpus):
    db = corpus["db"]
    # The CODED values — one application each — so a count is also an identity.
    ids = [v for (v,) in db.query(CodeApplication.dataset_value_id)
           .filter(CodeApplication.dataset_value_id.isnot(None)).all()]
    subset = ids[::3]
    expected = {
        a for (a,) in db.query(CodeApplication.id)
        .filter(CodeApplication.dataset_value_id.in_(subset)).all()
    }
    _lower_limit(db)
    got = {
        a for (a,) in db.query(CodeApplication.id)
        .filter(in_id_set(CodeApplication.dataset_value_id, subset)).all()
    }
    assert got == expected and len(got) == len(subset)
    everything = db.query(CodeApplication.id).filter(
        in_id_set(CodeApplication.dataset_value_id, ids)).count()
    assert everything == len(ids)


def test_an_empty_set_matches_nothing(corpus):
    db = corpus["db"]
    assert db.query(CodeApplication.id).filter(
        in_id_set(CodeApplication.dataset_value_id, [])).count() == 0


def test_a_generator_and_a_set_are_accepted(corpus):
    db = corpus["db"]
    ids = [v for (v,) in db.query(DatasetValue.id).limit(5).all()]
    assert db.query(DatasetValue.id).filter(in_id_set(DatasetValue.id, set(ids))).count() == 5
    assert db.query(DatasetValue.id).filter(in_id_set(DatasetValue.id, (i for i in ids))).count() == 5


@pytest.mark.parametrize("bad", [True, "7", 7.0, None])
def test_non_integer_ids_are_refused(bad):
    """A bool is an int in Python and `true` in JSON — it would silently match
    nothing, so it is refused with the rest."""
    with pytest.raises(TypeError):
        in_id_set(DatasetValue.id, [1, bad])


def test_one_bound_parameter_however_many_ids():
    from sqlalchemy import select
    from sqlalchemy.dialects import sqlite as sqlite_dialect
    compiled = select(DatasetValue.id).where(
        in_id_set(DatasetValue.id, range(10_000))
    ).compile(dialect=sqlite_dialect.dialect())
    assert len(compiled.params) == 1
    assert json.loads(next(iter(compiled.params.values()))) == list(range(10_000))


# ── #956's sites, each crossing the lowered limit ───────────────────────────

def test_coding_progress(corpus):
    db, user = corpus["db"], corpus["user"]
    _lower_limit(db)
    for column_ids in (None, corpus["csv"]):
        resp = coding_progress(project_id=PID, column_ids=column_ids, user=user, db=db)
        assert resp.overall_texts == {"coded": 2 * ROWS, "total": 2 * ROWS}
        assert resp.overall_records == {"coded": ROWS, "total": ROWS}
        assert [c.coded_texts for c in resp.by_coder] == [2 * ROWS]


def test_list_records(corpus):
    db, user = corpus["db"], corpus["user"]
    _lower_limit(db)
    resp = list_records(project_id=PID, column_ids=corpus["csv"], dataset_ids=None,
                        hide_empty=True, user=user, db=db)
    assert resp.total == ROWS
    assert all(r.coded_text_count == 2 and r.participant_name for r in resp.records)


def test_export_coded_texts(corpus):
    db, user = corpus["db"], corpus["user"]
    _lower_limit(db)
    resp = export_coded_texts(project_id=PID, coded_only=True, column_ids=None, user=user, db=db)
    lines = _body(resp).strip().splitlines()
    assert len(lines) == 1 + 2 * ROWS, "every coded text, plus the header"
    assert lines[1].count("Theme") == 1 and "note" in lines[1]


def test_code_density(corpus):
    db, user = corpus["db"], corpus["user"]
    _lower_limit(db)
    resp = code_density(project_id=PID, column_ids=corpus["csv"], group_by_column_id=None,
                        coder_ids=None, layer_scope=None, db=db, user=user)
    assert resp.overall.text_count == 2 * ROWS
    assert resp.overall.avg_codes_per_text == 1.0


def test_response_length_by_code(corpus):
    db, user = corpus["db"], corpus["user"]
    _lower_limit(db)
    resp = response_length_by_code(project_id=PID, column_ids=corpus["csv"],
                                    coder_ids=None, layer_scope=None, db=db, user=user)
    theme = {c.code_id: c for c in resp.codes}[corpus["code"]]
    assert theme.text_count == 2 * ROWS
    assert resp.uncoded.text_count == 0


def test_cross_tabulation_through_participant_links(corpus):
    """The cross column lives in ANOTHER dataset, so the participant-linked arm
    runs — three dataset-scaled sets in one request."""
    db, user = corpus["db"], corpus["user"]
    _lower_limit(db)
    resp = cross_tabulation(
        project_id=PID,
        body=CrossTabulationRequest(text_column_ids=corpus["text_cols"], cross_column_id=corpus["group"]),
        db=db, user=user,
    )
    assert resp.total_coded_texts == 2 * ROWS
    assert resp.column_totals == {"North": ROWS, "South": ROWS}


def test_filtered_frequencies_with_a_filter(corpus):
    """A filter on dataset B leaves dataset A unfiltered, so its WHOLE row set
    reaches `get_non_empty_comment_values(row_ids=…)`."""
    db, user = corpus["db"], corpus["user"]
    _lower_limit(db)
    resp = filtered_frequencies(
        project_id=PID,
        body=FilteredFrequenciesRequest(
            column_ids=corpus["text_cols"],
            filters=[SubgroupFilter(column_id=corpus["group"], operator="equals", values=["North"])],
        ),
        db=db, user=user,
    )
    assert resp.filtered.text_count == 2 * ROWS
    assert resp.overall is not None and resp.overall.text_count == 2 * ROWS


def test_export_cross_analysis_with_a_filter(corpus):
    db, user = corpus["db"], corpus["user"]
    _lower_limit(db)
    filters = json.dumps([{"column_id": corpus["group"], "operator": "equals", "values": ["South"]}])
    resp = export_cross_analysis(project_id=PID, column_ids=corpus["csv"], filters_json=filters,
                                 coder_ids=None, layer_scope=None, db=db, user=user)
    body = _body(resp)
    assert f"Theme,{2 * ROWS},100.0%,{2 * ROWS},100.0%" in body
    # "answer N to QK" is four words on every text.
    assert f"Theme,4.0,{2 * ROWS}" in body


@pytest.fixture
def uneven(db_session):
    """Columns, codes and word counts that all DIFFER, so the one-pass rewrites
    #956 made for speed cannot pass by coincidence.

    The ceiling corpus above is degenerate on these axes: one code, and every
    text the same length in two equal columns — a rewrite that credited every
    text to one column, or one code's words to another, would still match it.
    """
    db = db_session
    db.add(Project(id=PID + 1, name="Uneven", user_id=1))
    db.flush()
    ds = Dataset(project_id=PID + 1, name="Survey")
    db.add(ds)
    db.flush()
    col_a = DatasetColumn(dataset_id=ds.id, column_name="A", column_text="A",
                          column_type=ColumnType.OPEN_TEXT, sequence_order=1)
    col_b = DatasetColumn(dataset_id=ds.id, column_name="B", column_text="B",
                          column_type=ColumnType.OPEN_TEXT, sequence_order=2)
    db.add_all([col_a, col_b])
    x = Code(project_id=PID + 1, name="X", numeric_id=1)
    y = Code(project_id=PID + 1, name="Y", numeric_id=2)
    db.add_all([x, y])
    db.flush()
    cells = [  # (column, text, codes)
        (col_a, "one two", [x]),
        (col_a, "one two three four", [x, y]),
        (col_a, "one", []),
        (col_b, "a b c", [y]),
        (col_b, "N/A", [x]),  # coded, but not a substantive text (#519)
    ]
    for i, (column, text, codes) in enumerate(cells):
        row = DatasetRow(dataset_id=ds.id, row_identifier=f"R{i}")
        db.add(row)
        db.flush()
        value = DatasetValue(row_id=row.id, column_id=column.id, value_text=text)
        db.add(value)
        db.flush()
        for code in codes:
            db.add(CodeApplication(dataset_value_id=value.id, code_id=code.id, user_id=1))
    db.flush()
    return {"db": db, "user": db.get(User, 1), "a": col_a.id, "b": col_b.id,
            "x": x.id, "y": y.id, "csv": f"{col_a.id},{col_b.id}"}


def test_response_length_one_pass_keeps_every_code_apart(uneven):
    db, user = uneven["db"], uneven["user"]
    resp = response_length_by_code(project_id=PID + 1, column_ids=uneven["csv"],
                                    coder_ids=None, layer_scope=None, db=db, user=user)
    by_code = {c.code_id: (c.avg_words, c.text_count) for c in resp.codes}
    assert by_code[uneven["x"]] == (3.0, 2), "X: 2 + 4 words over two texts; the N/A cell never counts"
    assert by_code[uneven["y"]] == (3.5, 2), "Y: 4 + 3 words over two texts"
    assert (resp.uncoded.avg_words, resp.uncoded.text_count) == (1.0, 1)


def test_cross_analysis_export_one_pass_matches(uneven):
    db, user = uneven["db"], uneven["user"]
    body = _body(export_cross_analysis(project_id=PID + 1, column_ids=uneven["csv"], filters_json="[]",
                                       coder_ids=None, layer_scope=None, db=db, user=user))
    section = body.split("Response Length by Code", 1)[1]
    assert "X,3.0,2" in section and "Y,3.5,2" in section and "(Uncoded),1.0,1" in section


def test_coding_progress_buckets_each_column_separately(uneven):
    db, user = uneven["db"], uneven["user"]
    resp = coding_progress(project_id=PID + 1, column_ids=uneven["csv"], user=user, db=db)
    by_column = {c.column_id: (c.coded, c.total) for c in resp.by_column}
    assert by_column == {uneven["a"]: (2, 3), uneven["b"]: (1, 1)}


def test_merge_codes_staleness_cascade(corpus):
    """`merge_codes` marks every target of both codes — 120 values and 50
    segments here — before it reassigns anything."""
    db = corpus["db"]
    _lower_limit(db)
    inserted = mark_consensus_stale(db, PID, code_ids=[corpus["code"]])
    assert inserted == 2 * ROWS + SEGMENTS
    # Idempotent: the `already` sets are dataset-scaled on the second pass too.
    assert mark_consensus_stale(db, PID, code_ids=[corpus["code"]]) == 0
    assert db.query(ConsensusStaleTarget).filter(ConsensusStaleTarget.project_id == PID).count() \
        == 2 * ROWS + SEGMENTS
