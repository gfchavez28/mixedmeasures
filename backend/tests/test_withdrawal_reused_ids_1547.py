"""#1547 (D159) — a withdrawal reads a turn's or an answer's history only within its OWN life.

SQLite gives a freed id to the next new row (no AUTOINCREMENT), and an audit entry stays
keyed on the id it was written for. `apply_withdrawal` read every entry under a reached
turn's id as that turn's, so the next speaker given a freed id withdrew someone else's
history with them: the previous holder's edit was redacted, and its words — matched
against orphan canvas quotes in the new holder's conversation — blanked ANOTHER
participant's quote. Found by the 2026-11-06e `/codebase-audit` (F4) for an id an Unmerge
freed; WIDENED by the 2026-11-08 review to an id a conversation delete freed and an import
re-used (no merge or split ever touched it), and to the answer side.

The rule is ONE function, `withdrawal_history.history_starts` — three lower bounds, each
never later than the truth — read by the walk's seeds and by both of `apply_withdrawal`'s
reads (the words, the redaction set), so the two cannot disagree. An answer's entry names
its column, so one naming another column is a previous holder's.
"""
from __future__ import annotations

import json

from app.models.canvas import Canvas, CanvasTheme
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.excerpt import Excerpt
from app.models.participant import Participant
from app.models.segment import Segment
from app.services.audit import log_action
from app.services.withdrawal_history import history_starts, segment_history
from app.services.withdrawal_redaction import BLANKED_SEGMENT_TEXT, apply_withdrawal
from tests.test_withdrawal_deleted_history import (
    OLA,
    _canvas,
    _details,
    _edit,
    _embeds,
    _merge,
    _project,
    _redacted,
    _unmerge,
    _withdraw,
)


def _wrens_later_turn(db, conversation_id=1, order=10):
    turn = Segment(conversation_id=conversation_id, speaker_id=1, sequence_order=order,
                   text="Wren's later turn.")
    db.add(turn)
    db.flush()
    return turn


class TestAnIdAnUnmergeFreed:
    """The audit's case: Ola's and Kai's turns merged, the result edited, the merge undone,
    and Wren's next turn given the freed id."""

    def test_the_previous_holders_edit_is_not_wrens_history(self, db_session):
        db = db_session
        _project(db)
        p = _merge(db, [2, 3])
        entry = _edit(db, p.id, p.text, p.text + " OLAKAIEDIT")
        reused = p.id
        _unmerge(db, reused)
        assert _wrens_later_turn(db).id == reused, "precondition: SQLite reused the id"
        _withdraw(db)
        kept = _details(db, entry)
        assert not _redacted(kept) and "OLAKAIEDIT" in kept["new_text"], kept

    def _olas_orphan_after(self, db, reuse: bool) -> str:
        _project(db)
        p = _merge(db, [2, 3])
        _edit(db, p.id, p.text, p.text + " OLAKAIEDIT")
        ola = db.get(Segment, 2)
        ex = Excerpt(project_id=1, segment_id=ola.id, start_offset=0, end_offset=len(OLA))
        db.add(ex)
        db.flush()
        theme = _canvas(db, {"excerptId": ex.id, "displayText": OLA, "conversationId": 1})
        db.delete(ex)
        db.flush()
        reused = p.id
        _unmerge(db, reused)
        if reuse:
            assert _wrens_later_turn(db).id == reused, "precondition: SQLite reused the id"
        _withdraw(db)
        (after,) = _embeds(db, theme)
        return after["displayText"]

    def test_CONTROL_olas_orphan_quote_survives_without_the_reuse(self, db_session):
        assert self._olas_orphan_after(db_session, reuse=False) == OLA

    def test_olas_orphan_quote_survives_when_wren_took_the_id(self, db_session):
        assert self._olas_orphan_after(db_session, reuse=True) == OLA

    def test_CONTROL_wrens_own_edit_of_that_turn_is_still_redacted(self, db_session):
        """The bound must not cut the NEW holder's history: an edit of Wren's turn after
        it took the id is Wren's, and goes."""
        db = db_session
        _project(db)
        p = _merge(db, [2, 3])
        reused = p.id
        _unmerge(db, reused)
        later = _wrens_later_turn(db)
        assert later.id == reused
        own = _edit(db, later.id, later.text, later.text + " WRENEDIT")
        _withdraw(db)
        assert _redacted(_details(db, own))


