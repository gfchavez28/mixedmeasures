"""#1613 — a quote across the join of two
OTHER people's turns in an undone merge is not the withdrawn person's.

#1473 (b) rebuilds a deleted merge result's text from its originals and takes a canvas
quote of it as theirs when it lies inside the rebuilt text and wholly inside no single
original. A merge of three turns — theirs, Ola's, Kai's — has two joins, and a quote of
Ola's and Kai's words across THEIR join passed that test: Wren's withdrawal removed it.
The rebuilt text now carries where their parts sit, and a quote must reach one.
"""

from __future__ import annotations

from app.models.participant import Participant
from app.models.segment import Segment
from app.services.withdrawal_redaction import BLANKED_SEGMENT_TEXT
from app.services.withdrawal_report import build_withdrawal_report
from tests.test_withdrawal_deleted_history import (
    KAI,
    OLA,
    _canvas,
    _edit,
    _embeds,
    _merge,
    _project,
    _quote,
    _split,
    _unmerge,
    _unsplit,
    _withdraw,
)


def _turns(db, *rows):
    """More turns after the fixture's four: `(speaker, text)`, ids from 5."""
    for i, (sp, text) in enumerate(rows):
        db.add(Segment(id=5 + i, conversation_id=1, speaker_id=sp, sequence_order=4 + i,
                       text=text))
    db.flush()
    return [5 + i for i in range(len(rows))]


def _at(db, m, text):
    i = m.text.index(text)
    return _quote(db, m, i, i + len(text))


class TestAThreeTurnMerge:

    def test_the_others_join_stays_and_theirs_goes(self, db_session):
        db = db_session
        _project(db)
        m = _merge(db, [1, 2, 3])
        others = _at(db, m, "at length. Kai adds")
        theirs = _at(db, m, "words here. Ola replies")  # positive control
        theme_id = _canvas(db, others, theirs)
        _unmerge(db, m.id)

        _withdraw(db)
        after_others, after_theirs = _embeds(db, theme_id)
        assert after_others == others
        assert after_theirs["displayText"] == BLANKED_SEGMENT_TEXT

    def test_the_report_and_the_act_agree(self, db_session):
        """D158: the kept quote is placed (its conversation is live), so neither the
        report nor the act counts it as one it cannot place."""
        db = db_session
        _project(db)
        m = _merge(db, [1, 2, 3])
        others = _at(db, m, "at length. Kai adds")
        theme_id = _canvas(db, others)
        _unmerge(db, m.id)

        predicted = build_withdrawal_report(db, db.get(Participant, 1)).canvas_quotes_unplaced
        outcome = _withdraw(db)
        assert predicted.quotes == outcome.canvas_quotes_unplaced == 0
        assert _embeds(db, theme_id) == [others]

    def test_the_same_words_across_their_join_and_the_others_go(self, db_session):
        """The embed keeps no offset. "alpha beta" stands across their join AND across
        Ola's and Kai's: it may be theirs, so it goes (ANY place reaching theirs)."""
        db = db_session
        _project(db)
        ids = _turns(db, (1, "W1 alpha"), (2, "beta W1 alpha"), (3, "beta gamma."))
        m = _merge(db, ids)
        assert m.text.count("alpha beta") == 2, "precondition: two places, one theirs"
        quote = _at(db, m, "alpha beta")
        theme_id = _canvas(db, quote)
        _unmerge(db, m.id)

        _withdraw(db)
        (after,) = _embeds(db, theme_id)
        assert after["displayText"] == BLANKED_SEGMENT_TEXT

    def test_their_turn_in_the_middle_is_placed_to_the_character(self, db_session):
        """Their turn between Ola's and Kai's: where it sits is counted past each
        join. A quote taking only their closing full stop and Kai's words reaches
        them by one character, and goes; Ola's and Kai's own words around it stay."""
        db = db_session
        _project(db)
        ids = _turns(db, (2, "Ola first."), (1, "Wren middle words."), (3, "Kai last."))
        m = _merge(db, ids)
        touching = _at(db, m, ". Kai last")
        olas = _at(db, m, "Ola first")
        theme_id = _canvas(db, touching, olas)
        _unmerge(db, m.id)

        _withdraw(db)
        after_touching, after_olas = _embeds(db, theme_id)
        assert after_touching["displayText"] == BLANKED_SEGMENT_TEXT
        assert after_olas == olas

    def test_words_also_wholly_inside_one_turn_are_that_turns_to_decide(self, db_session):
        """Unchanged control: "yes no way" stands across their join and wholly inside
        Kai's turn. As before, a quote whose words one original holds whole is that
        original's to decide — Kai's, so it stays."""
        db = db_session
        _project(db)
        ids = _turns(db, (1, "I say yes"), (2, "no way at all"), (3, "I say yes no way"))
        m = _merge(db, ids)
        quote = _at(db, m, "yes no way")
        theme_id = _canvas(db, quote)
        _unmerge(db, m.id)

        _withdraw(db)
        assert _embeds(db, theme_id) == [quote]


