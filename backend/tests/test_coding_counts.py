"""Invariant J-A regression guard — the "coded segment" count agrees across every
surface, and the document path applies the universal-code exclusion (#398).

Context: the quantity "coded participant segments" was historically re-derived by
≥5 hand-written query sites kept aligned by comments (the #211→#218→#351→#352
chain). The document surfaces silently OMITTED the universal-code exclusion the
conversation surfaces applied — a document segment coded ONLY with a universal
marker ("Unclear"/"Unsubstantive") counted as coded on the documents list /
detail / overview, while the conversation equivalent did not. Confirmed live on
dev.db (document 1, segment 2108, coded only with "Unclear": documents path
reported 1, conversation definition reported 0).

The fix centralized all sites behind `services/coding_counts.py`. This file is
the structural guard the seam-2 dossier asked for: it asserts the document coded
count (a) excludes universal-only / soft-deleted segments and (b) AGREES across
the list, detail, update-response, and overview surfaces. The conversation
surfaces are covered by `test_coded_counts_participant_only.py`; here we add the
document path + the cross-surface agreement that no prior test asserted.
"""
import asyncio

import pytest

from app.models.project import Project
from app.models.user import User
from app.models.document import Document
from app.models.segment import Segment
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.routers.documents import list_documents, get_document
from app.routers.projects import get_project_summary
from app.services.coding_counts import coded_segment_count


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def project_with_coded_document(db_session):
    """One document whose segments exercise all three coded-count dimensions:

    - seg A (6400): non-universal code            → COUNTS
    - seg B (6401): universal code ONLY            → must NOT count (#398)
    - seg C (6402): universal AND non-universal    → COUNTS (one distinct segment)
    - seg D (6403): uncoded                        → does not count
    - seg E (6404): merged (soft-deleted) + coded  → must NOT count (visibility)

    Expected coded count for the document: 2 (A and C).
    """
    db = db_session
    db.add(Project(id=620, name="Doc Coded Counts", user_id=1))
    db.flush()

    doc = Document(
        id=620, project_id=620, name="Field notes",
        source_filename="notes.txt", source_format="txt",
    )
    db.add(doc)
    db.flush()

    for i in range(5):
        db.add(Segment(
            id=6400 + i, document_id=620, conversation_id=None,
            speaker_id=None, sequence_order=i,
            text=f"Paragraph {i}", word_count=3,
            # seg E (6404) is soft-deleted via merge
            merged_into_id=(6400 if i == 4 else None),
            is_merge_result=False,
        ))

    db.add_all([
        Code(id=6800, project_id=620, numeric_id=0, name="Unclear",
             is_universal=True, is_active=True),
        Code(id=6801, project_id=620, numeric_id=100, name="theme A",
             is_universal=False, is_active=True),
    ])
    db.flush()

    db.add_all([
        CodeApplication(segment_id=6400, code_id=6801, user_id=1),   # A: non-universal
        CodeApplication(segment_id=6401, code_id=6800, user_id=1),   # B: universal only
        CodeApplication(segment_id=6402, code_id=6800, user_id=1),   # C: both...
        CodeApplication(segment_id=6402, code_id=6801, user_id=1),   # ...universal + non-univ
        CodeApplication(segment_id=6404, code_id=6801, user_id=1),   # E: coded but merged
    ])
    db.flush()

    return db.query(User).filter(User.id == 1).one()


EXPECTED_DOC_CODED = 2


# ── helper-level definition ────────────────────────────────────────────────


def test_helper_excludes_universal_only_and_softdeleted(
    project_with_coded_document, db_session,
):
    """The shared helper is the single definition: universal-only (#398) and
    soft-deleted segments don't count; a segment with mixed codes counts once."""
    n = coded_segment_count(
        db_session, Segment.document_id, 620, participant_only=False
    )
    assert n == EXPECTED_DOC_CODED, (
        f"Expected {EXPECTED_DOC_CODED} coded document segments "
        f"(non-universal, visible), got {n}."
    )


def test_helper_participant_dim_is_noop_for_documents(
    project_with_coded_document, db_session,
):
    """Documents have no speaker, so participant_only must not change the count
    (the dimension is satisfied via `speaker_id IS NULL`)."""
    only_false = coded_segment_count(
        db_session, Segment.document_id, 620, participant_only=False
    )
    only_true = coded_segment_count(
        db_session, Segment.document_id, 620, participant_only=True
    )
    assert only_false == only_true == EXPECTED_DOC_CODED


# ── #398 regression: universal-only does not count on document surfaces ─────


def test_documents_list_excludes_universal_only(
    project_with_coded_document, db_session,
):
    user = project_with_coded_document
    docs = _run(list_documents(project_id=620, user=user, db=db_session))
    assert len(docs) == 1
    assert docs[0].coded_segment_count == EXPECTED_DOC_CODED, (
        "documents list coded count must exclude the universal-only segment (#398)."
    )


def test_document_detail_excludes_universal_only(
    project_with_coded_document, db_session,
):
    user = project_with_coded_document
    detail = _run(get_document(project_id=620, document_id=620, user=user, db=db_session))
    assert detail.coded_segment_count == EXPECTED_DOC_CODED


def test_document_detail_codes_carry_is_universal(
    project_with_coded_document, db_session,
):
    """The detail response must expose `is_universal` per code so the coding
    workbench can compute its client-side coded count consistently with the
    backend (the #398 follow-up: workbench showed 4/14 vs backend 2/14 because
    it counted any-code and couldn't tell universal apart)."""
    user = project_with_coded_document
    detail = _run(get_document(project_id=620, document_id=620, user=user, db=db_session))
    by_seg = {s.id: s for s in detail.segments}
    # seg 6400: non-universal code → is_universal False
    assert by_seg[6400].codes[0].is_universal is False
    # seg 6401: universal-only → is_universal True (so the workbench excludes it)
    assert by_seg[6401].codes[0].is_universal is True
    # client-side definition (≥1 non-universal) must match the backend count
    coded_client = sum(
        1 for s in detail.segments if any(not c.is_universal for c in s.codes)
    )
    assert coded_client == detail.coded_segment_count == EXPECTED_DOC_CODED


# ── J-A cross-surface agreement (the structural guard) ──────────────────────


def test_all_document_surfaces_agree(project_with_coded_document, db_session):
    """list / detail / overview-recent / overview-total / helper must all report
    the same coded count for the same document — the agreement the comments
    promised but no test asserted."""
    user = project_with_coded_document

    helper = coded_segment_count(
        db_session, Segment.document_id, 620, participant_only=False
    )
    list_count = _run(
        list_documents(project_id=620, user=user, db=db_session)
    )[0].coded_segment_count
    detail_count = _run(
        get_document(project_id=620, document_id=620, user=user, db=db_session)
    ).coded_segment_count

    summary = _run(get_project_summary(project_id=620, user=user, db=db_session))
    recent_count = next(
        d.coded_segment_count for d in summary.recent_documents if d.id == 620
    )
    # No conversations in this project, so the overview total == the doc total.
    overview_total = summary.coded_segments

    counts = {
        "helper": helper,
        "list": list_count,
        "detail": detail_count,
        "overview_recent": recent_count,
        "overview_total": overview_total,
    }
    assert set(counts.values()) == {EXPECTED_DOC_CODED}, (
        f"Document coded-count surfaces disagree (invariant J-A): {counts}"
    )
