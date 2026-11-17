"""#1546 (D158) — the canvas quotes a withdrawal cannot place are COUNTED, never guessed.

A canvas embed is a snapshot of a quote's words, and it names the source only — no
speaker, no answer. So once its source is gone nothing ties it to anyone: a quote of a
turn whose conversation was deleted, or a quote with no conversation (an answer's or a
document passage's, which an embed cannot tell apart) whose quote is gone and which
equals none of the person's answers' wordings. The withdrawal LEAVES these. D158 (accepted
2026-11-08): the report counts them with the canvas sections and snapshots that hold
them, the confirm and the done note say so, and the scope note gains the clause.

Two halves held to one predicate (`canvas_embed_scrub._Judge.unplaced`): the report asks
it before the act, the act counts with it after deciding what is theirs. The controls
are what the scrub already decides — a live quote, an orphan in a live conversation
(D8), their own answer's orphan, a clip's label, a quote already blanked.
"""
from __future__ import annotations

import json

import pytest

from app.models.canvas import Canvas, CanvasSnapshot, CanvasTheme
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.excerpt import Excerpt
from app.models.observation import Observation
from app.models.participant import Participant
from app.models.segment import Segment
from app.services import withdrawal_redaction
from app.services.audit import log_action
from app.services.withdrawal_redaction import BLANKED_SEGMENT_TEXT
from app.services.withdrawal_report import build_withdrawal_report
from tests.test_withdrawal_deleted_history import OLA, _embeds, _project, _withdraw

GONE_TURN = "Words from an interview deleted since."
OLAS_OLD_ANSWER = "Ola's answer in a survey deleted since."
WRENS_ANSWER = "Wren answered privately."
WRENS_FIRST_ANSWER = "Wren's first wording."
OLAS_ANSWER = "Ola answered."


def _theme(db, *embeds, canvas: str = "Main", section: str = "Findings") -> int:
    found = db.query(Canvas).filter_by(project_id=1, name=canvas).first()
    if found is None:
        found = Canvas(project_id=1, name=canvas)
        db.add(found)
        db.flush()
    theme = CanvasTheme(canvas_id=found.id, name=section, content=json.dumps({
        "type": "doc", "content": [{"type": "excerpt-embed", "attrs": a} for a in embeds]}))
    db.add(theme)
    db.flush()
    return theme.id


def _snapshot(db, *embeds, canvas: str = "Main", name: str = "Draft 1") -> int:
    found = db.query(Canvas).filter_by(project_id=1, name=canvas).one()
    snap = CanvasSnapshot(canvas_id=found.id, name=name, theme_count=1, snapshot_data=json.dumps({
        "themes": [{"name": "Findings", "content": json.dumps({
            "type": "doc", "content": [{"type": "excerpt-embed", "attrs": a} for a in embeds]})}],
        "pending_items": [],
    }))
    db.add(snap)
    db.flush()
    return snap.id


def _deleted_conversations_quote(db) -> dict:
    """A quote of a turn in an interview that was then deleted — the embed outlives both."""
    conv = Conversation(project_id=1, name="Deleted interview")
    db.add(conv)
    db.flush()
    seg = Segment(conversation_id=conv.id, speaker_id=2, sequence_order=0, text=GONE_TURN)
    db.add(seg)
    db.flush()
    ex = Excerpt(project_id=1, segment_id=seg.id, start_offset=0, end_offset=len(GONE_TURN))
    db.add(ex)
    db.flush()
    embed = {"excerptId": ex.id, "displayText": GONE_TURN, "conversationId": conv.id}
    db.delete(conv)
    db.flush()
    db.expire_all()  # the database cascade took the turn and the quote; forget the copies
    assert db.get(Conversation, embed["conversationId"]) is None, "precondition: it is gone"
    assert db.get(Excerpt, embed["excerptId"]) is None, "precondition: its quote went with it"
    return embed


def _survey(db, name="Survey"):
    ds = Dataset(project_id=1, name=name)
    db.add(ds)
    db.flush()
    col = DatasetColumn(dataset_id=ds.id, column_code="Q1", column_text="Q1", column_name="Q1",
                        column_type=ColumnType.OPEN_TEXT, sequence_order=0, display_order=0,
                        source="manual")
    db.add(col)
    db.flush()
    return ds, col


