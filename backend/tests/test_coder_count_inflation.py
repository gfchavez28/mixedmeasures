"""Track J · J2-2a — count surfaces de-duplicate across coders.

As of J2-1, two different coders can apply the SAME code to the SAME target
(segment or dataset value) — two `CodeApplication` rows. Any aggregation that
did a raw `COUNT(*)` / `COUNT(CodeApplication.id)` now silently MULTIPLIES by
the number of coders. These tests lock the DISTINCT-target fix across the
"usage count / N uses" surfaces:

  - `routers/codes.py` usage_count (single + batch + categorized),
  - `routers/codebook.py` codebook-tree `segment_count`,
  - `services/text_analysis.py` comment-frequency count/percentage.

Every assertion is also an exact no-op for single-coder data (one row per
(target, code) → COUNT == COUNT DISTINCT), so the existing single-layer suites
stay green.

NOT covered here (deliberately deferred): the `code_analysis.py`
`get_source_frequencies` per-source counts, whose companion `SUM(word_count)`
ALSO inflates per coder and needs a distinct-segment subquery restructure — a
separate, carefully-tested sub-step.
"""
import asyncio

from app.models.project import Project
from app.models.user import User
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.code import Code
from app.models.code_application import CodeApplication

from app.routers.codes import code_to_response, list_codes
from app.routers.codebook import get_codebook_tree
from app.services.text_analysis import compute_comment_frequencies
from app.services.coding_counts import coded_segment_count
from app.services.coding_layers import CONSENSUS_ORIGIN
from app.services.code_analysis import (
    get_source_frequencies,
    get_code_frequencies,
    get_text_columns_with_coding,
)
from app.routers.export_helpers import build_code_conversation_matrix


def _run(coro):
    return asyncio.run(coro)


def _add_coder_b(db):
    user_b = User(id=2, username="Coder B", password_hash=None)
    db.add(user_b)
    db.flush()
    return user_b


def test_usage_count_distinct_across_coders(db_session):
    """A code applied by TWO coders to the same segment AND the same dataset
    value = 2 distinct targets (1 segment + 1 value), NOT 4 raw rows."""
    db = db_session
    _add_coder_b(db)
    db.add_all([
        Project(id=920, name="Usage", user_id=1),
        Conversation(id=920, project_id=920, name="C1"),
        Segment(id=9200, conversation_id=920, sequence_order=0, text="hi"),
        Dataset(id=920, project_id=920, name="Survey"),
        DatasetColumn(id=9201, dataset_id=920, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9202, dataset_id=920),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=92020, row_id=9202, column_id=9201, value_text="alpha"),
        Code(id=9210, project_id=920, name="Shared", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
        # A code only coder A touches, on two distinct segments — single-coder
        # no-op sanity (distinct == raw).
        Code(id=9211, project_id=920, name="Solo", color="#222222",
             numeric_id=3, is_active=True, is_universal=False),
        Segment(id=9203, conversation_id=920, sequence_order=1, text="bye"),
    ])
    db.flush()
    db.add_all([
        # Shared code: both coders, same segment + same value (would be 4 raw rows).
        CodeApplication(segment_id=9200, code_id=9210, user_id=1),
        CodeApplication(segment_id=9200, code_id=9210, user_id=2),
        CodeApplication(dataset_value_id=92020, code_id=9210, user_id=1),
        CodeApplication(dataset_value_id=92020, code_id=9210, user_id=2),
        # Solo code: coder A on two distinct segments.
        CodeApplication(segment_id=9200, code_id=9211, user_id=1),
        CodeApplication(segment_id=9203, code_id=9211, user_id=1),
    ])
    db.flush()

    shared = code_to_response(db.get(Code, 9210), db)
    solo = code_to_response(db.get(Code, 9211), db)
    assert shared.usage_count == 2, "1 distinct segment + 1 distinct value, not 4 rows"
    assert solo.usage_count == 2, "single-coder count is unchanged (2 distinct segments)"


def test_list_codes_batch_usage_count_distinct(db_session):
    """The batched usage_count in the list endpoint dedupes across coders too."""
    db = db_session
    user_a = db.get(User, 1)
    _add_coder_b(db)
    db.add_all([
        Project(id=921, name="List Usage", user_id=1),
        Conversation(id=921, project_id=921, name="C1"),
        Segment(id=9210, conversation_id=921, sequence_order=0, text="hi"),
        Code(id=9215, project_id=921, name="Shared", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9210, code_id=9215, user_id=1),
        CodeApplication(segment_id=9210, code_id=9215, user_id=2),
    ])
    db.flush()

    # Pass the Query-defaulted params explicitly (FastAPI doesn't resolve
    # dependency defaults on a direct call).
    resp = _run(list_codes(921, include_inactive=False, category_id=None,
                           user=user_a, db=db))
    by_id = {c.id: c for c in resp.codes}
    assert by_id[9215].usage_count == 1, "one coded segment, not one-per-coder"


