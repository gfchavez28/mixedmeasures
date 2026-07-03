"""Track J · J1 item 4 — coder-awareness for qualitative-analysis output.

Asserts that the optional `coder_ids` filter scopes analysis numerators/denominators
to selected coders (None/empty = all coders = current behavior), is internally
consistent, and leaves the DISPLAY queries (chips of what codes are literally on a
unit) all-coder. Also covers the #400 fix to text-coding coverage (universal-only
codes no longer count) and its new per-coder breakdown.
"""
import asyncio

import pytest

from app.models.project import Project
from app.models.conversation import Conversation
from app.models.speaker import Speaker
from app.models.segment import Segment
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.user import User

from app.services.code_analysis import (
    get_code_frequencies,
    get_source_frequencies,
    get_segments_with_context,
)
from app.routers.text_coding import coding_progress


def _run(coro):
    return asyncio.run(coro)


# Fixed IDs
PROJECT_ID = 900
CONV_ID = 9000
DATASET_ID = 9100
TEXT_COL_ID = 9101
CODE_X = 9201          # non-universal
CODE_Y = 9202          # non-universal
CODE_UNIVERSAL = 9203  # universal — must never inflate coverage
CODER_A = 901
CODER_B = 902


@pytest.fixture
def two_coder_fixture(db_session):
    """Two coders, each applying a non-universal code to distinct + one shared unit,
    across BOTH a conversation (segments) and a text column (dataset values)."""
    db = db_session

    # Second + third users (User id=1 already exists from conftest)
    db.add_all([
        User(id=CODER_A, username="Coder A", display_color="#3b82f6"),
        User(id=CODER_B, username="Coder B", display_color="#ef4444"),
    ])

    project = Project(id=PROJECT_ID, name="Coder Filter Test", user_id=1)
    db.add(project)

    # ── Conversation with one participant speaker ──
    conv = Conversation(id=CONV_ID, project_id=PROJECT_ID, name="Interview 1")
    db.add(conv)
    speaker = Speaker(id=9300, name="Participant P", is_facilitator=0, project_id=PROJECT_ID)
    db.add(speaker)

    # 3 visible participant segments
    seg_a = Segment(id=9401, conversation_id=CONV_ID, speaker_id=9300, sequence_order=0,
                    text="Segment coded by A only.", word_count=4)
    seg_b = Segment(id=9402, conversation_id=CONV_ID, speaker_id=9300, sequence_order=1,
                    text="Segment coded by B only.", word_count=4)
    seg_shared = Segment(id=9403, conversation_id=CONV_ID, speaker_id=9300, sequence_order=2,
                         text="Segment coded by both A and B.", word_count=6)
    db.add_all([seg_a, seg_b, seg_shared])

    # ── Text column with dataset values ──
    dataset = Dataset(id=DATASET_ID, project_id=PROJECT_ID, name="Survey")
    db.add(dataset)
    text_col = DatasetColumn(
        id=TEXT_COL_ID, dataset_id=DATASET_ID, column_code="Q1",
        column_name="Q1", column_text="Open feedback",
        column_type="open_text", sequence_order=0, display_order=0,
    )
    db.add(text_col)

    # 3 non-empty values + 1 value carrying ONLY a universal code (the #400 trap)
    rows = []
    vals = {}
    for i, (rid, vid, text) in enumerate([
        (9501, 9601, "Text coded by A only."),
        (9502, 9602, "Text coded by B only."),
        (9503, 9603, "Text coded by both."),
        (9504, 9604, "Text with only a universal marker."),
    ]):
        row = DatasetRow(id=rid, dataset_id=DATASET_ID)
        db.add(row)
        rows.append(row)
        dv = DatasetValue(id=vid, row_id=rid, column_id=TEXT_COL_ID, value_text=text)
        db.add(dv)
        vals[vid] = dv

    # Codes
    db.add_all([
        Code(id=CODE_X, project_id=PROJECT_ID, name="Theme X", color="#FF0000",
             numeric_id=1, is_active=True, is_universal=False),
        Code(id=CODE_Y, project_id=PROJECT_ID, name="Theme Y", color="#00FF00",
             numeric_id=2, is_active=True, is_universal=False),
        Code(id=CODE_UNIVERSAL, project_id=PROJECT_ID, name="Unclear", color="#888888",
             numeric_id=0, is_active=True, is_universal=True),
    ])
    db.flush()

    # ── Conversation code applications ──
    # seg_a: Coder A → X ; seg_b: Coder B → X ; seg_shared: A→X and B→Y
    db.add_all([
        CodeApplication(id=9701, segment_id=9401, code_id=CODE_X, user_id=CODER_A),
        CodeApplication(id=9702, segment_id=9402, code_id=CODE_X, user_id=CODER_B),
        CodeApplication(id=9703, segment_id=9403, code_id=CODE_X, user_id=CODER_A),
        CodeApplication(id=9704, segment_id=9403, code_id=CODE_Y, user_id=CODER_B),
    ])

    # ── Text/value code applications (mirror structure) ──
    db.add_all([
        CodeApplication(id=9801, dataset_value_id=9601, code_id=CODE_X, user_id=CODER_A),
        CodeApplication(id=9802, dataset_value_id=9602, code_id=CODE_X, user_id=CODER_B),
        CodeApplication(id=9803, dataset_value_id=9603, code_id=CODE_X, user_id=CODER_A),
        CodeApplication(id=9804, dataset_value_id=9603, code_id=CODE_Y, user_id=CODER_B),
        # value 9604: ONLY a universal code, applied by Coder A → must NOT count as coded
        CodeApplication(id=9805, dataset_value_id=9604, code_id=CODE_UNIVERSAL, user_id=CODER_A),
    ])
    db.flush()

    return {"project_id": PROJECT_ID}


