"""Row 46 — `Document.participant_id`, and what joins to it.

Documents were the one coded source type with no route to a `Participant`:
conversations reach it through `Speaker.participant_id`, survey responses through
`DatasetRow.participant_id`, and a document segment has no speaker. So nothing
coded on a document could be compared by its subject's attributes — the whole
point of the row.

The four things this pins, each of which was a separate way to ship it broken:

1. **The grain.** A conversation's subject is per-SEGMENT (each turn has a
   speaker), so one conversation splits across groups; a document's subject is
   per-DOCUMENT, so a linked one lands wholly in one group. Getting this wrong
   silently produces a plausible number.
2. **The ownership gate.** `update_document` applies the request with a bare
   `setattr`, so the document's own gate vouches for nothing the request NAMES —
   the #782/#783 shape, which `test_ownership_gate_sweep.py` is structurally
   blind to because the endpoint does reach a gate token.
3. **Portability.** `participant_id` is a real FK on a portable model, so an
   un-remapped one writes the SOURCE instance's raw id into this database.
4. **Cardinality.** No unique index, deliberately — several documents about one
   subject is the motivating case, not an edge case.
"""

import asyncio

import pytest

from app.models.user import User
from app.models.project import Project
from app.models.participant import Participant
from app.models.document import Document
from app.models.conversation import Conversation
from app.models.speaker import Speaker
from app.models.segment import Segment
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.dataset import (
    Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType,
)
from app.services.code_analysis import get_source_frequencies


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def linked_docs(db_session):
    """Two participants in different departments, one workplan each — plus a
    SECOND workplan for the first person and one unlinked document.

    The second workplan is the cardinality case: if a unique index had been
    copied from `uq_dataset_rows_dataset_participant`, this fixture would not
    build. The unlinked document is the control — it must stay ungrouped.

    Department lives on `Participant.role`, which `_build_participant_group_map`
    reads directly and is exempt from the N/A rules, so the whole scenario needs
    no dataset at all.
    """
    db = db_session
    db.add(Project(id=460, name="Audit", user_id=1))
    db.flush()

    comms = Participant(id=4601, project_id=460, identifier="E-01", role="Communications")
    finance = Participant(id=4602, project_id=460, identifier="E-02", role="Finance")
    db.add_all([comms, finance])
    db.flush()

    docs = [
        Document(id=4601, project_id=460, name="Workplan 2025", source_filename="a.txt",
                 source_format="txt", participant_id=comms.id),
        Document(id=4602, project_id=460, name="Workplan 2026", source_filename="b.txt",
                 source_format="txt", participant_id=comms.id),
        Document(id=4603, project_id=460, name="Finance workplan", source_filename="c.txt",
                 source_format="txt", participant_id=finance.id),
        Document(id=4604, project_id=460, name="Policy", source_filename="d.txt",
                 source_format="txt"),
    ]
    db.add_all(docs)
    db.flush()

    code = Code(id=4600, project_id=460, numeric_id=2, name="Professional development",
                is_universal=False, is_active=True)
    db.add(code)
    db.flush()

    # One coded segment per document, plus a second uncoded one on 4601 so the
    # total and the coded count cannot coincide.
    segs = [
        Segment(id=46001, document_id=4601, sequence_order=0, text="a goal", word_count=2),
        Segment(id=46002, document_id=4601, sequence_order=1, text="filler", word_count=1),
        Segment(id=46003, document_id=4602, sequence_order=0, text="another goal", word_count=2),
        Segment(id=46004, document_id=4603, sequence_order=0, text="finance goal", word_count=2),
        Segment(id=46005, document_id=4604, sequence_order=0, text="policy text", word_count=2),
    ]
    db.add_all(segs)
    db.flush()
    for sid in (46001, 46003, 46004, 46005):
        db.add(CodeApplication(segment_id=sid, code_id=code.id))
    db.flush()
    return db