def _answer(db, ds, col, participant_id, text) -> DatasetValue:
    row = DatasetRow(dataset_id=ds.id, participant_id=participant_id,
                     row_identifier=f"R{participant_id}-{ds.id}")
    db.add(row)
    db.flush()
    value = DatasetValue(row_id=row.id, column_id=col.id, value_text=text)
    db.add(value)
    db.flush()
    return value


def _orphan_quote_of(db, value: DatasetValue) -> dict:
    """A quote of an answer, embedded, and the quote then deleted (the embed stays)."""
    ex = Excerpt(project_id=1, dataset_value_id=value.id)
    db.add(ex)
    db.flush()
    embed = {"excerptId": ex.id, "displayText": value.value_text, "conversationId": None}
    db.delete(ex)
    db.flush()
    return embed


def _deleted_surveys_quote(db) -> dict:
    """Ola's answer in a survey that was then deleted, quoted on a canvas first."""
    ds, col = _survey(db, name="Old survey")
    value = _answer(db, ds, col, 2, OLAS_OLD_ANSWER)
    ex = Excerpt(project_id=1, dataset_value_id=value.id)
    db.add(ex)
    db.flush()
    embed = {"excerptId": ex.id, "displayText": OLAS_OLD_ANSWER, "conversationId": None}
    db.delete(ds)
    db.flush()
    db.expire_all()
    assert db.get(Excerpt, embed["excerptId"]) is None, "precondition: its quote went with it"
    return embed


def _report(db):
    return build_withdrawal_report(db, db.get(Participant, 1)).canvas_quotes_unplaced


def _places(places) -> list[tuple[str, str, int]]:
    return [(p.canvas_name, p.name, p.quotes) for p in places]


class TestTheReportCountsWhatItCannotPlace:
    def test_a_turns_quote_whose_conversation_was_deleted(self, db_session):
        db = db_session
        _project(db)
        theme = _theme(db, _deleted_conversations_quote(db))
        before = db.get(CanvasTheme, theme).content
        got = _report(db)
        assert got.quotes == 1
        assert _places(got.sections) == [("Main", "Findings", 1)]
        assert [p.id for p in got.sections] == [theme] and got.snapshots == []
        db.expire_all()
        assert db.get(CanvasTheme, theme).content == before, "the report changes nothing"

    def test_an_answers_quote_whose_dataset_was_deleted(self, db_session):
        db = db_session
        _project(db)
        _theme(db, _deleted_surveys_quote(db))
        got = _report(db)
        assert got.quotes == 1 and _places(got.sections) == [("Main", "Findings", 1)]

    def test_a_documents_quote_whose_quote_was_deleted_is_counted_too(self, db_session):
        """An embed of a document passage carries no document id, so it reads exactly as
        an answer's does: the withdrawal cannot tell it is not hers, and says so."""
        db = db_session
        _project(db)
        doc = Document(project_id=1, name="Policy", source_filename="policy.docx",
                       source_format="docx")
        db.add(doc)
        db.flush()
        seg = Segment(document_id=doc.id, sequence_order=0, text="A passage of the policy.")
        db.add(seg)
        db.flush()
        ex = Excerpt(project_id=1, segment_id=seg.id, start_offset=0, end_offset=len(seg.text))
        db.add(ex)
        db.flush()
        embed = {"excerptId": ex.id, "displayText": seg.text, "conversationId": None}
        db.delete(ex)
        db.flush()
        _theme(db, embed)
        assert _report(db).quotes == 1

    def test_snapshot_copies_are_counted_and_named(self, db_session):
        db = db_session
        _project(db)
        embed = _deleted_conversations_quote(db)
        _theme(db, embed)
        snap = _snapshot(db, embed, embed, name="Before the rewrite")
        got = _report(db)
        assert _places(got.snapshots) == [("Main", "Before the rewrite", 2)]
        assert [p.id for p in got.snapshots] == [snap]
        assert got.quotes == 3, "every copy: a restore brings a snapshot's back"

    def test_each_section_is_named_with_its_canvas(self, db_session):
        """Two canvases with a section of the same name: the canvas tells them apart."""
        db = db_session
        _project(db)
        embed = _deleted_conversations_quote(db)
        _theme(db, embed, canvas="Main")
        _theme(db, embed, embed, canvas="Second")
        got = _report(db)
        assert _places(got.sections) == [("Main", "Findings", 1), ("Second", "Findings", 2)]
        assert got.quotes == 3

    def test_it_is_not_part_of_total_items(self, db_session):
        """Possibly hers, never provably — beside the report, like D14's records."""
        db = db_session
        _project(db)
        without = build_withdrawal_report(db, db.get(Participant, 1)).total_items
        _theme(db, _deleted_conversations_quote(db))
        report = build_withdrawal_report(db, db.get(Participant, 1))
        assert report.canvas_quotes_unplaced.quotes == 1
        assert report.total_items == without


