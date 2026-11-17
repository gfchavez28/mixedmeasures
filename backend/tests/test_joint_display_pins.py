"""A quote PINNED in a joint display is a quote (D163) — the withdrawal reaches it.

The joint display lives in a canvas section's text as one node whose `display` attribute
holds its rows, and each row's pins carry exactly an `excerpt-embed`'s attributes. So the
scrub's ONE walk (`canvas_embed_scrub._embed_attrs`) must hand every pin to `_Judge` —
in a live section and in a snapshot's copy, for the report as for the act — and a
display it cannot walk must stop the withdrawal rather than pass over it.

Every arm here is the excerpt-embed rule restated for a pin, on the shared fixture of
`test_withdrawal_deleted_history.py` (Wren, participant 1, withdraws; Ola and Kai stay).
"""
from __future__ import annotations

import json

import pytest

from app.models.canvas import Canvas, CanvasSnapshot, CanvasTheme
from app.models.conversation import Conversation
from app.models.excerpt import Excerpt
from app.models.participant import Participant
from app.models.segment import Segment
from app.services.canvas import create_snapshot, update_theme_content
from app.services.canvas_embed_scrub import CanvasScrubError
from app.services.withdrawal_redaction import BLANKED_SEGMENT_TEXT
from app.services.withdrawal_report import build_withdrawal_report
from tests.test_withdrawal_deleted_history import KAI, OLA, WREN, _project, _withdraw


def _pin(excerpt_id, text, conversation=1, group="High") -> dict:
    return {"excerptId": excerpt_id, "displayText": text, "sourceContext": "C",
            "conversationId": conversation, "observationId": None,
            "group": group, "role": "typical"}


def _node(*rows_of_pins, display_as_string: bool = False) -> dict:
    display = {
        "group_by_column_id": None,
        "rows": [{"key": f"r{i}", "construct": f"Construct {i}", "code_ids": [],
                  "column_ids": [], "pins": list(pins)}
                 for i, pins in enumerate(rows_of_pins)],
    }
    return {"type": "joint-display", "attrs": {
        "displayKey": "k-1", "figureEpoch": 1,
        "display": json.dumps(display) if display_as_string else display}}


def _section(db, *nodes) -> tuple[int, int]:
    canvas = db.query(Canvas).filter_by(project_id=1, name="Main").first()
    if canvas is None:
        canvas = Canvas(project_id=1, name="Main")
        db.add(canvas)
        db.flush()
    theme = CanvasTheme(canvas_id=canvas.id, name="Findings")
    db.add(theme)
    db.flush()
    update_theme_content(db, theme, {"type": "doc", "content": list(nodes)})
    return canvas.id, theme.id


def _whole_quote(db, segment_id: int) -> Excerpt:
    ex = Excerpt(project_id=1, segment_id=segment_id)
    db.add(ex)
    db.flush()
    return ex


def _pins_in(content: str | None) -> list[dict]:
    doc = json.loads(content)
    out = []
    for node in doc["content"]:
        display = node["attrs"]["display"]
        if isinstance(display, str):
            display = json.loads(display)
        for row in display["rows"]:
            out.extend(row["pins"])
    return out


class TestAPinOfTheirQuote:
    def test_is_blanked_in_the_section_and_someone_elses_stays(self, db_session):
        db = db_session
        _project(db)
        wren, ola = _whole_quote(db, 1), _whole_quote(db, 2)
        ola_id = ola.id
        _, theme_id = _section(db, _node([_pin(wren.id, WREN), _pin(ola_id, OLA, group="Low")]))
        theme = db.get(CanvasTheme, theme_id)
        assert "private" in theme.searchable_text, "precondition: the pin is indexed"
        assert {"type": "excerpt", "id": wren.id} in json.loads(theme.referenced_source_ids)

        outcome = _withdraw(db)

        theme = db.get(CanvasTheme, theme_id)
        theirs, olas = _pins_in(theme.content)
        assert theirs["displayText"] == BLANKED_SEGMENT_TEXT
        assert theirs["excerptId"] is None
        assert olas["displayText"] == OLA and olas["excerptId"] == ola_id
        # The derived columns were rebuilt from the rewritten display.
        assert "private" not in (theme.searchable_text or "")
        assert json.loads(theme.referenced_source_ids) == [{"type": "excerpt", "id": ola_id}]
        assert outcome.canvas_embeds_scrubbed == 1

    def test_is_blanked_in_a_snapshot_copy_too(self, db_session):
        db = db_session
        _project(db)
        wren = _whole_quote(db, 1)
        canvas_id, _ = _section(db, _node([_pin(wren.id, WREN)]))
        snap_id = create_snapshot(db, canvas_id, "Before").id

        outcome = _withdraw(db)

        data = json.loads(db.get(CanvasSnapshot, snap_id).snapshot_data)
        (copy,) = data["themes"]
        (pin,) = _pins_in(copy["content"])
        assert pin["displayText"] == BLANKED_SEGMENT_TEXT and pin["excerptId"] is None
        assert "private" not in (copy["searchable_text"] or "")
        assert outcome.canvas_snapshots_rewritten == 1

    def test_a_display_stored_as_a_string_is_scrubbed_and_written_back_as_an_object(self, db_session):
        db = db_session
        _project(db)
        wren = _whole_quote(db, 1)
        _, theme_id = _section(db, _node([_pin(wren.id, WREN)], display_as_string=True))

        _withdraw(db)

        node = json.loads(db.get(CanvasTheme, theme_id).content)["content"][0]
        assert isinstance(node["attrs"]["display"], dict)
        assert node["attrs"]["display"]["rows"][0]["pins"][0]["displayText"] == BLANKED_SEGMENT_TEXT