def _user():
    return User(id=1, username="testuser", is_admin=True)


# ── get_code_frequencies (conversations) ─────────────────────────────────────

def test_frequencies_none_equals_all_coders(two_coder_fixture, db_session):
    """coder_ids=None == filtering to both coders == the union."""
    pid = two_coder_fixture["project_id"]
    none_res = get_code_frequencies(db_session, pid, source="conversations")
    both_res = get_code_frequencies(db_session, pid, source="conversations",
                                    coder_ids=[CODER_A, CODER_B])

    def freq_map(res):
        return {f["code_id"]: f["segment_count"] for f in res["frequencies"]}

    assert freq_map(none_res) == freq_map(both_res)
    # X on seg_a + seg_b + seg_shared = 3 ; Y on seg_shared = 1
    assert freq_map(none_res)[CODE_X] == 3
    assert freq_map(none_res)[CODE_Y] == 1
    # total coded segments (non-universal) = seg_a, seg_b, seg_shared = 3
    assert none_res["total_coded_segments"] == 3


def test_frequencies_single_coder_scopes_counts(two_coder_fixture, db_session):
    """Filtering to one coder returns only that coder's contributions."""
    pid = two_coder_fixture["project_id"]
    a_res = get_code_frequencies(db_session, pid, source="conversations", coder_ids=[CODER_A])
    b_res = get_code_frequencies(db_session, pid, source="conversations", coder_ids=[CODER_B])

    a = {f["code_id"]: f["segment_count"] for f in a_res["frequencies"]}
    b = {f["code_id"]: f["segment_count"] for f in b_res["frequencies"]}

    # Coder A coded X on seg_a + seg_shared = 2 ; never coded Y
    assert a[CODE_X] == 2
    assert a[CODE_Y] == 0
    # Coder B coded X on seg_b = 1 ; Y on seg_shared = 1
    assert b[CODE_X] == 1
    assert b[CODE_Y] == 1
    # coded-segment denominators are coder-scoped: A coded 2 segments, B coded 2
    assert a_res["total_coded_segments"] == 2
    assert b_res["total_coded_segments"] == 2


def test_frequencies_single_coder_sums_to_union(two_coder_fixture, db_session):
    """Per-coder code counts are internally consistent with the all-coder result."""
    pid = two_coder_fixture["project_id"]
    all_res = get_code_frequencies(db_session, pid, source="conversations")
    a_res = get_code_frequencies(db_session, pid, source="conversations", coder_ids=[CODER_A])
    b_res = get_code_frequencies(db_session, pid, source="conversations", coder_ids=[CODER_B])

    def m(res):
        return {f["code_id"]: f["segment_count"] for f in res["frequencies"]}

    # No segment shares the same code applied by both coders here, so per-coder
    # counts sum to the all-coder count for each code.
    for cid in (CODE_X, CODE_Y):
        assert m(a_res)[cid] + m(b_res)[cid] == m(all_res)[cid]


# ── get_source_frequencies ───────────────────────────────────────────────────

