"""Tests for #351 + #352 — "coded segments" metric across surfaces
now consistently excludes facilitator turns (and excludes universal codes).

Before the fix:
- `routers/conversations.py:184-195` (per-conversation list) counted ALL coded
  segments (no speaker filter); coded a facilitator turn → gauge incremented.
- `routers/coding.py:309-339` (CodingWorkbench gauge) used participant-only
  counts that ignored facilitator turns.
- `routers/projects.py:316-322` (recent-conversations on overview) ALSO
  counted universal codes — a pre-existing bug (#352b in plan).

After the fix:
- All five surfaces (`conversations` list, `conversation_to_response`
  fallback, project summary `coded_segments`, recent-conversations on
  overview, single-conversation detail) apply the participant filter
  `(Speaker.is_facilitator == 0) | (Segment.speaker_id == None)` to BOTH
  numerator AND denominator queries. The CodingWorkbench gauge stays
  unchanged; counts now agree across surfaces.
- The recent-conversations batch also now respects `Code.is_universal == False`
  (the pre-existing bug fix).

This file regression-locks the new semantics. Document segments are
unaffected — their `speaker_id IS NULL` so the participant filter passes
them through unchanged.
"""
import asyncio
import pytest

from app.models.project import Project
from app.models.user import User
from app.models.conversation import Conversation
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.routers.conversations import list_conversations, conversation_to_response
from app.routers.projects import get_project_summary


def _run(coro):
    return asyncio.run(coro)


# ═══════════════════════════════════════════════════════════════════════════════
# Fixture: project with mixed-speaker conversation + coded segments
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def project_with_coded_facilitator_and_participant(db_session):
    """A project with one conversation containing:
    - 5 participant segments (3 coded with non-universal codes, 1 with universal)
    - 3 facilitator segments (2 coded with non-universal codes, 1 with universal)

    Expected post-fix counts (the new "participant-only + non-universal" semantics):
    - segment_count (denominator): 5  ← participant only
    - coded_segment_count (numerator): 3  ← non-universal coded participant segments

    Pre-fix would have been:
    - segment_count: 8 (all segments)
    - coded_segment_count: 5 (all coded segments, including 2 facilitator-coded
      AND including any with only-universal applications)
    """
    db = db_session
    db.add(Project(id=600, name="Coded Counts Test", user_id=1))
    db.flush()

    speaker_facilitator = Speaker(
        id=6000, project_id=600, name="Interviewer", is_facilitator=1, color_index=0,
    )
    speaker_participant = Speaker(
        id=6001, project_id=600, name="Respondent", is_facilitator=0, color_index=1,
    )
    db.add_all([speaker_facilitator, speaker_participant])

    conversation = Conversation(id=6000, project_id=600, name="Test Conv")
    db.add(conversation)
    db.flush()

    # 5 participant segments
    for i in range(5):
        db.add(Segment(
            id=6100 + i, conversation_id=6000, speaker_id=6001,
            sequence_order=i, text=f"Participant turn {i}", word_count=3,
        ))
    # 3 facilitator segments
    for i in range(3):
        db.add(Segment(
            id=6200 + i, conversation_id=6000, speaker_id=6000,
            sequence_order=5 + i, text=f"Facilitator prompt {i}", word_count=3,
        ))

    # Codes: 1 universal (numeric_id=0), 1 non-universal
    db.add_all([
        Code(id=6500, project_id=600, numeric_id=0, name="(uncoded)",
             is_universal=True, is_active=True),
        Code(id=6501, project_id=600, numeric_id=100, name="theme A",
             is_universal=False, is_active=True),
    ])
    db.flush()

    # Apply non-universal to 3 participant segments (6100, 6101, 6102)
    db.add_all([
        CodeApplication(segment_id=6100, code_id=6501, user_id=1),
        CodeApplication(segment_id=6101, code_id=6501, user_id=1),
        CodeApplication(segment_id=6102, code_id=6501, user_id=1),
    ])
    # Apply universal to 1 participant segment (6103) — should NOT count
    db.add(CodeApplication(segment_id=6103, code_id=6500, user_id=1))
    # Apply non-universal to 2 facilitator segments (6200, 6201) — should
    # NOT count under the new semantics
    db.add_all([
        CodeApplication(segment_id=6200, code_id=6501, user_id=1),
        CodeApplication(segment_id=6201, code_id=6501, user_id=1),
    ])
    # Apply universal to 1 facilitator segment (6202) — should NOT count either
    db.add(CodeApplication(segment_id=6202, code_id=6500, user_id=1))
    db.flush()

    user = db.query(User).filter(User.id == 1).one()
    return user