class TestAReusedId:
    """#1192 — a pin's id can name ANOTHER quote. Since #1639 (r2-1) `excerpt` is AUTOINCREMENT
    and SQLite never hands a freed id out again, but a database that reused one BEFORE that
    upgrade still holds such a pin — so the state is made here by giving Kai's quote the id."""

    def test_their_pin_is_still_theirs_and_the_quote_now_holding_the_id_is_untouched(self, db_session):
        db = db_session
        _project(db)
        wren = _whole_quote(db, 1)
        freed = wren.id
        theirs = _pin(freed, WREN)
        db.delete(wren)
        db.flush()
        kai = Excerpt(id=freed, project_id=1, segment_id=3)
        db.add(kai)
        db.flush()
        assert kai.id == freed, "precondition: Kai's quote holds the freed id"
        _, theme_id = _section(db, _node([theirs, _pin(kai.id, KAI, group="Low")]))

        _withdraw(db)

        after_theirs, after_kai = _pins_in(db.get(CanvasTheme, theme_id).content)
        # Wren's words, inside her turn, bound to a live quote that says something else:
        # an orphan by D8, and hers.
        assert after_theirs["displayText"] == BLANKED_SEGMENT_TEXT
        assert after_kai == _pin(freed, KAI, group="Low")
        assert db.get(Excerpt, freed) is not None, "Kai's quote is not touched"


class TestAPinNothingCanPlace:
    """D158 — a pin whose source conversation is gone: counted, named, left."""

    def _gone(self, db) -> dict:
        conv = Conversation(project_id=1, name="Deleted interview")
        db.add(conv)
        db.flush()
        seg = Segment(conversation_id=conv.id, speaker_id=2, sequence_order=0,
                      text="Words from an interview deleted since.")
        db.add(seg)
        db.flush()
        ex = _whole_quote(db, seg.id)
        pin = _pin(ex.id, seg.text, conversation=conv.id)
        db.delete(conv)
        db.flush()
        db.expire_all()
        assert db.get(Excerpt, pin["excerptId"]) is None, "precondition: its quote went too"
        return pin

    def test_the_report_and_the_act_count_it_alike_and_the_wire_carries_it(self, db_session):
        from app.schemas.participant import WithdrawalReportResponse
        db = db_session
        _project(db)
        pin = self._gone(db)
        canvas_id, theme_id = _section(db, _node([pin]))
        create_snapshot(db, canvas_id, "Before")

        report = build_withdrawal_report(db, db.get(Participant, 1))
        assert report.canvas_quotes_unplaced.quotes == 2  # the section and the snapshot
        assert [p.id for p in report.canvas_quotes_unplaced.sections] == [theme_id]
        sent = report.to_dict()
        assert WithdrawalReportResponse.model_validate(sent).model_dump() == sent

        outcome = _withdraw(db)
        assert outcome.canvas_quotes_unplaced == report.canvas_quotes_unplaced.quotes
        (left,) = _pins_in(db.get(CanvasTheme, theme_id).content)
        assert left == pin, "never guessed: left as it was"


class TestADisplayItCannotWalk:
    """It might hold their words, so the withdrawal stops (the scrub's fail-closed rule)."""

    @pytest.mark.parametrize("display", [
        "{not json",
        ["a", "list"],
        {"rows": {"not": "a list"}},
        {"rows": [{"key": "r", "pins": "not a list"}]},
        {"rows": [{"key": "r", "pins": ["not an object"]}]},
    ], ids=["unparseable", "not-an-object", "rows", "pins", "a-pin"])
    def test_the_withdrawal_raises(self, db_session, display):
        db = db_session
        _project(db)
        _section(db, {"type": "joint-display", "attrs": {"displayKey": "k", "display": display}})
        with pytest.raises(CanvasScrubError):
            _withdraw(db)

    def test_a_display_with_no_rows_is_nothing_to_walk(self, db_session):
        """The control: an empty display reads, so the stops above are about shape."""
        db = db_session
        _project(db)
        _section(db, {"type": "joint-display", "attrs": {"displayKey": "k", "display": {}}},
                 {"type": "joint-display", "attrs": {"displayKey": "k2"}})
        assert _withdraw(db).canvas_embeds_scrubbed == 0
