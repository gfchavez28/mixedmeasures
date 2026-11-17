"""What a joint display's pins are chosen from and attributed by (session B, D209/D210).

`services/joint_display_pins.py`, over `test_joint_display.py`'s fixture: groups from `Gain
group` in the roster (High 1–4, Low 5–7; 8 has no group), a facilitator linked to a Low person,
a colleague's coding on a Low person's turn, and a Low person's document.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models.code_application import CodeApplication
from app.models.excerpt import Excerpt
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.routers.joint_display import passages as passages_endpoint
from app.routers.joint_display import pin_attribution_facts
from app.schemas.joint_display import (
    JointDisplayPassagesRequest,
    JointDisplayPassagesResponse,
    JointDisplayPinFactsRequest,
    JointDisplayPinFactsResponse,
)
from app.services import joint_display_pins as pins
from app.services.code_analysis import GroupingColumnError
from tests.test_joint_display import (  # noqa: F401 — `fx` is the fixture
    COLLEAGUE, CONV, DOC, GROUP, HOURS, ME, PID, PLAN, RESP, SCHOOL, fx,
)


def _passages(fx, group, code, **kw):
    kw.setdefault("conversation_ids", None)
    kw.setdefault("document_ids", None)
    kw.setdefault("coder_ids", None)
    kw.setdefault("layer_scope", None)
    kw.setdefault("chips_follow_coder_ids", False)
    kw.setdefault("limit", 50)
    kw.setdefault("offset", 0)
    result = pins.group_passages(fx.db, PID, group_by_column_id=kw.pop("column", GROUP),
                                 group=group, code_id=code, **kw)
    if result is not None:
        # Joint display slice 2 (r4-1): the display's own answer (the Content tab's + answers).
        JointDisplayPassagesResponse.model_validate(result)  # a valid wire payload
    return result


def _speakers(result) -> list:
    """The speakers of the conversation passages, and None per document passage."""
    out = []
    for conv in result["conversations"]:
        for seg in conv["segments"]:
            out.append(seg["participant_id"])
    for doc in result["documents"]:
        for _ in doc["segments"]:
            out.append(("doc", doc["document_id"]))
    return out


def _turn_of(fx, speaker_id) -> int:
    return fx.db.query(Segment.id).filter(Segment.speaker_id == speaker_id).order_by(Segment.id).first()[0]


class TestTheSuggestions:
    def test_are_the_groups_own_passages_and_never_an_interviewers(self, fx):
        """D163: a quote cannot come from the wrong group. Low's only Planning-time turn is
        participant 5's; the facilitator linked to Low person 7 coded it too and is left out,
        as the numbers leave it out."""
        high = _passages(fx, "High", PLAN)
        assert sorted(_speakers(high)) == [1, 2, 3]
        low = _passages(fx, "Low", PLAN)
        assert _speakers(low) == [5]
        assert high["total_segments"] == 3 and low["total_segments"] == 1

    def test_a_group_nobody_the_sources_link_suggests_nothing_not_everything(self, fx):
        """🔴 An empty participant list is "no filter" to the passage read — so a group whose
        members link no speaker or document must answer empty, never every passage."""
        r = _passages(fx, "High", PLAN, conversation_ids=[], document_ids=[])
        assert r["total_segments"] == 0 and r["conversations"] == [] and r["has_more"] is False
        r = _passages(fx, "Nobody here", PLAN)
        assert r["total_segments"] == 0

    def test_a_documents_passage_is_its_linked_persons(self, fx):
        """Low person 6 has no turns; their journal is their material (D168.1's rule)."""
        r = _passages(fx, "Low", RESP)
        assert sorted(_speakers(r), key=str) == sorted([5, 7, ("doc", DOC)], key=str)
        assert r["document_total"] == 1

    def test_none_of_a_kind_leaves_out_a_persons_turns_when_their_document_links_them(self, fx):
        """The arm is dropped, not merely unreached: person 5 has a turn AND a document, so with
        conversations set to none they are still in the group through the document — and their
        turn must not be suggested. (Without this person every case below passed with the
        blanking removed: the linked-people narrowing alone had kept the turns out.)"""
        from app.models.document import Document
        fx.db.add(Document(id=DOC + 1, project_id=PID, name="Workplan", source_filename="w.txt",
                           source_format="txt", participant_id=5))
        fx.db.flush()
        fx.turn(None, [(RESP, ME, None)], document_id=DOC + 1)
        r = _passages(fx, "Low", RESP, conversation_ids=[])
        assert r["conversation_total"] == 0 and r["conversations"] == []
        assert r["document_total"] == 2

    def test_a_kind_the_display_selects_none_of_is_left_out(self, fx):
        """#1297's rule, as the numbers read it: None = every source of the kind, [] = none."""
        no_docs = _passages(fx, "Low", RESP, document_ids=[])
        assert no_docs["document_total"] == 0 and no_docs["documents"] == []
        assert sorted(_speakers(no_docs)) == [5, 7]
        no_convs = _passages(fx, "Low", RESP, conversation_ids=[])
        assert no_convs["conversation_total"] == 0 and _speakers(no_convs) == [("doc", DOC)]
        assert no_convs["total_segments"] == 1
        chosen = _passages(fx, "Low", RESP, conversation_ids=[CONV], document_ids=[DOC])
        assert len(_speakers(chosen)) == 3

    def test_the_coder_scope_narrows_the_passages_and_blind_narrows_the_chips(self, fx):
        """D175 + D102: the display's coder scope picks which passages count; while blind the
        chips follow it too, so a colleague's coding on the viewer's passage stays unseen."""
        turn5 = _turn_of(fx, 5)
        fx.db.add(CodeApplication(segment_id=turn5, code_id=PLAN, user_id=COLLEAGUE))
        fx.db.flush()
        scoped = _passages(fx, "Low", RESP, coder_ids=[ME])
        assert sorted(_speakers(scoped), key=str) == sorted([5, ("doc", DOC)], key=str), \
            "the colleague's only coding (person 7's turn) is not the viewer's"

        def _coders_on_turn5(result):
            for conv in result["conversations"]:
                for seg in conv["segments"]:
                    if seg["id"] == turn5:
                        return {d["user_id"] for d in seg["applied_code_details"]}
            raise AssertionError("turn 5 not suggested")

        assert COLLEAGUE in _coders_on_turn5(scoped), "a coder FILTER keeps the unit's chips"
        blind = _passages(fx, "Low", RESP, coder_ids=[ME], chips_follow_coder_ids=True)
        assert _coders_on_turn5(blind) == {ME}

    def test_an_ungroupable_column_and_another_projects_code(self, fx):
        with pytest.raises(GroupingColumnError) as err:
            _passages(fx, "High", PLAN, column=HOURS)
        assert err.value.status_code == 400
        assert _passages(fx, "High", 999_999) is None


class TestTheEndpoint:
    def _body(self, **kw):
        kw.setdefault("group_by_column_id", GROUP)
        kw.setdefault("group", "High")
        kw.setdefault("code_id", PLAN)
        return JointDisplayPassagesRequest(**kw)

    def test_answers_the_passages_and_refuses_with_the_right_status(self, fx):
        user = fx.db.get(User, ME)
        r = passages_endpoint(PID, self._body(), user=user, db=fx.db)
        assert r["total_segments"] == 3
        with pytest.raises(HTTPException) as err:
            passages_endpoint(PID, self._body(code_id=999_999), user=user, db=fx.db)
        assert err.value.status_code == 404
        with pytest.raises(HTTPException) as err:
            passages_endpoint(PID, self._body(group_by_column_id=HOURS), user=user, db=fx.db)
        assert err.value.status_code == 400

    def test_a_project_that_does_not_exist_is_not_found(self, fx):
        """The ownership gate (`_get_project_or_404`) runs first — in local-roster mode it
        shares projects across the roster by design; the multi-user arm is the gate sweep's."""
        with pytest.raises(HTTPException) as err:
            passages_endpoint(999_999, self._body(), user=fx.db.get(User, ME), db=fx.db)
        assert err.value.status_code == 404


def _quote(fx, segment_id, project_id=PID) -> int:
    e = Excerpt(project_id=project_id, segment_id=segment_id)
    fx.db.add(e)
    fx.db.flush()
    return e.id


class TestTheAttributionFacts:
    def test_are_read_from_the_live_quote_never_stored(self, fx):
        """D163.4: identifier, speaker label, source and (optionally) a category — for a turn
        through its speaker, for a document passage through its document."""
        turn = _quote(fx, _turn_of(fx, 1))
        doc_seg = fx.db.query(Segment.id).filter(Segment.document_id == DOC).first()[0]
        passage = _quote(fx, doc_seg)
        facts = pins.pin_facts(fx.db, PID, excerpt_ids=[passage, turn], column_id=SCHOOL, coder_ids=None)
        JointDisplayPinFactsResponse.model_validate({"pins": facts})
        assert facts == [
            {"excerpt_id": turn, "participant_id": 1, "participant_identifier": "T1",
             "speaker_label": "S1", "source_name": "Focus group", "column_value": "A",
             "source_kind": pins.PIN_SOURCE_CONVERSATION},  # joint display slice 2, R8
            {"excerpt_id": passage, "participant_id": 6, "participant_identifier": "T6",
             "speaker_label": None, "source_name": "Journal", "column_value": "C",
             "source_kind": pins.PIN_SOURCE_DOCUMENT},
        ]

    def test_a_category_is_asked_for_or_absent(self, fx):
        turn = _quote(fx, _turn_of(fx, 5))
        [fact] = pins.pin_facts(fx.db, PID, excerpt_ids=[turn], column_id=None, coder_ids=None)
        assert fact["column_value"] is None and fact["participant_identifier"] == "T5"

    def test_an_unlinked_speaker_has_no_participant(self, fx):
        """A speaker with no participant link: the label and source stand, no identifier."""
        from app.models.speaker import Speaker
        fx.db.add(Speaker(id=60, project_id=PID, name="Guest", is_facilitator=0,
                          color_index=0, participant_id=None))
        fx.db.flush()
        fx.turn(60, [(PLAN, ME, None)])
        quote = _quote(fx, _turn_of(fx, 60))
        [fact] = pins.pin_facts(fx.db, PID, excerpt_ids=[quote], column_id=SCHOOL, coder_ids=None)
        assert fact["participant_id"] is None and fact["participant_identifier"] is None
        assert fact["column_value"] is None and fact["speaker_label"] == "Guest"

    def test_a_quote_that_is_gone_or_not_this_projects_is_absent(self, fx):
        kept = _quote(fx, _turn_of(fx, 2))
        gone = _quote(fx, _turn_of(fx, 3))
        fx.db.delete(fx.db.get(Excerpt, gone))
        fx.db.add(Project(id=PID + 50, name="Elsewhere", user_id=ME))
        fx.db.flush()
        from app.models.conversation import Conversation
        fx.db.add(Conversation(id=PID + 50, project_id=PID + 50, name="Theirs"))
        fx.db.flush()
        fx.db.add(Segment(id=170_000, conversation_id=PID + 50, sequence_order=0, text="x"))
        fx.db.flush()
        theirs = _quote(fx, 170_000, project_id=PID + 50)
        facts = pins.pin_facts(fx.db, PID, excerpt_ids=[kept, gone, theirs], column_id=None, coder_ids=None)
        assert [f["excerpt_id"] for f in facts] == [kept]

    def test_the_column_must_be_able_to_name_a_category(self, fx):
        """A column that cannot name a category (Training hours is numeric) gives no VALUE — and,
        since #1653 (D346), costs nothing else: it refused the whole read with a 400, and every
        quote lost who said it and where. The answer says why (`column_unusable`)."""
        turn = _quote(fx, _turn_of(fx, 1))
        [fact] = pins.pin_facts(fx.db, PID, excerpt_ids=[turn], column_id=HOURS, coder_ids=None)
        assert fact["participant_identifier"] == "T1" and fact["column_value"] is None
        r = pin_attribution_facts(PID, JointDisplayPinFactsRequest(excerpt_ids=[turn], column_id=HOURS),
                                  user=fx.db.get(User, ME), db=fx.db)
        assert r["column_unusable"] == pins.PIN_ATTRIBUTION_INELIGIBLE
        assert r["pins"][0]["participant_identifier"] == "T1" and r["pins"][0]["column_value"] is None

    def test_the_endpoint_answers_the_wire_shape(self, fx):
        turn = _quote(fx, _turn_of(fx, 1))
        r = pin_attribution_facts(PID, JointDisplayPinFactsRequest(excerpt_ids=[turn]),
                                  user=fx.db.get(User, ME), db=fx.db)
        assert JointDisplayPinFactsResponse.model_validate(r).pins[0].participant_identifier == "T1"

    def test_nothing_asked_reads_nothing(self, fx):
        assert pins.pin_facts(fx.db, PID, excerpt_ids=[], column_id=SCHOOL, coder_ids=None) == []
