"""#1702 (D382) — a withdrawn person's DOCUMENT stays, unlinked, for the researcher to read (row
46), and so do its passages quoted on the canvas — a joint display pin with the researcher's line
beside it ("Ben Torres, the only Community Health worker…") among them. The report counts them on
the document's line, so the confirm's "read it yourself" can find them; nothing on the canvas
changes.

Counted: every `excerpt-embed` and every pin naming one of the document's quotes, in sections and
snapshot copies. Not counted: another document's quote, and a blanked embed (`excerptId` null).
"""
from __future__ import annotations

from app.models.canvas import CanvasTheme
from app.models.document import Document
from app.models.segment import Segment
from app.schemas.participant import WithdrawalDocumentTouchpoint
from app.services.canvas import create_snapshot
from app.services.withdrawal_report import build_withdrawal_report
from tests.test_joint_display_pins import _node, _pin, _pins_in, _section, _whole_quote
from tests.test_withdrawal_deleted_history import _project, _withdraw

PURPOSE = "Wren Ortiz, the only Franklin teacher who opposed it"


def _documents(db):
    """Wren's workplan (two passages) and an unlinked policy (one), after `_project`'s turns."""
    db.add(Document(id=1, project_id=1, name="Workplan", participant_id=1,
                    source_filename="workplan.docx", source_format="docx"))
    db.add(Document(id=2, project_id=1, name="Policy", source_filename="policy.docx", source_format="docx"))
    db.flush()
    db.add_all([
        Segment(id=11, document_id=1, sequence_order=0, text="I will mentor two new teachers.", word_count=6),
        Segment(id=12, document_id=1, sequence_order=1, text="Fridays are for planning.", word_count=4),
        Segment(id=21, document_id=2, sequence_order=0, text="All staff attend training.", word_count=4),
    ])
    db.flush()


def _embed(excerpt_id, text) -> dict:
    return {"type": "excerpt-embed", "attrs": {"excerptId": excerpt_id, "displayText": text}}


def _report(db):
    from app.models.participant import Participant
    return build_withdrawal_report(db, db.get(Participant, 1))


def _workplan(report):
    (doc,) = [d for d in report.documents if d.name == "Workplan"]
    return doc


class TestTheDocumentLineCountsItsCanvasQuotes:
    def test_a_pin_and_an_embed_in_a_section_and_its_snapshot_copy(self, db_session):
        db = db_session
        _project(db)
        _documents(db)
        mentor, fridays, policy = _whole_quote(db, 11), _whole_quote(db, 12), _whole_quote(db, 21)
        pin = _pin(mentor.id, "I will mentor two new teachers.", conversation=None)
        pin["role"], pin["purpose"] = "discrepant", PURPOSE
        canvas_id, _ = _section(db, _node([pin]), _embed(fridays.id, "Fridays are for planning."),
                                _embed(policy.id, "All staff attend training."))
        create_snapshot(db, canvas_id, "Before")
        # The section: a pin + an embed of the workplan (2); its snapshot copy: the same 2.
        # The policy's quote is another document's, never counted.
        assert _workplan(_report(db)).canvas_quotes == 4

    def test_none_quoted_reads_zero_and_the_wire_carries_it(self, db_session):
        db = db_session
        _project(db)
        _documents(db)
        report = _report(db)
        assert _workplan(report).canvas_quotes == 0
        wire = WithdrawalDocumentTouchpoint.model_validate(report.to_dict()["documents"][0])
        assert wire.canvas_quotes == 0
        assert "canvas_quotes" in WithdrawalDocumentTouchpoint.model_fields

    def test_not_in_total_items_nothing_here_is_removed(self, db_session):
        db = db_session
        _project(db)
        _documents(db)
        before = _report(db).total_items
        _section(db, _embed(_whole_quote(db, 11).id, "I will mentor two new teachers."))
        report = _report(db)
        assert _workplan(report).canvas_quotes == 1
        assert report.total_items == before + 1, "the new EXCERPT counts, as before; the canvas quote does not"


class TestTheCanvasIsUnchanged:
    def test_the_document_pin_keeps_its_line_after_the_withdrawal(self, db_session):
        """D382: the document stays, and so does its quote and the line beside it — the count is
        what the confirm adds. Clearing it was rejected (D356 is for a quote that is REMOVED)."""
        db = db_session
        _project(db)
        _documents(db)
        mentor = _whole_quote(db, 11)
        pin = _pin(mentor.id, "I will mentor two new teachers.", conversation=None)
        pin["role"], pin["purpose"] = "discrepant", PURPOSE
        _, theme_id = _section(db, _node([pin]))
        _withdraw(db)
        (kept,) = _pins_in(db.get(CanvasTheme, theme_id).content)
        assert kept["excerptId"] == mentor.id
        assert kept["purpose"] == PURPOSE