def test_source_frequencies_none_equals_all(two_coder_fixture, db_session):
    pid = two_coder_fixture["project_id"]
    none_res = get_source_frequencies(db_session, pid)
    both_res = get_source_frequencies(db_session, pid, coder_ids=[CODER_A, CODER_B])
    assert none_res["totals"]["coded_segments"] == both_res["totals"]["coded_segments"]

    # conversation source coded_segments (non-universal) = 3
    conv_src = next(s for s in none_res["sources"] if s["source_type"] == "conversation")
    assert conv_src["coded_segments"] == 3
    # text column coded values (non-universal) = 3 (9601/9602/9603; the universal-only 9604 excluded)
    text_src = next(s for s in none_res["sources"] if s["source_type"] == "text_column")
    assert text_src["coded_segments"] == 3


def test_source_frequencies_single_coder_scopes(two_coder_fixture, db_session):
    pid = two_coder_fixture["project_id"]
    a_res = get_source_frequencies(db_session, pid, coder_ids=[CODER_A])
    b_res = get_source_frequencies(db_session, pid, coder_ids=[CODER_B])

    a_conv = next(s for s in a_res["sources"] if s["source_type"] == "conversation")
    b_conv = next(s for s in b_res["sources"] if s["source_type"] == "conversation")
    # A coded 2 segments, B coded 2 segments (universal-free here)
    assert a_conv["coded_segments"] == 2
    assert b_conv["coded_segments"] == 2

    a_text = next(s for s in a_res["sources"] if s["source_type"] == "text_column")
    b_text = next(s for s in b_res["sources"] if s["source_type"] == "text_column")
    # A coded values 9601 + 9603 (non-universal) = 2 ; the universal-only 9604 excluded
    assert a_text["coded_segments"] == 2
    # B coded values 9602 + 9603 = 2
    assert b_text["coded_segments"] == 2

    # per-code counts are coder-scoped
    a_x = a_conv["code_counts"].get(str(CODE_X), {}).get("count", 0)
    assert a_x == 2  # X on seg_a + seg_shared
    b_y = b_conv["code_counts"].get(str(CODE_Y), {}).get("count", 0)
    assert b_y == 1  # Y on seg_shared


# ── coding_progress (#400 fix + per-coder breakdown) ─────────────────────────

def test_coding_progress_excludes_universal_only(two_coder_fixture, db_session):
    """#400: a value coded ONLY with a universal marker must not count as coded."""
    pid = two_coder_fixture["project_id"]
    resp = _run(coding_progress(project_id=pid, column_ids=None, user=_user(), db=db_session))
    # 4 non-empty values; 3 carry a non-universal code; 9604 (universal-only) excluded.
    assert resp.overall_texts["total"] == 4
    assert resp.overall_texts["coded"] == 3
    assert resp.overall_records["total"] == 4
    assert resp.overall_records["coded"] == 3


def test_coding_progress_by_coder(two_coder_fixture, db_session):
    """Per-coder coverage uses the same non-universal rule; universal-only is excluded."""
    pid = two_coder_fixture["project_id"]
    resp = _run(coding_progress(project_id=pid, column_ids=None, user=_user(), db=db_session))
    by_coder = {c.user_id: c for c in resp.by_coder}

    # Both coders appear; the universal-only application (9805 by A) must NOT be counted.
    assert set(by_coder) == {CODER_A, CODER_B}
    # Coder A: non-universal text applications on 9601 + 9603 = 2 texts / 2 records.
    assert by_coder[CODER_A].coded_texts == 2
    assert by_coder[CODER_A].coded_records == 2
    # Coder B: non-universal text applications on 9602 + 9603 = 2 texts / 2 records.
    assert by_coder[CODER_B].coded_texts == 2
    assert by_coder[CODER_B].coded_records == 2


# ── display query must be coder-agnostic ─────────────────────────────────────

def test_display_codes_unchanged_by_coder_filter(two_coder_fixture, db_session):
    """get_segments_with_context's codes_by_seg chips show ALL coders' codes on a
    unit even when the focal finder is scoped to one coder."""
    pid = two_coder_fixture["project_id"]

    # Focal finder scoped to Coder B: seg_shared (9403) is found because B coded it (Y).
    res = get_segments_with_context(db_session, pid, code_id=CODE_Y, coder_ids=[CODER_B])
    seg_lookup = {}
    for conv in res["conversations"]:
        for seg in conv["segments"]:
            seg_lookup[seg["id"]] = seg

    assert 9403 in seg_lookup, "seg_shared should be a focal segment for code Y / Coder B"
    # The chips on seg_shared must include BOTH Coder A's X and Coder B's Y —
    # the display query is all-coder, unaffected by coder_ids.
    chips = set(seg_lookup[9403]["applied_code_ids"])
    assert chips == {CODE_X, CODE_Y}, (
        f"display chips should show all coders' codes, got {chips}"
    )
