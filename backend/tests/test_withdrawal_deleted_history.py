"""#1473 (b) and its Canvas sibling — what a DELETED segment held, after a withdrawal.

An Unmerge deletes the merge result, and an Unsplit deletes the split's children. The
rows go, and with them every link `withdrawal_report.reached_turns` follows, so two
copies of the person's words outlived the withdrawal:

- the conversation door's `segment_updated` entry on the deleted segment, which keeps
  `old_text` / `new_text` (the Excel Audit Trail exports it);
- a canvas copy of a quote made on a merge result: its quote went with the segment, and
  its words span the merge's join, so D8's "inside one of their turns" never held.

Decision D5 of the git-ignored 2026-10-30 pre-cut review record:
walk the merged / unmerged / split / unsplit history from the reached turns
through deleted ids (`services/withdrawal_history.py`).

Each case here is one the HTTP census (`test_withdrawal_census.py`) does not isolate:
the walk's depth, the LIFETIME bound a reused id needs, and the other speaker's words,
which must survive.
"""

from __future__ import annotations

import json

from app.models.audit import AuditEntry
from app.models.canvas import Canvas, CanvasTheme
from app.models.conversation import Conversation
from app.models.excerpt import Excerpt
from app.models.participant import Participant
from app.models.project import Project
from app.models.segment import Segment
from app.models.speaker import Speaker
from app.schemas.segment import SegmentSplitRange
from app.services.audit import log_action
from app.services.segment_operations import (
    merge_segments,
    split_segment,
    unmerge_segment,
    unsplit_segment,
)
from app.services.withdrawal_redaction import (
    AUDIT_REDACTION_MARK,
    BLANKED_SEGMENT_TEXT,
    apply_withdrawal,
)

WREN = "Wren's private words here."
OLA = "Ola replies at length."
KAI = "Kai adds a thought."
OLA_AGAIN = "Ola again speaks."


def _project(db):
    """Wren (participant 1) withdraws; Ola and Kai stay. Four turns, in order."""
    db.add(Project(id=1, name="P", user_id=1)); db.flush()
    db.add(Conversation(id=1, project_id=1, name="C"))
    db.add_all([
        Participant(id=1, project_id=1, identifier="W1", display_name="Wren"),
        Participant(id=2, project_id=1, identifier="O1", display_name="Ola"),
        Participant(id=3, project_id=1, identifier="K1", display_name="Kai"),
    ])
    db.flush()
    db.add_all([
        Speaker(id=1, project_id=1, name="Wren", participant_id=1),
        Speaker(id=2, project_id=1, name="Ola", participant_id=2),
        Speaker(id=3, project_id=1, name="Kai", participant_id=3),
    ])
    db.flush()
    for i, (sp, text) in enumerate(((1, WREN), (2, OLA), (3, KAI), (2, OLA_AGAIN))):
        db.add(Segment(id=i + 1, conversation_id=1, speaker_id=sp, sequence_order=i,
                       text=text, word_count=len(text.split())))
    db.flush()


def _merge(db, ids):
    merged, _ = merge_segments(db, ids, "conversation", 1, 1, 1)
    return merged


def _unmerge(db, segment_id):
    unmerge_segment(db, segment_id, "conversation", 1, 1, 1)


def _split(db, segment_id, start, end):
    new, _ = split_segment(
        db, [SegmentSplitRange(segment_id=segment_id, start_offset=start, end_offset=end)],
        "conversation", 1, 1, 1)
    return new


def _unsplit(db, child_id):
    unsplit_segment(db, child_id, "conversation", 1, 1, 1)


def _edit(db, segment_id, old, new):
    """The conversation door's entry, with its keys (`routers/segments.py`)."""
    entry = log_action(db, action="segment_updated", entity_type="segment",
                       entity_id=segment_id, user_id=1, project_id=1,
                       details={"old_text": old, "new_text": new})
    db.flush()
    return entry.id


def _details(db, entry_id) -> dict:
    db.expire_all()
    return json.loads(db.get(AuditEntry, entry_id).details)


def _withdraw(db):
    out = apply_withdrawal(db, db.get(Participant, 1))
    db.flush()
    db.expire_all()
    return out


def _redacted(details: dict) -> bool:
    return (details.get("redacted") == AUDIT_REDACTION_MARK
            and details.get("old_text") is None and details.get("new_text") is None)


