"""Integration tests for `source` parameter routing in code_analysis services.

Regression guard for #344: frontend sends `source="text"` but backend services
historically only matched `source="comments"`. The bug surfaces silently — Pydantic
defaults mask missing data — so service-level direct-call tests must assert on
returned values, not just response structure.
"""
import pytest
from app.models.project import Project
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.services.code_analysis import (
    get_code_frequencies,
    build_code_cooccurrence_matrix,
)


@pytest.fixture
def mixed_source_fixture(db_session):
    """Project with BOTH conversation segments AND text-column values, all coded.

    Layout:
    - 1 conversation, 3 segments, all coded with code_id=1 (Vision)
    - 1 dataset, 1 text column, 4 rows; rows 0,1,2 coded with code_id=1, row 3 uncoded
    - Code 1 appears on 3 segments AND 3 text values

    Lets us distinguish source="conversations" (segments only),
    source="text" (text values only), source="all" (merged).
    """
    db = db_session
    project = Project(id=400, name="Source Routing Test", user_id=1)
    db.add(project)

    conv = Conversation(id=400, name="Interview", project_id=400)
    db.add(conv)

    code = Code(id=601, project_id=400, name="Vision", color="#FF0000",
                numeric_id=1, is_active=True, is_universal=False)
    db.add(code)
    db.flush()

    # 3 conversation segments
    for i in range(3):
        seg = Segment(
            id=600 + i, conversation_id=400, document_id=None, speaker_id=None,
            sequence_order=i, text=f"Segment {i} text",
            merged_into_id=None, is_merge_result=0,
            split_into_id=None, is_split_result=0,
        )
        db.add(seg)
    db.flush()

    for i in range(3):
        db.add(CodeApplication(id=700 + i, segment_id=600 + i, code_id=601))

    # Dataset + 1 text column + 4 rows
    dataset = Dataset(id=400, project_id=400, name="Survey")
    db.add(dataset)
    text_col = DatasetColumn(
        id=4001, dataset_id=400, column_code="Q1",
        column_name="Q1", column_text="Open feedback",
        column_type="open_text", sequence_order=0, display_order=0,
    )
    db.add(text_col)
    db.flush()

    for i in range(4):
        row = DatasetRow(id=8400 + i, dataset_id=400)
        db.add(row)
        dv = DatasetValue(
            id=84000 + i, row_id=row.id, column_id=4001,
            value_text=f"Text value {i}",
        )
        db.add(dv)
    db.flush()

    # Code rows 0,1,2 (row 3 uncoded)
    for i in range(3):
        db.add(CodeApplication(id=800 + i, dataset_value_id=84000 + i, code_id=601))
    db.flush()

    return {"project_id": 400, "code_id": 601, "column_id": 4001}


# ── source="text" must hit the text branch (regression guard for #344) ───

def test_frequencies_source_text_returns_text_data(mixed_source_fixture, db_session):
    """source='text' returns text counts > 0 (the fix)."""
    f = mixed_source_fixture
    result = get_code_frequencies(
        db_session, project_id=f["project_id"], source="text",
    )

    # Must have text data
    assert result["total_coded_texts"] > 0, \
        "BUG #344: source='text' returned empty text data"
    assert result["total_rows"] > 0

    # Must NOT have segment data (text-only filter)
    assert result["total_coded_segments"] == 0
    assert result["total_conversations"] == 0

    # Per-code: text_count populated, segment_count zero
    code_freq = next(fr for fr in result["frequencies"] if fr["code_id"] == f["code_id"])
    assert code_freq["text_count"] == 3  # 3 coded text values
    assert code_freq["row_count"] == 3
    assert code_freq["segment_count"] == 0


def test_frequencies_source_comments_alias(mixed_source_fixture, db_session):
    """source='comments' is the historical name; service must still match
    (router-layer alias coerces it before passing through)."""
    f = mixed_source_fixture
    result_comments = get_code_frequencies(
        db_session, project_id=f["project_id"], source="comments",
    )
    result_text = get_code_frequencies(
        db_session, project_id=f["project_id"], source="text",
    )

    # After fix, both should match the text-data branch and return the same result
    assert result_comments["total_coded_texts"] == result_text["total_coded_texts"]
    assert result_comments["total_coded_segments"] == result_text["total_coded_segments"]


def test_frequencies_source_conversations_unchanged(mixed_source_fixture, db_session):
    """Regression guard: source='conversations' still returns segment data only."""
    f = mixed_source_fixture
    result = get_code_frequencies(
        db_session, project_id=f["project_id"], source="conversations",
    )

    assert result["total_coded_segments"] == 3
    assert result["total_coded_texts"] == 0


def test_frequencies_source_all_merges(mixed_source_fixture, db_session):
    """Regression guard: source='all' includes both segments and texts."""
    f = mixed_source_fixture
    result = get_code_frequencies(
        db_session, project_id=f["project_id"], source="all",
    )

    assert result["total_coded_segments"] == 3
    assert result["total_coded_texts"] == 3


# ── Cooccurrence: source="text" must NOT fall through to "all" merge ─────

def test_cooccurrence_source_text_isolates_text_only(mixed_source_fixture, db_session):
    """BEFORE fix: build_code_cooccurrence_matrix with source='text' fell through
    the if/elif into the else 'all' branch, returning merged data labeled as
    text-only. This is incorrect-data, not just empty.

    AFTER fix: source='text' returns text-only counts."""
    f = mixed_source_fixture
    cooccur, total_units, conv_total, text_total, doc_total = \
        build_code_cooccurrence_matrix(
            db_session, project_id=f["project_id"], source="text",
        )

    # Text-only: conv_total and doc_total must be 0
    assert conv_total == 0, \
        "BUG #344: source='text' fell through to 'all' branch, merged conversations"
    assert doc_total == 0
    assert text_total == 3
    assert total_units == 3


def test_cooccurrence_source_comments_alias(mixed_source_fixture, db_session):
    """source='comments' (legacy) returns same as source='text' after alias."""
    f = mixed_source_fixture
    co_comments = build_code_cooccurrence_matrix(
        db_session, project_id=f["project_id"], source="comments",
    )
    co_text = build_code_cooccurrence_matrix(
        db_session, project_id=f["project_id"], source="text",
    )

    # cooccur dict + totals should match
    assert co_comments[1] == co_text[1]  # total_units
    assert co_comments[2] == co_text[2]  # conv_total
    assert co_comments[3] == co_text[3]  # text_total


def test_cooccurrence_source_conversations_unchanged(mixed_source_fixture, db_session):
    """Regression guard."""
    f = mixed_source_fixture
    _, total_units, conv_total, text_total, _ = build_code_cooccurrence_matrix(
        db_session, project_id=f["project_id"], source="conversations",
    )
    assert text_total == 0
    assert conv_total == 3