class TestTheAnalysisJoin:
    def test_a_linked_document_is_grouped_by_its_subjects_attribute(self, linked_docs):
        """The payoff: coding on a document is now comparable by department."""
        out = get_source_frequencies(linked_docs, 460, group_by_subtype="role")
        by_id = {s["source_id"]: s for s in out["sources"] if s["source_type"] == "document"}

        assert by_id[4601]["groups"] is not None, (
            "a document linked to a participant must group — this is row 46"
        )
        assert set(by_id[4601]["groups"]) == {"Communications"}
        assert set(by_id[4603]["groups"]) == {"Finance"}

    def test_an_unlinked_document_stays_ungrouped(self, linked_docs):
        """The control. Two-sided per the REPLACE-semantics rule: a test that
        only checks the linked side also passes against "every document groups",
        which would put unlinked documents into whatever group came first."""
        out = get_source_frequencies(linked_docs, 460, group_by_subtype="role")
        by_id = {s["source_id"]: s for s in out["sources"] if s["source_type"] == "document"}
        assert by_id[4604]["groups"] is None

    def test_the_whole_document_lands_in_ONE_group(self, linked_docs):
        """🔴 The grain assertion, and the one a conversation-shaped
        implementation gets wrong.

        A conversation splits across groups because each TURN carries a speaker.
        A document has no speaker, so all of its segments belong to its subject —
        including the uncoded one. An implementation that joined through
        `Segment.speaker_id` (which is NULL on every document segment) would
        produce an empty group set here rather than a wrong one, and an
        implementation that grouped per segment would report totals of 1.
        """
        out = get_source_frequencies(linked_docs, 460, group_by_subtype="role")
        by_id = {s["source_id"]: s for s in out["sources"] if s["source_type"] == "document"}

        groups = by_id[4601]["groups"]
        assert list(groups) == ["Communications"]
        # Both segments, not just the coded one.
        assert groups["Communications"]["total_segments"] == 2
        assert groups["Communications"]["coded_segments"] == 1
        # And the group's total matches the source's flat total — a grain slip
        # shows up here as a group that holds a subset of its own source.
        assert groups["Communications"]["total_segments"] == by_id[4601]["total_segments"]

    def test_two_documents_about_one_person_both_group(self, linked_docs):
        """Cardinality. The dataset-row link caps at one row per participant;
        this one deliberately does not, and the motivating case is exactly a
        person with several years of workplans."""
        out = get_source_frequencies(linked_docs, 460, group_by_subtype="role")
        by_id = {s["source_id"]: s for s in out["sources"] if s["source_type"] == "document"}
        assert set(by_id[4601]["groups"]) == {"Communications"}
        assert set(by_id[4602]["groups"]) == {"Communications"}

    def test_a_document_filter_still_scopes_the_groups(self, linked_docs):
        """`doc_ids_filter` reaches the new arm. Without it the group buckets
        would be computed over documents the caller excluded, and the flat
        counts and the grouped ones would disagree on the same payload."""
        out = get_source_frequencies(
            linked_docs, 460, group_by_subtype="role", document_ids=[4603],
        )
        docs = [s for s in out["sources"] if s["source_type"] == "document"]
        assert [s["source_id"] for s in docs] == [4603]
        assert set(docs[0]["groups"]) == {"Finance"}


class TestTheGroupsAgreeWithConversations:
    def test_a_conversation_and_a_document_about_one_person_share_a_group(self, linked_docs):
        """The cross-source claim row 46 exists to make: the same person's
        transcript and workplan land in the same department bucket."""
        db = linked_docs
        conv = Conversation(id=460, project_id=460, name="Interview")
        db.add(conv)
        db.flush()
        sp = Speaker(id=4601, project_id=460, name="E-01", is_facilitator=0,
                     participant_id=4601)
        db.add(sp)
        db.flush()
        db.add(Segment(id=46010, conversation_id=460, speaker_id=sp.id,
                       sequence_order=0, text="spoken", word_count=1))
        db.flush()
        db.add(CodeApplication(segment_id=46010, code_id=4600))
        db.flush()

        out = get_source_frequencies(db, 460, group_by_subtype="role")
        by_key = {(s["source_type"], s["source_id"]): s for s in out["sources"]}
        assert set(by_key[("conversation", 460)]["groups"]) == {"Communications"}
        assert set(by_key[("document", 4601)]["groups"]) == {"Communications"}


