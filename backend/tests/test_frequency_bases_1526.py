"""#1526 (1.5.9, D78–D81) — what a qualitative frequency is divided by.

Before 1.5.9 two kinds of unit sat in a code's COUNT and outside the BASE it was divided by, so
the Descriptives summary table (and its Canvas embed, and the code-frequencies CSV) could print
a share over 100%:

- a unit marked ONLY with universal codes ("Unclear", "Unsubstantive/Artifact") — invariant J-A
  leaves it out of every coded base, while the universal code's own row counts exactly such units
  (D79: that row keeps its counts and shows no share of the coded total);
- a survey answer the project treats as no response ("N/A"…) that someone coded — the base and
  the Records count dropped it, the per-code Texts count kept it (D80: #840's pairing, which the
  grouped arm and the records arm already had).

And `get_code_frequencies`' text total counted universal-only answers (D78), which decided the
analysis page's `hasCoding` differently for a survey answer than for a document segment; the
never-read fields with that base are deleted (D81).

The fixture is the 2026-11-03e review's probe (its git-ignored review kit), whose answers the old code got wrong: every literal below is the fixture's own.

#1528 (1.5.9, D87) deleted the server code-frequencies CSV this file also pinned: the
Frequencies CSV is the summary table's rows, written in the browser, so its universal row and
its note are pinned beside the table (`frontend/src/components/qualitative-analysis/
qual-summary-columns.test.tsx`), and the note has one statement, the client's.

Fixture (PID): D1 = {s1: A, s2: Unclear only, s3: uncoded}; D2 = {s4: Unclear only}; one
open-text question, one answer per record — a1 "a real answer" (A), a2 "hard to read" (Unclear
only), a3 "idk" (Unsubstantive only), a4 uncoded, a5 "n/a" (Unsubstantive only), a6 "N/A" (A).
"n/a" and "N/A" are in the default treat-as-empty list. A sits in category C.
PID2 holds ONE coding: "Unclear" on a survey answer. PID3: "Unclear" on a document segment.
PID4 holds no universal coding at all (the server CSV's negative control until #1528 deleted it).
"""
import re
from pathlib import Path

import pytest

from app.models import Code, CodeApplication, CodeCategory, Project, User
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.segment import Segment
from app.routers.text_coding import list_records
from app.schemas.text_coding import RecordResponse
from app.services import code_analysis as ca

PID, PID2, PID3, PID4 = 1526, 1527, 1528, 1529
U0, U1, A = 15263, 15262, 15261           # Unsubstantive/Artifact, Unclear, a real code
CAT = 15260
D1, D2 = 15264, 15265
T1, DS = 15266, 15390
S1, S2, S3, S4 = 15301, 15302, 15303, 15304
ANSWERS = [  # (record, value, text, [codes])
    (15311, 15321, "a real answer", [A]),
    (15312, 15322, "hard to read", [U1]),
    (15313, 15323, "idk", [U0]),
    (15314, 15324, "uncoded answer", []),
    (15315, 15325, "n/a", [U0]),
    (15316, 15326, "N/A", [A]),
]
A1, A6 = 15321, 15326


def _universal_pair(db, pid, base):
    db.add_all([
        Code(id=base, project_id=pid, numeric_id=0, name="Unsubstantive/Artifact",
             is_universal=True, is_active=True),
        Code(id=base + 1, project_id=pid, numeric_id=1, name="Unclear",
             is_universal=True, is_active=True),
    ])


def _text_column(db, pid, ds_id, col_id):
    db.add(Dataset(id=ds_id, project_id=pid, name=f"Survey {pid}"))
    db.flush()
    db.add(DatasetColumn(id=col_id, dataset_id=ds_id, column_code="Q1", column_name="Q1",
                         column_text="What did you think?", column_type=ColumnType.OPEN_TEXT,
                         sequence_order=0, display_order=0))
    db.flush()


def _apply(db, code, *, segment=None, value=None):
    db.add(CodeApplication(segment_id=segment, dataset_value_id=value, code_id=code,
                           user_id=1, origin="human"))