class TestWhatItCanPlaceIsNotCounted:
    """The scrub's own decisions, each a control: none of these is unplaced."""

    def test_CONTROL_a_live_quote(self, db_session):
        db = db_session
        _project(db)
        ola = db.get(Segment, 2)
        ex = Excerpt(project_id=1, segment_id=ola.id, start_offset=0, end_offset=len(OLA))
        db.add(ex)
        db.flush()
        _theme(db, {"excerptId": ex.id, "displayText": OLA, "conversationId": 1})
        assert _report(db).quotes == 0

    def test_CONTROL_a_live_quote_of_another_persons_answer(self, db_session):
        """A conversation's arm cannot show this: an answer's embed reaches the last rule,
        so only the live-quote check keeps Ola's current quote out of the count."""
        db = db_session
        _project(db)
        ds, col = _survey(db)
        olas = _answer(db, ds, col, 2, OLAS_ANSWER)
        ex = Excerpt(project_id=1, dataset_value_id=olas.id)
        db.add(ex)
        db.flush()
        _theme(db, {"excerptId": ex.id, "displayText": OLAS_ANSWER, "conversationId": None})
        assert _report(db).quotes == 0

    def test_a_conversation_of_another_project_is_gone_for_this_one(self, db_session):
        """Conversation ids are install-wide, and an embed's names a conversation of ITS
        project: an id another project's conversation holds names nothing here."""
        from app.models.project import Project
        db = db_session
        _project(db)
        db.add(Project(id=2, name="Other", user_id=1))
        db.flush()
        other = Conversation(project_id=2, name="Elsewhere")
        db.add(other)
        db.flush()
        _theme(db, {"excerptId": 408, "displayText": GONE_TURN, "conversationId": other.id})
        assert _report(db).quotes == 1

    def test_CONTROL_an_orphan_in_a_live_conversation_is_D8s(self, db_session):
        """Its conversation is there, so D8 decides it against her turns there."""
        db = db_session
        _project(db)
        _theme(db, {"excerptId": 404, "displayText": OLA, "conversationId": 1})
        assert _report(db).quotes == 0

    def test_CONTROL_an_orphan_of_her_own_answer_is_hers(self, db_session):
        db = db_session
        _project(db)
        ds, col = _survey(db)
        wrens = _answer(db, ds, col, 1, WRENS_ANSWER)
        _theme(db, _orphan_quote_of(db, wrens))
        assert _report(db).quotes == 0

    def test_CONTROL_an_orphan_of_her_answers_earlier_wording_is_hers(self, db_session):
        db = db_session
        _project(db)
        ds, col = _survey(db)
        wrens = _answer(db, ds, col, 1, WRENS_ANSWER)
        log_action(db, action="value_updated", entity_type="dataset_value", entity_id=wrens.id,
                   user_id=1, project_id=1,
                   details={"dataset_id": ds.id, "column_id": col.id,
                            "old_value": WRENS_FIRST_ANSWER, "new_value": WRENS_ANSWER})
        db.flush()
        _theme(db, {"excerptId": 405, "displayText": WRENS_FIRST_ANSWER, "conversationId": None})
        assert _report(db).quotes == 0

    def test_an_orphan_of_another_persons_live_answer_is_counted(self, db_session):
        """The positive beside the two controls above: Ola's answer is live, but its quote
        is gone, and an answer's embed names no answer — so nothing says it is Ola's."""
        db = db_session
        _project(db)
        ds, col = _survey(db)
        _answer(db, ds, col, 1, WRENS_ANSWER)
        olas = _answer(db, ds, col, 2, OLAS_ANSWER)
        _theme(db, _orphan_quote_of(db, olas))
        assert _report(db).quotes == 1

    def test_CONTROL_a_clips_label(self, db_session):
        db = db_session
        _project(db)
        obs = Observation(project_id=1, name="Classroom")
        db.add(obs)
        db.flush()
        _theme(db, {"excerptId": 406, "displayText": "Group work begins",
                    "conversationId": None, "observationId": obs.id})
        db.delete(obs)
        db.flush()
        assert _report(db).quotes == 0

    def test_CONTROL_a_quote_a_withdrawal_already_blanked(self, db_session):
        db = db_session
        _project(db)
        gone = _deleted_conversations_quote(db)
        _theme(
            db,
            {"excerptId": None, "displayText": BLANKED_SEGMENT_TEXT,
             "conversationId": gone["conversationId"]},
            {"excerptId": None, "displayText": BLANKED_SEGMENT_TEXT, "conversationId": None},
        )
        assert _report(db).quotes == 0

    def test_CONTROL_an_embed_with_no_words(self, db_session):
        db = db_session
        _project(db)
        gone = _deleted_conversations_quote(db)
        _theme(db, {**gone, "displayText": "  "}, {"excerptId": 407, "displayText": None})
        assert _report(db).quotes == 0