class TestTheEndpoint:
    def test_it_links_and_unlinks(self, linked_docs):
        """`None` is a MEANINGFUL value on this field — the unlink. It survives
        because the router applies `model_dump(exclude_unset=True)`, so an
        omitted key differs from an explicit null."""
        from app.routers.documents import update_document
        from app.schemas.document import DocumentUpdateRequest

        db = linked_docs
        user = db.query(User).filter_by(id=1).first()

        out = _run(update_document(
            project_id=460, document_id=4604,
            data=DocumentUpdateRequest(participant_id=4602), user=user, db=db,
        ))
        assert out.participant_id == 4602
        assert out.participant_label == "E-02"

        out = _run(update_document(
            project_id=460, document_id=4604,
            data=DocumentUpdateRequest(participant_id=None), user=user, db=db,
        ))
        assert out.participant_id is None
        assert out.participant_label is None

    def test_omitting_the_field_leaves_the_link_alone(self, linked_docs):
        """The other half of the tri-state. A rename must not silently unlink."""
        from app.routers.documents import update_document
        from app.schemas.document import DocumentUpdateRequest

        db = linked_docs
        user = db.query(User).filter_by(id=1).first()
        out = _run(update_document(
            project_id=460, document_id=4601,
            data=DocumentUpdateRequest(name="Renamed"), user=user, db=db,
        ))
        assert out.name == "Renamed"
        assert out.participant_id == 4601, "an unrelated edit unlinked the subject"

    def test_a_participant_from_another_project_is_refused(self, linked_docs):
        """🔴 #782/#783's shape. The document gate passes — it is this project's
        document — and the participant id is a separate question the bare
        `setattr` loop would never have asked."""
        from fastapi import HTTPException
        from app.routers.documents import update_document
        from app.schemas.document import DocumentUpdateRequest

        db = linked_docs
        db.add(Project(id=461, name="Other", user_id=1))
        db.flush()
        outsider = Participant(id=4610, project_id=461, identifier="X-01")
        db.add(outsider)
        db.flush()
        user = db.query(User).filter_by(id=1).first()

        with pytest.raises(HTTPException) as exc:
            _run(update_document(
                project_id=460, document_id=4601,
                data=DocumentUpdateRequest(participant_id=outsider.id),
                user=user, db=db,
            ))
        assert exc.value.status_code == 404
        # And nothing was written on the way to the refusal.
        db.refresh(db.query(Document).filter_by(id=4601).first())
        assert db.query(Document).filter_by(id=4601).first().participant_id == 4601

    def test_a_participant_that_does_not_exist_is_refused(self, linked_docs):
        from fastapi import HTTPException
        from app.routers.documents import update_document
        from app.schemas.document import DocumentUpdateRequest

        db = linked_docs
        user = db.query(User).filter_by(id=1).first()
        with pytest.raises(HTTPException) as exc:
            _run(update_document(
                project_id=460, document_id=4601,
                data=DocumentUpdateRequest(participant_id=999999),
                user=user, db=db,
            ))
        assert exc.value.status_code == 404


class TestTheParticipantSide:
    def test_the_participant_lists_its_documents(self, linked_docs):
        """The mirror. `ParticipantResponse` already lists speakers and dataset
        rows; a third link it stayed silent about would make the Participants
        page quietly incomplete — the enumeration shape again."""
        from app.routers.participants import get_participant

        db = linked_docs
        user = db.query(User).filter_by(id=1).first()
        out = _run(get_participant(project_id=460, participant_id=4601,
                                   user=user, db=db))
        names = sorted(d.name for d in out.linked_documents)
        assert names == ["Workplan 2025", "Workplan 2026"]

    def test_a_participant_with_no_documents_lists_none(self, linked_docs):
        from app.routers.participants import get_participant

        db = linked_docs
        p = Participant(id=4603, project_id=460, identifier="E-03")
        db.add(p)
        db.flush()
        user = db.query(User).filter_by(id=1).first()
        out = _run(get_participant(project_id=460, participant_id=4603,
                                   user=user, db=db))
        assert out.linked_documents == []