@pytest.fixture
def world(db_session):
    db = db_session
    db.add_all([Project(id=p, name=f"bases {p}", user_id=1) for p in (PID, PID2, PID3, PID4)])
    db.flush()
    db.add(CodeCategory(id=CAT, project_id=PID, name="C"))
    db.flush()
    db.add_all([
        Code(id=U0, project_id=PID, numeric_id=0, name="Unsubstantive/Artifact",
             is_universal=True, is_active=True),
        Code(id=U1, project_id=PID, numeric_id=1, name="Unclear", is_universal=True,
             is_active=True),
        Code(id=A, project_id=PID, numeric_id=100, name="A theme", is_universal=False,
             is_active=True, category_id=CAT),
        Code(id=15400, project_id=PID4, numeric_id=100, name="Only real", is_universal=False,
             is_active=True),
    ])
    _universal_pair(db, PID2, 15360)
    _universal_pair(db, PID3, 15370)
    db.add_all([
        Document(id=D1, project_id=PID, name="D1", source_filename="d1.txt", source_format="txt"),
        Document(id=D2, project_id=PID, name="D2", source_filename="d2.txt", source_format="txt"),
        Document(id=15380, project_id=PID3, name="D3", source_filename="d3.txt",
                 source_format="txt"),
        Document(id=15410, project_id=PID4, name="D4", source_filename="d4.txt",
                 source_format="txt"),
    ])
    db.flush()
    for sid, did, order in [(S1, D1, 0), (S2, D1, 1), (S3, D1, 2), (S4, D2, 0),
                            (15381, 15380, 0), (15411, 15410, 0)]:
        db.add(Segment(id=sid, document_id=did, conversation_id=None, speaker_id=None,
                       sequence_order=order, text=f"paragraph {sid}", word_count=2,
                       is_merge_result=False))
    _text_column(db, PID, DS, T1)
    _text_column(db, PID2, 15391, 15392)
    for rec, vid, text, codes in ANSWERS:
        db.add(DatasetRow(id=rec, dataset_id=DS, row_identifier=f"R{rec}"))
        db.flush()
        db.add(DatasetValue(id=vid, row_id=rec, column_id=T1, value_text=text,
                            word_count=len(text.split())))
        db.flush()
        for c in codes:
            _apply(db, c, value=vid)
    db.add(DatasetRow(id=15317, dataset_id=15391))
    db.flush()
    db.add(DatasetValue(id=15327, row_id=15317, column_id=15392, value_text="mumbled",
                        word_count=1))
    db.flush()
    _apply(db, A, segment=S1)
    _apply(db, U1, segment=S2)
    _apply(db, U1, segment=S4)
    _apply(db, 15361, value=15327)       # PID2: Unclear on its one answer
    _apply(db, 15371, segment=15381)     # PID3: Unclear on its one segment
    _apply(db, 15400, segment=15411)     # PID4: a real code only
    db.flush()
    return db


def _text_source(sf):
    (src,) = [s for s in sf["sources"] if s["source_type"] == "text_column"]
    return src


def test_the_fixture_holds_what_the_old_code_got_wrong(world):
    """#707a — the fixture must be one on which the old rules and the new DISAGREE."""
    db = world
    coded_empty = (db.query(CodeApplication).join(DatasetValue)
                   .filter(DatasetValue.value_text.in_(["n/a", "N/A"])).count())
    universal_only_answers = [v for _r, v, _t, codes in ANSWERS
                              if codes and all(c in (U0, U1) for c in codes)]
    assert coded_empty == 2, "two coded treat-as-empty answers (a5 Unsubstantive, a6 A)"
    assert len(universal_only_answers) == 3, "a2, a3, a5 carry only universal codes"


# ── D78: the text total is J-A, so hasCoding reads a survey answer as it reads a segment ──


def test_the_text_total_leaves_out_universal_only_answers(world):
    # a1 and a6 carry A; a2, a3, a5 only universal codes; a4 nothing. (Before D78: 5.)
    # a6 is a treat-as-empty "N/A" — D78 adds no #840 clause, as the segment arms have none.
    assert ca.get_code_frequencies(world, PID, source="text")["total_coded_texts"] == 2


@pytest.mark.parametrize("source", ["text", "conversations", "all"])
def test_has_coding_reads_a_survey_answer_as_it_reads_a_document_segment(world, source):
    # `QualitativeAnalysisView`'s gate: total_coded_segments > 0 || total_coded_texts > 0.
    for pid in (PID2, PID3):
        r = ca.get_code_frequencies(world, pid, source=source)
        assert (r["total_coded_segments"], r["total_coded_texts"]) == (0, 0), (pid, source)
    # Positive control: the main project IS coded under every source.
    r = ca.get_code_frequencies(world, PID, source=source)
    assert r["total_coded_segments"] > 0 or r["total_coded_texts"] > 0