# ═══════════════════════════════════════════════════════════════════════════════
# /api/projects/{pid}/conversations (batch list endpoint)
# ═══════════════════════════════════════════════════════════════════════════════


def test_conversation_list_segment_count_excludes_facilitator(
    project_with_coded_facilitator_and_participant, db_session,
):
    """The list endpoint's denominator (segment_count) should be 5 — the
    5 participant turns — not 8 (all turns). #351/#352."""
    user = project_with_coded_facilitator_and_participant
    resp = _run(list_conversations(project_id=600, user=user, db=db_session))
    assert len(resp.conversations) == 1
    conv = resp.conversations[0]
    assert conv.segment_count == 5, (
        f"Expected 5 participant segments, got {conv.segment_count}. "
        f"The participant filter on the list batch query is missing or wrong."
    )


def test_conversation_list_coded_segment_count_excludes_facilitator(
    project_with_coded_facilitator_and_participant, db_session,
):
    """The list endpoint's numerator (coded_segment_count) should be 3 —
    the 3 participant turns coded with non-universal codes. The 2
    facilitator-coded turns + the participant turn with only a universal
    code MUST be excluded."""
    user = project_with_coded_facilitator_and_participant
    resp = _run(list_conversations(project_id=600, user=user, db=db_session))
    conv = resp.conversations[0]
    assert conv.coded_segment_count == 3, (
        f"Expected 3 coded participant segments (non-universal), got "
        f"{conv.coded_segment_count}. Either the participant filter or the "
        f"is_universal filter is missing from the coded_counts batch query."
    )


# ═══════════════════════════════════════════════════════════════════════════════
# conversation_to_response fallback (single-conversation detail)
# ═══════════════════════════════════════════════════════════════════════════════


def test_conversation_to_response_fallback_uses_participant_filter(
    project_with_coded_facilitator_and_participant, db_session,
):
    """When `segment_count`/`coded_segment_count` aren't pre-computed, the
    fallback inline queries in `conversation_to_response()` must apply the
    same participant filter so single-conversation detail matches list/overview."""
    db = db_session
    conv = db.query(Conversation).filter(Conversation.id == 6000).one()
    resp = conversation_to_response(conv, db)  # No pre-computed counts
    assert resp.segment_count == 5
    assert resp.coded_segment_count == 3


# ═══════════════════════════════════════════════════════════════════════════════
# Project summary (OverviewPage `coded_segments` stat tile + recent convs)
# ═══════════════════════════════════════════════════════════════════════════════


def test_project_summary_coded_segments_excludes_facilitator(
    project_with_coded_facilitator_and_participant, db_session,
):
    """OverviewPage stat tile reads `s.coded_segments` from the project
    summary. After fix it should report 3 (participant + non-universal),
    not 5 (all coded including facilitator)."""
    user = project_with_coded_facilitator_and_participant
    resp = _run(get_project_summary(project_id=600, user=user, db=db_session))
    assert resp.coded_segments == 3, (
        f"Project summary coded_segments should exclude facilitator + "
        f"universal codes. Got {resp.coded_segments}, expected 3."
    )


def test_project_summary_recent_conversations_excludes_facilitator(
    project_with_coded_facilitator_and_participant, db_session,
):
    """Recent-conversations card on OverviewPage. Same #351/#352 semantics."""
    user = project_with_coded_facilitator_and_participant
    resp = _run(get_project_summary(project_id=600, user=user, db=db_session))
    assert len(resp.recent_conversations) == 1
    rc = resp.recent_conversations[0]
    assert rc.segment_count == 5
    assert rc.coded_segment_count == 3


def test_project_summary_recent_conversations_excludes_universal_codes(
    project_with_coded_facilitator_and_participant, db_session,
):
    """Pre-existing bug fix in same PR: `projects.py:316-322` (recent-conv
    batch) was missing the `Code.is_universal == False` filter that the main
    conversations-list query has. After fix, coded_segment_count should equal
    the conversation_list endpoint's count for the same conversation.

    Concretely: participant 6103 has only a universal-code application →
    pre-fix this would have counted as "coded" on the recent-conversations
    card but NOT on the main conversations list. After fix, both show 3."""
    user = project_with_coded_facilitator_and_participant
    summary_resp = _run(get_project_summary(project_id=600, user=user, db=db_session))
    list_resp = _run(list_conversations(project_id=600, user=user, db=db_session))

    # Both surfaces must agree.
    assert summary_resp.recent_conversations[0].coded_segment_count == \
           list_resp.conversations[0].coded_segment_count
    # And both should be 3 (not 4 — universal-only application excluded).
    assert summary_resp.recent_conversations[0].coded_segment_count == 3