class TestAnIdAConversationImportReused:
    """No merge or split ever touched the id: a conversation deleted before #1546 left an
    edit of Kai's keyed on turn 5, and the next import gave Wren's new turn that id."""

    def _seed(self, db):
        _project(db)
        db.add(Conversation(id=2, project_id=1, name="Deleted interview"))
        db.flush()
        kais = Segment(conversation_id=2, speaker_id=3, sequence_order=0, text="Kai, earlier.")
        db.add(kais)
        db.flush()
        old = _edit(db, kais.id, kais.text, f"Kai, earlier. KAIOLD {OLA}")
        reused = kais.id
        # A delete from before the fix: no strip, so the entry keeps its words.
        db.delete(db.get(Conversation, 2))
        db.flush()
        db.add(Conversation(id=3, project_id=1, name="New interview"))
        db.flush()
        wren = Segment(conversation_id=3, speaker_id=1, sequence_order=0, text="Wren, new.")
        ola = Segment(conversation_id=3, speaker_id=2, sequence_order=1, text=OLA)
        db.add_all([wren, ola])
        db.flush()
        assert wren.id == reused, "precondition: SQLite reused the id"
        # The import door writes its entry AFTER the turns it makes.
        log_action(db, action="imported", entity_type="conversation", entity_id=3,
                   user_id=1, project_id=1, details={"name": "New interview"})
        db.flush()
        return old, wren, ola

    def test_the_deleted_interviews_edit_is_not_the_new_turns_history(self, db_session):
        db = db_session
        old, _, ola = self._seed(db)
        ex = Excerpt(project_id=1, segment_id=ola.id, start_offset=0, end_offset=len(OLA))
        db.add(ex)
        db.flush()
        theme = _canvas(db, {"excerptId": ex.id, "displayText": OLA, "conversationId": 3})
        db.delete(ex)
        db.flush()
        _withdraw(db)
        assert not _redacted(_details(db, old)), "Kai's old entry was read as Wren's history"
        (after,) = _embeds(db, theme)
        assert after["displayText"] == OLA, "Ola's orphan quote was taken by Kai's old words"

    def test_the_walk_does_not_start_before_the_import_either(self, db_session):
        """The deleted interview had a merge of turn 5 that was edited and undone. Wren's
        new turn took id 5: the walk from it must not follow that older merge (its seed's
        start is `history_starts`'), or Wren's withdrawal redacts the old merge's edit."""
        db = db_session
        _project(db)
        db.add(Conversation(id=2, project_id=1, name="Deleted interview"))
        db.flush()
        a = Segment(conversation_id=2, speaker_id=2, sequence_order=0, text="Ola, earlier.")
        b = Segment(conversation_id=2, speaker_id=3, sequence_order=1, text="Kai, earlier.")
        db.add_all([a, b])
        db.flush()
        from app.services.segment_operations import merge_segments, unmerge_segment
        merged, _ = merge_segments(db, [a.id, b.id], "conversation", 2, 1, 1)
        old = _edit(db, merged.id, merged.text, merged.text + " OLDMERGEEDIT")
        unmerge_segment(db, merged.id, "conversation", 2, 1, 1)
        reused = a.id
        db.delete(db.get(Conversation, 2))                  # a delete from before the fix
        db.flush()
        db.add(Conversation(id=3, project_id=1, name="New interview"))
        db.flush()
        # The import makes its turns in one go, so the freed ids come back in order.
        wren = Segment(conversation_id=3, speaker_id=1, sequence_order=0, text="Wren, new.")
        db.add(wren)
        db.flush()
        while wren.id != reused:
            wren = Segment(conversation_id=3, speaker_id=1, sequence_order=wren.sequence_order + 1,
                           text="Wren, again.")
            db.add(wren)
            db.flush()
            assert wren.id <= reused + 3, "precondition: SQLite gives the freed ids back"
        log_action(db, action="imported", entity_type="conversation", entity_id=3,
                   user_id=1, project_id=1, details={"name": "New interview"})
        db.flush()
        _withdraw(db)
        assert not _redacted(_details(db, old)), "the walk followed the deleted interview's merge"

    def test_CONTROL_an_edit_after_the_import_is_the_new_turns(self, db_session):
        db = db_session
        _, wren, _ = self._seed(db)
        own = _edit(db, wren.id, wren.text, wren.text + " WRENEDIT")
        _withdraw(db)
        assert _redacted(_details(db, own))