def test_codebook_tree_segment_count_distinct(db_session):
    """Codebook-tree segment_count counts distinct coded segments, not rows."""
    db = db_session
    user_a = db.get(User, 1)
    _add_coder_b(db)
    db.add_all([
        Project(id=922, name="Tree", user_id=1),
        Conversation(id=922, project_id=922, name="C1"),
        # speaker_id=None → survives the default exclude_facilitator filter.
        Segment(id=9220, conversation_id=922, sequence_order=0, text="hi"),
        Code(id=9225, project_id=922, name="Shared", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9220, code_id=9225, user_id=1),
        CodeApplication(segment_id=9220, code_id=9225, user_id=2),
    ])
    db.flush()

    tree = _run(get_codebook_tree(
        922, conversation_ids=None, text_column_ids=None, exclude_facilitator=True,
        include_inactive=False, min_segments=None, max_segments=None,
        user=user_a, db=db,
    ))
    node = {n.id: n for n in tree.uncategorized_codes}[9225]
    assert node.segment_count == 1, "one coded segment, not one-per-coder"


def test_comment_frequencies_distinct_across_coders(db_session):
    """Comment frequency counts distinct coded values; percentage stays ≤ 100%."""
    db = db_session
    _add_coder_b(db)
    db.add_all([
        Project(id=923, name="Freq", user_id=1),
        Dataset(id=923, project_id=923, name="Survey"),
        DatasetColumn(id=9230, dataset_id=923, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9231, dataset_id=923),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=92310, row_id=9231, column_id=9230, value_text="alpha"),
        Code(id=9235, project_id=923, name="Shared", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(dataset_value_id=92310, code_id=9235, user_id=1),
        CodeApplication(dataset_value_id=92310, code_id=9235, user_id=2),
    ])
    db.flush()

    res = compute_comment_frequencies(db, 923, column_ids=[9230])
    freq = {f["code_id"]: f for f in res["frequencies"]}[9235]
    assert freq["count"] == 1, "one coded comment, not one-per-coder"
    assert freq["percentage"] == 100.0, "1 of 1 comment — must not exceed 100%"


# ═══════════════════════════════════════════════════════════════════════════
# Track J · J2-2b — count surfaces EXCLUDE the derived consensus layer (J2-B).
#   Consensus applications (origin='consensus') are auto-generated from the
#   human layers; counting them in an all-coder aggregate double-counts. Every
#   human-layer count excludes them by default. (No-op until J2-3 creates such
#   rows; these tests insert one manually to lock the guard now.)
# ═══════════════════════════════════════════════════════════════════════════


def test_usage_count_excludes_consensus_layer(db_session):
    """usage_count counts only real coder layers, never the consensus layer."""
    db = db_session
    db.add_all([
        Project(id=930, name="Consensus Usage", user_id=1),
        Conversation(id=930, project_id=930, name="C1"),
        Segment(id=9300, conversation_id=930, sequence_order=0, text="human"),
        Segment(id=9301, conversation_id=930, sequence_order=1, text="consensus only"),
        Code(id=9305, project_id=930, name="Theme", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9300, code_id=9305, user_id=1),  # human layer
        # Consensus applied the code to a DIFFERENT (consensus-only) segment.
        CodeApplication(segment_id=9301, code_id=9305, user_id=1, origin=CONSENSUS_ORIGIN),
    ])
    db.flush()

    resp = code_to_response(db.get(Code, 9305), db)
    assert resp.usage_count == 1, "consensus-only target must not inflate usage_count"


def test_coded_segment_count_excludes_consensus_layer(db_session):
    """A segment coded ONLY by consensus is not 'coded' for human progress."""
    db = db_session
    db.add_all([
        Project(id=931, name="Consensus Coded", user_id=1),
        Conversation(id=931, project_id=931, name="C1"),
        Segment(id=9310, conversation_id=931, sequence_order=0, text="human"),
        Segment(id=9311, conversation_id=931, sequence_order=1, text="consensus only"),
        Code(id=9315, project_id=931, name="Theme", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9310, code_id=9315, user_id=1),
        CodeApplication(segment_id=9311, code_id=9315, user_id=1, origin=CONSENSUS_ORIGIN),
    ])
    db.flush()

    count = coded_segment_count(db, Segment.conversation_id, 931)
    assert count == 1, "only the human-coded segment counts, not the consensus-only one"