class TestNested:

    def test_a_merge_of_their_merge_places_their_words_inside_it(self, db_session):
        """Wren + Ola merged; that merged with Kai; both undone. The outer text is
        rebuilt from the inner one, whose own part of theirs is carried through: the
        quote across Ola's and Kai's join stays, the one across theirs goes."""
        db = db_session
        _project(db)
        inner = _merge(db, [1, 2])
        outer = _merge(db, [inner.id, 3])
        others = _at(db, outer, "at length. Kai adds")
        theirs = _at(db, outer, "words here. Ola replies")
        theme_id = _canvas(db, others, theirs)
        _unmerge(db, outer.id)
        _unmerge(db, inner.id)

        _withdraw(db)
        after_others, after_theirs = _embeds(db, theme_id)
        assert after_others == others
        assert after_theirs["displayText"] == BLANKED_SEGMENT_TEXT

    def test_an_edit_of_their_merge_leaves_the_outer_text_unplaced_and_the_rule_as_before(
        self, db_session,
    ):
        """Wren + Ola merged and the result EDITED; merged with Kai; both undone. The
        edit's wording has no join to place their words by, so neither has the outer
        text built on it: there the join rule alone decides, as before — and their
        quote across the edited text and Kai's goes."""
        db = db_session
        _project(db)
        inner = _merge(db, [1, 2])
        edited = inner.text + " EDIT"
        _edit(db, inner.id, inner.text, edited)
        inner.text = edited
        db.flush()
        outer = _merge(db, [inner.id, 3])
        theirs = _at(db, outer, "words here. Ola replies at length. EDIT Kai adds")
        theme_id = _canvas(db, theirs)
        _unmerge(db, outer.id)
        _unmerge(db, inner.id)

        _withdraw(db)
        (after,) = _embeds(db, theme_id)
        assert after["displayText"] == BLANKED_SEGMENT_TEXT

    def test_an_edited_piece_of_their_split_turn_is_theirs_whole(self, db_session):
        """Their turn split, a piece edited, that piece merged with Ola's and Kai's
        turns; the merge and the split undone. The piece offers its EDITS' wordings
        (nothing else records it), all theirs, so Ola's and Kai's join still stays."""
        db = db_session
        _project(db)
        children = _split(db, 1, 0, len("Wren's"))
        piece = next(c for c in children if "private" in c.text)
        new = piece.text + " ADDED"
        _edit(db, piece.id, piece.text, new)
        piece.text = new
        db.flush()
        m = _merge(db, [piece.id, 2, 3])
        assert m.text.startswith(new), "precondition: the merge took the edited piece"
        others = _at(db, m, "at length. Kai adds")
        theme_id = _canvas(db, others)
        _unmerge(db, m.id)
        _unsplit(db, piece.id)
        db.expire_all()
        assert db.get(Segment, piece.id) is None, "precondition: the Unsplit deleted it"

        _withdraw(db)
        assert _embeds(db, theme_id) == [others]


def test_kai_is_kai():
    """The fixture's words the quotes above name (a typo here would vacate them)."""
    assert OLA.endswith("at length.") and KAI.startswith("Kai adds")