class TestTheBounds:
    """`history_starts` unit: each bound alone, and the max."""

    def test_each_bound_and_their_max(self, db_session):
        db = db_session
        _project(db)
        made = _merge(db, [2, 3])                               # a merge MAKES this id
        db.flush()
        h = segment_history(db, 1)
        (m,) = h.made[made.id]
        assert history_starts(db, 1, {made.id: 1}, h)[made.id] == m  # its own making counts

        _unmerge(db, made.id)                                   # an Unmerge DELETES it
        h = segment_history(db, 1)
        (d,) = h.deleted[made.id]
        assert history_starts(db, 1, {made.id: 1}, h)[made.id] == d + 1

        imp = log_action(db, action="imported", entity_type="conversation", entity_id=1,
                         user_id=1, project_id=1, details={"name": "C"})
        db.flush()
        assert history_starts(db, 1, {made.id: 1}, h)[made.id] == imp.id + 1
        assert history_starts(db, 1, {4: 1})[4] == imp.id + 1  # an import-made turn
        assert history_starts(db, 1, {4: 999})[4] == 0          # no bound at all: from the start


class TestAnAnswersEntryNamesItsColumn:
    """The answer side: Wren's answer took the id of a deleted answer in ANOTHER column."""

    def _seed(self, db):
        _project(db)
        ds = Dataset(project_id=1, name="Survey")
        db.add(ds)
        db.flush()
        cols = []
        for i, name in enumerate(("Q1", "Q2")):
            col = DatasetColumn(dataset_id=ds.id, column_code=name, column_text=name,
                                column_name=name, column_type=ColumnType.OPEN_TEXT,
                                sequence_order=i, display_order=i, source="manual")
            db.add(col)
            db.flush()
            cols.append(col)
        olas_row = DatasetRow(dataset_id=ds.id, participant_id=2, row_identifier="O1")
        wrens_row = DatasetRow(dataset_id=ds.id, participant_id=1, row_identifier="W1")
        db.add_all([olas_row, wrens_row])
        db.flush()
        olas = DatasetValue(row_id=olas_row.id, column_id=cols[0].id, value_text="Ola's answer.")
        db.add(olas)
        db.flush()
        theirs = log_action(db, action="value_updated", entity_type="dataset_value",
                            entity_id=olas.id, user_id=1, project_id=1,
                            details={"dataset_id": ds.id, "column_id": cols[0].id,
                                     "old_value": "Ola's first answer.", "new_value": "Ola's answer."})
        db.flush()
        reused = olas.id
        db.delete(olas)                                         # a delete from before the fix
        db.flush()
        wrens = DatasetValue(row_id=wrens_row.id, column_id=cols[1].id, value_text="Wren's answer.")
        db.add(wrens)
        db.flush()
        assert wrens.id == reused, "precondition: SQLite reused the id"
        return ds, cols, wrens, theirs.id

    def test_an_entry_naming_another_column_is_not_wrens(self, db_session):
        db = db_session
        _, _, _, theirs = self._seed(db)
        # A canvas quote of Ola's earlier wording, its quote gone (an orphan answer quote).
        theme = _canvas(db, {"excerptId": 404, "displayText": "Ola's first answer.",
                             "conversationId": None})
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        details = _details(db, theirs)
        assert "redacted" not in details and details["new_value"] == "Ola's answer."
        (after,) = _embeds(db, theme)
        assert after["displayText"] == "Ola's first answer."

    def test_CONTROL_wrens_own_answers_entry_is_redacted_and_matched(self, db_session):
        db = db_session
        ds, cols, wrens, _ = self._seed(db)
        own = log_action(db, action="value_updated", entity_type="dataset_value",
                         entity_id=wrens.id, user_id=1, project_id=1,
                         details={"dataset_id": ds.id, "column_id": cols[1].id,
                                  "old_value": "Wren's first answer.", "new_value": "Wren's answer."})
        db.flush()
        theme = _canvas(db, {"excerptId": 405, "displayText": "Wren's first answer.",
                             "conversationId": None})
        apply_withdrawal(db, db.get(Participant, 1))
        db.flush()
        details = json.loads(db.get(type(own), own.id).details)
        assert details.get("redacted") == "withdrawal" and details.get("new_value") is None
        (after,) = _embeds(db, theme)
        assert after["displayText"] == BLANKED_SEGMENT_TEXT