def test_codebook_tree_segment_count_excludes_consensus_layer(db_session):
    """Codebook-tree segment_count excludes the consensus layer by default."""
    db = db_session
    user_a = db.get(User, 1)
    db.add_all([
        Project(id=932, name="Consensus Tree", user_id=1),
        Conversation(id=932, project_id=932, name="C1"),
        Segment(id=9320, conversation_id=932, sequence_order=0, text="human"),
        Segment(id=9321, conversation_id=932, sequence_order=1, text="consensus only"),
        Code(id=9325, project_id=932, name="Theme", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9320, code_id=9325, user_id=1),
        CodeApplication(segment_id=9321, code_id=9325, user_id=1, origin=CONSENSUS_ORIGIN),
    ])
    db.flush()

    tree = _run(get_codebook_tree(
        932, conversation_ids=None, text_column_ids=None, exclude_facilitator=True,
        include_inactive=False, min_segments=None, max_segments=None,
        user=user_a, db=db,
    ))
    node = {n.id: n for n in tree.uncategorized_codes}[9325]
    assert node.segment_count == 1, "consensus-only segment excluded from the tree count"


def test_comment_frequencies_exclude_consensus_layer(db_session):
    """Comment frequency counts exclude the consensus layer."""
    db = db_session
    db.add_all([
        Project(id=933, name="Consensus Freq", user_id=1),
        Dataset(id=933, project_id=933, name="Survey"),
        DatasetColumn(id=9330, dataset_id=933, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9331, dataset_id=933),
        DatasetRow(id=9332, dataset_id=933),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=93310, row_id=9331, column_id=9330, value_text="human"),
        DatasetValue(id=93320, row_id=9332, column_id=9330, value_text="consensus only"),
        Code(id=9335, project_id=933, name="Theme", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(dataset_value_id=93310, code_id=9335, user_id=1),
        CodeApplication(dataset_value_id=93320, code_id=9335, user_id=1, origin=CONSENSUS_ORIGIN),
    ])
    db.flush()

    res = compute_comment_frequencies(db, 933, column_ids=[9330])
    freq = {f["code_id"]: f for f in res["frequencies"]}[9335]
    assert freq["count"] == 1, "consensus-only comment excluded from the frequency count"


# ═══════════════════════════════════════════════════════════════════════════
# Track J · J2-2c — source-frequency count AND word_count de-duplicate across
#   coders. get_source_frequencies' per-(source, code) count was a raw
#   COUNT(CodeApplication.id) and its companion SUM(word_count) summed over the
#   joined rows — BOTH inflate per coder. Restructured to a DISTINCT
#   (source, code, segment) subquery before count/sum.
# ═══════════════════════════════════════════════════════════════════════════


def _conv_source(res, conv_id):
    return [s for s in res["sources"]
            if s["source_type"] == "conversation" and s["source_id"] == conv_id][0]


def test_source_frequencies_count_and_wordcount_distinct_across_coders(db_session):
    """Two coders on one segment must not inflate the per-code count OR the
    word_count sum for that source."""
    db = db_session
    _add_coder_b(db)
    db.add_all([
        Project(id=940, name="SrcFreq", user_id=1),
        Conversation(id=940, project_id=940, name="C1"),
        Segment(id=9400, conversation_id=940, sequence_order=0, text="seg one", word_count=10),
        Segment(id=9401, conversation_id=940, sequence_order=1, text="seg two", word_count=20),
        Code(id=9405, project_id=940, name="Theme", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9400, code_id=9405, user_id=1),
        CodeApplication(segment_id=9400, code_id=9405, user_id=2),  # 2nd coder, SAME segment
        CodeApplication(segment_id=9401, code_id=9405, user_id=1),
    ])
    db.flush()

    cc = _conv_source(get_source_frequencies(db, 940), 940)["code_counts"][str(9405)]
    assert cc["count"] == 2, "2 distinct coded segments, not 3 raw rows"
    assert cc["word_count"] == 30, "sum over DISTINCT segments (10+20), not doubled (40)"