class TestTheWithdrawalLeavesWhatTheReportCounted:
    def test_the_act_counts_what_the_report_counted_and_leaves_it(self, db_session):
        db = db_session
        _project(db)
        ds, col = _survey(db)
        wrens = _answer(db, ds, col, 1, WRENS_ANSWER)
        hers = _orphan_quote_of(db, wrens)
        gone_turn = _deleted_conversations_quote(db)
        gone_answer = _deleted_surveys_quote(db)
        theme = _theme(db, hers, gone_turn, gone_answer)
        _snapshot(db, gone_turn)
        predicted = _report(db)
        assert predicted.quotes == 3

        outcome = _withdraw(db)
        assert outcome.canvas_quotes_unplaced == predicted.quotes
        after = _embeds(db, theme)
        assert after[0]["displayText"] == BLANKED_SEGMENT_TEXT, "hers, so scrubbed"
        assert [a["displayText"] for a in after[1:]] == [GONE_TURN, OLAS_OLD_ANSWER], (
            "left: nothing says whose words they hold"
        )

    def test_CONTROL_nothing_unplaced_is_zero_in_the_outcome(self, db_session):
        db = db_session
        _project(db)
        _theme(db, {"excerptId": 404, "displayText": OLA, "conversationId": 1})
        assert _withdraw(db).canvas_quotes_unplaced == 0


class TestTheAnswerWordingsAreReadOnlyWhenNeeded:
    """The report opens with every participant panel; her answers' audit entries are read
    only when a canvas holds an orphan an answer could claim."""

    @pytest.fixture
    def refusing(self, monkeypatch):
        def _refuse(*_a, **_k):
            raise AssertionError("answer wordings were read")
        monkeypatch.setattr(withdrawal_redaction, "answer_wordings", _refuse)

    def test_a_turns_orphan_alone_does_not_read_them(self, db_session, refusing):
        db = db_session
        _project(db)
        _theme(db, _deleted_conversations_quote(db))
        assert _report(db).quotes == 1

    def test_CONTROL_an_answers_orphan_does(self, db_session, refusing):
        db = db_session
        _project(db)
        _theme(db, _deleted_surveys_quote(db))
        with pytest.raises(AssertionError, match="answer wordings were read"):
            _report(db)


class TestTheReportCarriesItOnTheWire:
    def test_a_populated_count_survives_the_response_model(self, db_session):
        from app.schemas.participant import WithdrawalReportResponse
        db = db_session
        _project(db)
        embed = _deleted_conversations_quote(db)
        _theme(db, embed)
        _snapshot(db, embed)
        sent = build_withdrawal_report(db, db.get(Participant, 1)).to_dict()
        assert sent["canvas_quotes_unplaced"]["sections"], "the fixture must populate it"
        assert sent["canvas_quotes_unplaced"]["snapshots"], "the fixture must populate it"
        assert WithdrawalReportResponse.model_validate(sent).model_dump() == sent