class TestTheAuditEntryOfADeletedSegment:
    """#1473 (b): an edit made to a segment that is gone keeps their words."""

    def test_an_edited_merge_result_that_was_unmerged(self, db_session):
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        edited = m.text + " EDITED"
        entry = _edit(db, m.id, m.text, edited)
        m_id = m.id
        _unmerge(db, m_id)
        assert db.get(Segment, m_id) is None, "precondition: the Unmerge deleted it"
        assert "private" in _details(db, entry)["old_text"], "precondition: their words"

        _withdraw(db)
        assert _redacted(_details(db, entry))

    def test_an_edited_split_child_that_was_unsplit(self, db_session):
        db = db_session
        _project(db)
        children = _split(db, 1, 0, 6)
        theirs = next(c for c in children if "private" in c.text)
        entry = _edit(db, theirs.id, theirs.text, theirs.text + " EDITED")
        child_id = theirs.id
        _unsplit(db, child_id)
        assert db.get(Segment, child_id) is None, "precondition: the Unsplit deleted it"

        _withdraw(db)
        assert _redacted(_details(db, entry))

    def test_a_child_of_a_split_of_a_merge_result_both_undone(self, db_session):
        """Two deleted levels: merge, split the result, edit a child, Unsplit, Unmerge."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        cut = m.text.index("Ola")
        children = _split(db, m.id, 0, cut)
        theirs = next(c for c in children if "private" in c.text)
        child_entry = _edit(db, theirs.id, theirs.text, theirs.text + " EDITED")
        _unsplit(db, theirs.id)
        merge_entry = _edit(db, m.id, m.text, m.text + " LATER")
        _unmerge(db, m.id)

        _withdraw(db)
        assert _redacted(_details(db, child_entry))
        assert _redacted(_details(db, merge_entry))

    def test_a_reused_id_keeps_the_next_segments_entries(self, db_session):
        """SQLite gives the next segment the deleted one's id, under the same
        `entity_id` in the audit trail. Only the deleted segment's LIFETIME — from
        the entry that made it to the entry that deleted it — is theirs."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        reused = m.id
        theirs = _edit(db, reused, m.text, m.text + " EDITED")
        _unmerge(db, reused)
        later = _merge(db, [3, 4])
        assert later.id == reused, "precondition: SQLite reused the id"
        others = _edit(db, reused, later.text, later.text + " KAIEDIT")

        _withdraw(db)
        assert _redacted(_details(db, theirs))
        kept = _details(db, others)
        assert "KAIEDIT" in kept["new_text"] and "redacted" not in kept

    def test_what_the_next_holder_of_the_id_made_is_not_walked(self, db_session):
        """Their merge result was deleted; Kai and Ola's merge took its id and was
        split, a child edited, the split undone. That split came after their
        segment's lifetime ended: Kai's edit stays."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        reused = m.id
        _unmerge(db, reused)
        later = _merge(db, [3, 4])
        assert later.id == reused, "precondition: SQLite reused the id"
        children = _split(db, later.id, 0, len(KAI))
        kais = next(c for c in children if c.text.startswith("Kai"))
        others = _edit(db, kais.id, kais.text, kais.text + " KAIEDIT")
        _unsplit(db, kais.id)

        _withdraw(db)
        kept = _details(db, others)
        assert "KAIEDIT" in kept["new_text"] and "redacted" not in kept

    def test_a_turn_given_a_deleted_segments_id_does_not_inherit_its_history(self, db_session):
        """Ola and Kai's merge was split, a child edited, and both undone; then a new
        turn of Wren's took the merge's id. The split before that belongs to the id's
        previous holder: Kai's edit stays."""
        db = db_session
        _project(db)
        p = _merge(db, [2, 3])
        children = _split(db, p.id, 0, len(OLA))
        kais = next(c for c in children if "Kai" in c.text)
        others = _edit(db, kais.id, kais.text, kais.text + " KAIEDIT")
        _unsplit(db, kais.id)
        reused = p.id
        _unmerge(db, reused)
        later = Segment(conversation_id=1, speaker_id=1, sequence_order=10,
                        text="Wren's later turn.")
        db.add(later); db.flush()
        assert later.id == reused, "precondition: SQLite reused the id"

        _withdraw(db)
        kept = _details(db, others)
        assert "KAIEDIT" in kept["new_text"] and "redacted" not in kept

    def test_a_live_merge_result_is_still_found_by_its_link(self, db_session):
        """The control: a merge result that still exists is `reached_turns`' (#1320),
        and its entry is redacted as before."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        entry = _edit(db, m.id, m.text, m.text + " EDITED")
        _withdraw(db)
        assert _redacted(_details(db, entry))


def _canvas(db, *embeds) -> int:
    canvas = Canvas(project_id=1, name="C"); db.add(canvas); db.flush()
    theme = CanvasTheme(canvas_id=canvas.id, name="T", content=json.dumps({
        "type": "doc", "content": [{"type": "excerpt-embed", "attrs": a} for a in embeds]}))
    db.add(theme); db.flush()
    return theme.id


def _embeds(db, theme_id):
    db.expire_all()
    return [n["attrs"] for n in json.loads(db.get(CanvasTheme, theme_id).content)["content"]]


def _quote(db, segment, start, end):
    """A char-range quote on `segment`, and the embed a canvas makes of it."""
    ex = Excerpt(project_id=1, segment_id=segment.id, start_offset=start, end_offset=end)
    db.add(ex); db.flush()
    return {"excerptId": ex.id, "displayText": segment.text[start:end], "conversationId": 1}


class TestTheCanvasCopyOfADeletedMergeResult:
    """The Canvas sibling: a quote on a merge result, the merge then undone."""

    def test_a_quote_across_the_join_is_scrubbed_and_the_other_half_stays(self, db_session):
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        join = m.text.index(OLA)
        across = _quote(db, m, m.text.index("words"), join + len("Ola replies"))
        olas_half = _quote(db, m, join, len(m.text))
        theme_id = _canvas(db, across, olas_half)
        _unmerge(db, m.id)
        assert db.query(Excerpt).count() == 0, "precondition: the quotes went with it"

        _withdraw(db)
        after_across, after_ola = _embeds(db, theme_id)
        assert after_across["displayText"] == BLANKED_SEGMENT_TEXT
        assert after_across["excerptId"] is None
        # Ola's words alone, inside her own restored turn: kept.
        assert after_ola == olas_half

    def test_the_merge_text_is_rebuilt_in_turn_order_not_request_order(self, db_session):
        """`merge_segments` joins the turns in their order; the entry records the ids
        as the request sent them."""
        db = db_session
        _project(db)
        m = _merge(db, [2, 1])
        assert m.text.startswith(WREN), "precondition: the merge joined in turn order"
        join = m.text.index(OLA)
        across = _quote(db, m, m.text.index("words"), join + len("Ola replies"))
        theme_id = _canvas(db, across)
        _unmerge(db, m.id)

        _withdraw(db)
        (after,) = _embeds(db, theme_id)
        assert after["displayText"] == BLANKED_SEGMENT_TEXT

    def test_the_request_order_is_tried_when_a_hidden_turns_order_went_stale(self, db_session):
        """A hidden turn keeps the position it had when it was hidden, while undoing
        an earlier merge moves the visible turns down. Here Ola's turn, merged away
        after their merge was undone, ends up numbered BEFORE Wren's — so turn order
        rebuilds the text backwards, and the ids as the request sent them are right."""
        db = db_session
        _project(db)
        rows = [(3, "Y one."), (3, "Y two."), (3, "X one."), (3, "X two."),
                (1, "Wren late words."), (2, "Ola late reply."), (3, "Kai late.")]
        for i, (sp, text) in enumerate(rows):
            db.add(Segment(id=5 + i, conversation_id=1, speaker_id=sp, sequence_order=4 + i,
                           text=text))
        db.flush()
        y = _merge(db, [5, 6])
        x = _merge(db, [7, 8])
        m = _merge(db, [9, 10])
        across = _quote(db, m, m.text.index("late words"), m.text.index(" reply"))
        theme_id = _canvas(db, across)
        _unmerge(db, m.id)
        _merge(db, [10, 11])
        _unmerge(db, x.id)
        _unmerge(db, y.id)
        db.expire_all()
        assert db.get(Segment, 10).sequence_order < db.get(Segment, 9).sequence_order, (
            "precondition: the hidden turn's position went stale")

        _withdraw(db)
        (after,) = _embeds(db, theme_id)
        assert after["displayText"] == BLANKED_SEGMENT_TEXT

    def test_a_quote_of_the_edited_wording_is_scrubbed(self, db_session):
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        edited = m.text.replace("Ola replies", "Ola then replied") + " Wren ADDED."
        _edit(db, m.id, m.text, edited)
        m.text = edited
        db.flush()
        quote = _quote(db, m, edited.index("then"), len(edited))
        theme_id = _canvas(db, quote)
        _unmerge(db, m.id)

        _withdraw(db)
        (after,) = _embeds(db, theme_id)
        assert after["displayText"] == BLANKED_SEGMENT_TEXT

    def test_a_quote_across_a_merge_of_a_merge(self, db_session):
        """Ola + Wren merged, that result merged with Kai, both undone. The quote spans
        Wren's words and Kai's, a join only the OUTER merge had — rebuilt from the
        inner result's text, which no row holds any more."""
        db = db_session
        _project(db)
        db.add_all([
            Segment(id=5, conversation_id=1, speaker_id=1, sequence_order=4,
                    text="Wren tail words."),
            Segment(id=6, conversation_id=1, speaker_id=3, sequence_order=5,
                    text="Kai closes."),
        ])
        db.flush()
        inner = _merge(db, [4, 5])
        outer = _merge(db, [inner.id, 6])
        start = outer.text.index("Wren tail")
        across = _quote(db, outer, start, len(outer.text))
        # Ola's words alone, inside the INNER result — a part of the outer one that
        # no row holds; the inner result decides it, and it is not theirs.
        olas = _quote(db, outer, 0, len(OLA_AGAIN))
        assert (across["displayText"], olas["displayText"]) == (
            "Wren tail words. Kai closes.", OLA_AGAIN)
        theme_id = _canvas(db, across, olas)
        _unmerge(db, outer.id)
        _unmerge(db, inner.id)

        _withdraw(db)
        after_across, after_olas = _embeds(db, theme_id)
        assert after_across["displayText"] == BLANKED_SEGMENT_TEXT
        assert after_olas == olas

    def test_a_merge_with_a_segment_that_took_their_deleted_merges_id(self, db_session):
        """Wren + Ola merged and undone; Kai + Ola's merge took that id; it was then
        merged with a new turn of Wren's, and undone. That original was Kai and Ola's
        when it was merged: its text is theirs-not (the quote across it and Wren's turn
        is scrubbed) and a quote of Kai's words alone stays."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        reused = m.id
        _unmerge(db, reused)
        k = _merge(db, [3, 4])
        assert k.id == reused, "precondition: SQLite reused the id"
        tail = Segment(conversation_id=1, speaker_id=1, sequence_order=3,
                       text="Wren tail words.")
        db.add(tail); db.flush()
        m3 = _merge(db, [k.id, tail.id])
        across = _quote(db, m3, m3.text.index("again"), m3.text.index(" words."))
        kai_only = _quote(db, m3, 0, len(KAI))
        assert (across["displayText"], kai_only["displayText"]) == (
            "again speaks. Wren tail", KAI)
        theme_id = _canvas(db, across, kai_only)
        _unmerge(db, m3.id)

        _withdraw(db)
        after_across, after_kai = _embeds(db, theme_id)
        assert after_across["displayText"] == BLANKED_SEGMENT_TEXT
        assert after_kai == kai_only

    def test_a_deleted_merge_of_other_people_is_not_theirs(self, db_session):
        """Kai and Ola's merge, undone, whose id their merge also held: its quote
        across the join stays. Its edit sits under the same `entity_id` as theirs,
        so wording gathered by id rather than by lifetime would take it."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2])
        reused = m.id
        _unmerge(db, reused)
        later = _merge(db, [3, 4])
        assert later.id == reused, "precondition: SQLite reused the id"
        _edit(db, later.id, later.text, later.text + " KAIEDIT")
        join = later.text.index(OLA_AGAIN)
        theirs_not = _quote(db, later, 0, join + len("Ola again"))
        theme_id = _canvas(db, theirs_not)
        _unmerge(db, later.id)

        _withdraw(db)
        (after,) = _embeds(db, theme_id)
        assert after == theirs_not