def test_source_frequencies_exclude_consensus_layer(db_session):
    """Consensus-only coding contributes neither count nor word_count."""
    db = db_session
    db.add_all([
        Project(id=941, name="SrcFreq Consensus", user_id=1),
        Conversation(id=941, project_id=941, name="C1"),
        Segment(id=9410, conversation_id=941, sequence_order=0, text="human", word_count=10),
        Segment(id=9411, conversation_id=941, sequence_order=1, text="consensus", word_count=20),
        Code(id=9415, project_id=941, name="Theme", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9410, code_id=9415, user_id=1),
        CodeApplication(segment_id=9411, code_id=9415, user_id=1, origin=CONSENSUS_ORIGIN),
    ])
    db.flush()

    cc = _conv_source(get_source_frequencies(db, 941), 941)["code_counts"][str(9415)]
    assert cc["count"] == 1, "consensus-only segment excluded from the count"
    assert cc["word_count"] == 10, "consensus segment's words excluded from the sum"


# ═══════════════════════════════════════════════════════════════════════════
# Track J · J2-2d — the REMAINING count surfaces exclude consensus too. The
#   guard is single-sourced into `_coder_filter` (every code_analysis aggregate)
#   + explicit on the non-coder-aware surfaces (text-column coding, exports).
# ═══════════════════════════════════════════════════════════════════════════


def test_get_code_frequencies_excludes_consensus(db_session):
    """The main frequency analysis (via _coder_filter) excludes consensus."""
    db = db_session
    db.add_all([
        Project(id=950, name="Freq Consensus", user_id=1),
        Conversation(id=950, project_id=950, name="C1"),
        Segment(id=9500, conversation_id=950, sequence_order=0, text="human"),
        Segment(id=9501, conversation_id=950, sequence_order=1, text="consensus"),
        Code(id=9505, project_id=950, name="Theme", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9500, code_id=9505, user_id=1),
        CodeApplication(segment_id=9501, code_id=9505, user_id=1, origin=CONSENSUS_ORIGIN),
    ])
    db.flush()

    res = get_code_frequencies(db, 950, source="conversations")
    freq = {f["code_id"]: f for f in res["frequencies"]}[9505]
    assert freq["segment_count"] == 1, "consensus-only segment excluded from the frequency"


def test_get_text_columns_with_coding_distinct_and_consensus(db_session):
    """coded_count = distinct coded values, human layer only."""
    db = db_session
    _add_coder_b(db)
    db.add_all([
        Project(id=951, name="TextCols", user_id=1),
        Dataset(id=951, project_id=951, name="Survey"),
        DatasetColumn(id=9510, dataset_id=951, column_code="Q", column_name="Q",
                      column_text="Open", column_type="open_text",
                      sequence_order=0, display_order=0),
        DatasetRow(id=9511, dataset_id=951),
        DatasetRow(id=9512, dataset_id=951),
    ])
    db.flush()
    db.add_all([
        DatasetValue(id=95110, row_id=9511, column_id=9510, value_text="human"),
        DatasetValue(id=95120, row_id=9512, column_id=9510, value_text="consensus"),
        Code(id=9515, project_id=951, name="Theme", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        # two coders on the SAME value (per-coder inflation) + a consensus-only value
        CodeApplication(dataset_value_id=95110, code_id=9515, user_id=1),
        CodeApplication(dataset_value_id=95110, code_id=9515, user_id=2),
        CodeApplication(dataset_value_id=95120, code_id=9515, user_id=1, origin=CONSENSUS_ORIGIN),
    ])
    db.flush()

    cols = {c["column_id"]: c for c in get_text_columns_with_coding(db, 951)}
    assert cols[9510]["coded_count"] == 1, "1 distinct human-coded value (not 2 rows, not the consensus value)"


def test_build_code_conversation_matrix_distinct_and_consensus(db_session):
    """The export conversation×code matrix counts distinct human-coded segments."""
    db = db_session
    _add_coder_b(db)
    db.add_all([
        Project(id=952, name="Matrix", user_id=1),
        Conversation(id=952, project_id=952, name="C1"),
        Segment(id=9520, conversation_id=952, sequence_order=0, text="human"),
        Segment(id=9521, conversation_id=952, sequence_order=1, text="consensus"),
        Code(id=9525, project_id=952, name="Theme", color="#111111",
             numeric_id=2, is_active=True, is_universal=False),
    ])
    db.flush()
    db.add_all([
        CodeApplication(segment_id=9520, code_id=9525, user_id=1),
        CodeApplication(segment_id=9520, code_id=9525, user_id=2),  # 2nd coder, same segment
        CodeApplication(segment_id=9521, code_id=9525, user_id=1, origin=CONSENSUS_ORIGIN),
    ])
    db.flush()

    matrix = build_code_conversation_matrix(db, 952)
    assert matrix[(952, 9525)] == 1, "1 distinct human-coded segment (not 2 rows, not consensus)"