# ═══════════════════════════════════════════════════════════════════════════════
# Invariant: list endpoint and CodingWorkbench gauge agree
# ═══════════════════════════════════════════════════════════════════════════════


def test_list_endpoint_and_coding_progress_endpoint_agree(
    project_with_coded_facilitator_and_participant, db_session,
):
    """The whole point of #351/#352. The list endpoint's coded_segment_count
    must equal coding-progress's participant_coded value for the same
    conversation. Pre-fix: 5 vs 3 (asymmetric). Post-fix: 3 vs 3."""
    from app.routers.coding import get_coding_progress

    user = project_with_coded_facilitator_and_participant
    list_resp = _run(list_conversations(project_id=600, user=user, db=db_session))
    progress_resp = _run(get_coding_progress(conversation_id=6000, user=user, db=db_session))

    assert list_resp.conversations[0].coded_segment_count == progress_resp.participant_coded
    assert list_resp.conversations[0].segment_count == progress_resp.participant_segments


def test_segment_list_endpoint_agrees_with_coding_progress(
    project_with_coded_facilitator_and_participant, db_session,
):
    """The transcript segment-list endpoint (`segments.py::list_segments`)
    computes its own coded_count/participant_coded in a Python loop. It must
    apply the universal-code exclusion so it agrees with the coding-progress
    gauge (invariant J-A). Pre-fix the loop counted any application — the
    participant turn coded only with a universal marker (6103) inflated both
    coded_count and participant_coded."""
    from app.routers.coding import get_coding_progress
    from app.routers.segments import list_segments

    user = project_with_coded_facilitator_and_participant
    seg_resp = _run(list_segments(conversation_id=6000, user=user, db=db_session))
    progress_resp = _run(get_coding_progress(conversation_id=6000, user=user, db=db_session))

    # participant_coded must match the gauge (3, not 4 — universal-only excluded)
    assert seg_resp.participant_coded == progress_resp.participant_coded == 3
    # coded_count (all visible coded, non-universal, incl. facilitator) == 5
    # coded participant (3) + 2 facilitator coded with non-universal = 5
    assert seg_resp.coded_count == 5
    assert seg_resp.participant_total == progress_resp.participant_segments == 5


# ═══════════════════════════════════════════════════════════════════════════════
# Document segments unchanged (no facilitator to filter)
# ═══════════════════════════════════════════════════════════════════════════════


def test_document_segments_unchanged_no_facilitator_concept(db_session):
    """Documents have no facilitators — their segments have `speaker_id IS NULL`,
    so the participant filter passes them through unchanged. This regression-
    locks the invariant that the documents path stays a no-op under the new
    semantics (which it does because of the `OR speaker_id IS NULL` clause
    in the filter)."""
    from app.models.document import Document
    db = db_session
    db.add(Project(id=601, name="Doc test", user_id=1))
    db.flush()
    doc = Document(
        id=601, project_id=601, name="Notes",
        source_filename="notes.txt", source_format="txt",
    )
    db.add(doc)
    db.flush()
    # 3 document segments, no speaker
    for i in range(3):
        db.add(Segment(
            id=6300 + i, document_id=601, conversation_id=None,
            speaker_id=None, sequence_order=i,
            text=f"Doc paragraph {i}", word_count=3,
        ))
    db.add(Code(id=6701, project_id=601, numeric_id=100, name="theme",
                is_universal=False, is_active=True))
    db.flush()
    db.add_all([
        CodeApplication(segment_id=6300, code_id=6701, user_id=1),
        CodeApplication(segment_id=6301, code_id=6701, user_id=1),
    ])
    db.flush()

    # Document path queries don't go through conversation list, but the
    # underlying filter must accept speaker_id IS NULL segments. Verify by
    # counting how many would survive the same predicate.
    from sqlalchemy import func, or_
    count = (
        db.query(func.count(Segment.id))
        .outerjoin(Speaker, Speaker.id == Segment.speaker_id)
        .filter(
            Segment.document_id == 601,
            Segment.merged_into_id == None,
            Segment.split_into_id == None,
            or_(Speaker.is_facilitator == 0, Segment.speaker_id == None),
        )
        .scalar()
    )
    assert count == 3, (
        f"Document segments must pass the participant filter via `speaker_id "
        f"IS NULL`. Got {count}, expected 3."
    )