# ── D80: a code's count of survey answers holds only answers its base can hold ──────────


def test_texts_equals_records_and_the_base_holds_the_count(world):
    sf = ca.get_source_frequencies(world, PID)
    src = _text_source(sf)
    counts = {int(k): v["count"] for k, v in src["code_counts"].items()}
    # a6 ("N/A", coded A) and a5 ("n/a", Unsubstantive) are no-responses: out of the counts,
    # as they are out of the base. (Before D80: A 2, Unsubstantive 2.)
    assert counts == {A: 1, U1: 1, U0: 1}
    assert sf["totals"]["coded_texts"] == 1          # a1 — J-A and #840, unchanged
    a = next(c for c in sf["codes"] if c["id"] == A)
    assert counts[A] == a["record_count"] == 1       # Texts = Records, one answer per record
    assert counts[A] <= sf["totals"]["coded_texts"]  # a real code's count fits its base


def test_the_word_counts_follow_the_answers(world):
    # The same subquery sums word_count, so "% Words" had the "N/A" answer's word too.
    src = _text_source(ca.get_source_frequencies(world, PID))
    assert src["code_counts"][str(A)]["word_count"] == 3     # "a real answer" only


def test_category_aggregation_pairs_too(world):
    sf = ca.get_source_frequencies(world, PID, aggregation="category")
    counts = {int(k): v["count"] for k, v in _text_source(sf)["code_counts"].items()}
    # Category C holds A; an uncategorised code is keyed by its negated id.
    assert counts == {CAT: 1, -U1: 1, -U0: 1}


# ── D79: a universal code's row has counts and no share of the coded total ───────────────


def test_a_universal_rows_segment_share_is_withheld_and_a_real_codes_is_not(world):
    rows = {f["code_id"]: f for f in
            ca.get_code_frequencies(world, PID, source="conversations")["frequencies"]}
    assert rows[U1]["segment_count"] == 2 and rows[U1]["segment_percentage"] is None
    assert rows[U0]["segment_percentage"] is None
    assert rows[A]["segment_percentage"] == 100.0    # s1, of 1 coded segment
    # Under the text source the segment arms are not read; a universal row still has no share.
    text_rows = {f["code_id"]: f for f in
                 ca.get_code_frequencies(world, PID, source="text")["frequencies"]}
    assert text_rows[U1]["segment_percentage"] is None
    assert text_rows[A]["segment_percentage"] == 0.0


REPO = Path(__file__).resolve().parents[2]


# ── D81: the never-read fields with the wrong base are gone, server and client ───────────


def test_the_deleted_fields_are_gone_from_the_payloads(world):
    r = ca.get_code_frequencies(world, PID, source="all")
    assert "total_rows" not in r
    assert not {"text_percentage", "row_percentage"} & set(r["frequencies"][0])
    assert "coded_text_count" not in RecordResponse.model_fields
    user = world.query(User).filter(User.id == 1).one()
    recs = list_records(project_id=PID, column_ids=str(T1), dataset_ids=None, hide_empty=True,
                        user=user, db=world)
    # Positive control: the endpoint still lists the four substantive answers' records.
    assert sorted(rec.dataset_row_id for rec in recs.records) == [15311, 15312, 15313, 15314]


def test_the_client_types_no_longer_declare_them():
    ca_ts = (REPO / "frontend/src/lib/api/code-analysis.ts").read_text(encoding="utf-8")
    tc_ts = (REPO / "frontend/src/lib/api/text-coding.ts").read_text(encoding="utf-8")
    for field in ("text_percentage", "row_percentage", "total_rows"):
        assert not re.search(rf"^\s*{field}\s*:", ca_ts, re.M), field
    assert not re.search(r"^\s*coded_text_count\s*:", tc_ts, re.M)
    # Positive control: the scan sees fields that are still declared.
    assert re.search(r"^\s*total_coded_texts\s*:", ca_ts, re.M)
    assert re.search(r"^\s*text_count\s*:", tc_ts, re.M)
