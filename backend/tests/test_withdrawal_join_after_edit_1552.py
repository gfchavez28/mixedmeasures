"""#1552 (a) — a quote across an undone merge's join, after an original was edited.

#1473 (b) rebuilds a deleted merge result's text from its originals, so a canvas copy
of a quote made across the join (its quote went with the segment) is found again. A
LIVE original was read as its row holds it TODAY, so an edit made after the Unmerge —
a typo fixed in their turn, or in the other speaker's — rebuilt a text the merge
never held, and the embed with their words survived the withdrawal.

The rebuild now reads each live original as it was AT THE MERGE: the first text edit
after the merge recorded that text as its `old_text` (the edit door acts on visible
turns only, so nothing edits an original while it is merged away). Found by the
2026-11-06e /codebase-audit (F4, `test_join_after_edit.py`).
"""

from __future__ import annotations

from app.models.segment import Segment
from app.services.audit import log_action
from app.services.withdrawal_history import deleted_lineage
from app.services.withdrawal_redaction import BLANKED_SEGMENT_TEXT
from app.services.withdrawal_report import reached_turns
from tests.test_withdrawal_deleted_history import (
    OLA,
    WREN,
    _canvas,
    _embeds,
    _merge,
    _project,
    _quote,
    _split,
    _unmerge,
    _unsplit,
    _withdraw,
)


def _edit_text(db, segment_id: int, new: str) -> int:
    """What the conversation door does to a turn's text: the entry, then the row."""
    seg = db.get(Segment, segment_id)
    entry = log_action(db, action="segment_updated", entity_type="segment",
                       entity_id=segment_id, user_id=1, project_id=1,
                       details={"old_text": seg.text, "new_text": new})
    seg.text = new
    db.flush()
    return entry.id


def _across(db, m):
    """Their words and Ola's, across the merge's join — from "private", the word each
    edit below changes, so a text rebuilt from the wrong wording cannot hold it."""
    join = m.text.index(OLA)
    return _quote(db, m, m.text.index("private"), join + len("Ola replies"))


class TestAQuoteAcrossTheJoinAfterAnEdit:

    def test_their_turn_edited_after_the_unmerge(self, db_session):
        """The filing's case: a typo fixed in their own turn after the Unmerge."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        across = _across(db, m)
        theme_id = _canvas(db, across)
        _unmerge(db, m.id)
        _edit_text(db, 1, WREN.replace("private", "privy"))

        _withdraw(db)
        (after,) = _embeds(db, theme_id)
        assert after["displayText"] == BLANKED_SEGMENT_TEXT

    def test_the_other_speakers_turn_edited_and_her_own_half_stays(self, db_session):
        """Ola fixes her turn after the Unmerge. The quote across the join holds their
        words and is scrubbed; Ola's own half, wholly inside what HER turn held at the
        merge, is hers and stays (the merge-time text is what decides "wholly inside
        one original", too)."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        across = _across(db, m)
        olas_half = _quote(db, m, m.text.index(OLA), len(m.text))
        assert olas_half["displayText"] == OLA, "precondition: Ola's whole turn"
        theme_id = _canvas(db, across, olas_half)
        _unmerge(db, m.id)
        _edit_text(db, 2, OLA.replace("replies", "replied"))

        _withdraw(db)
        after_across, after_ola = _embeds(db, theme_id)
        assert after_across["displayText"] == BLANKED_SEGMENT_TEXT
        assert after_ola == olas_half

    def test_the_first_edit_after_the_merge_is_what_it_joined(self, db_session):
        """An edit BEFORE the merge, and two after the Unmerge: only the first edit
        after the merge replaced the text the merge joined."""
        db = db_session
        _project(db)
        # Before the merge: an earlier draft, edited into the text the merge joins.
        db.get(Segment, 1).text = "Wren's EARLIER draft here."
        db.flush()
        _edit_text(db, 1, WREN)
        m = _merge(db, [1, 2])
        across = _across(db, m)
        theme_id = _canvas(db, across)
        _unmerge(db, m.id)
        _edit_text(db, 1, "Wren's SECOND words here.")
        _edit_text(db, 1, "Wren's THIRD words here.")

        _withdraw(db)
        (after,) = _embeds(db, theme_id)
        assert after["displayText"] == BLANKED_SEGMENT_TEXT

    def test_a_speaker_change_is_not_a_text_edit(self, db_session):
        """The same door records a speaker-only change with no `old_text`; the text
        edit after it is the one that replaced the merge's words."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        across = _across(db, m)
        theme_id = _canvas(db, across)
        _unmerge(db, m.id)
        log_action(db, action="segment_updated", entity_type="segment", entity_id=1,
                   user_id=1, project_id=1,
                   details={"old_speaker_id": 1, "new_speaker_id": 1})
        db.flush()
        _edit_text(db, 1, WREN.replace("private", "privy"))

        _withdraw(db)
        (after,) = _embeds(db, theme_id)
        assert after["displayText"] == BLANKED_SEGMENT_TEXT

    def test_control_no_edit_after_the_unmerge(self, db_session):
        """Positive control (#1473 b's own case): with no edit, today's text is the
        text the merge joined, and the quote is scrubbed on either build."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        across = _across(db, m)
        theme_id = _canvas(db, across)
        _unmerge(db, m.id)

        _withdraw(db)
        (after,) = _embeds(db, theme_id)
        assert after["displayText"] == BLANKED_SEGMENT_TEXT


class TestAnOriginalWhoseIdWasFreedAfterTheMerge:

    def test_the_segment_that_took_its_id_is_not_read_as_it(self, db_session):
        """Ola's turn split, its first half merged with theirs, the merge undone, then
        the split undone — which deletes that half. Kai's later turn takes its id and
        is edited. Neither Kai's text nor Kai's edit is what the merge joined (the half
        was never edited, so its words are recorded nowhere, the module's stated
        residual for a split child)."""
        db = db_session
        _project(db)
        children = _split(db, 2, 0, len("Ola replies"))
        half = next(c for c in children if c.text.startswith("Ola replies"))
        half_id = half.id
        m = _merge(db, [1, half_id])
        _unmerge(db, m.id)
        _unsplit(db, half_id)
        db.expire_all()
        assert db.get(Segment, half_id) is None, "precondition: the Unsplit deleted it"
        kai = Segment(id=half_id, conversation_id=1, speaker_id=3, sequence_order=9,
                      text="Kai much later.")
        db.add(kai); db.flush()
        _edit_text(db, half_id, "Kai much later, edited.")

        lineage = deleted_lineage(db, 1, reached_turns(db, [1]))
        merged = [s for s in lineage.segments if s.segment_id == m.id]
        assert merged, "precondition: the walk found the undone merge"
        held = [t for s in merged for t in (*s.wordings, *s.parts)]
        assert not any("Kai" in t for t in held), held
