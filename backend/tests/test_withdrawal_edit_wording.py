"""#1320 D8 x #1319: an orphan canvas embed is matched only against a turn's WORDS.

A segment's `segment_updated` audit entry carries the words before and after an
edit (`old_text` / `new_text`) and, since #1319, structural strings too — the
`quote_rebase` outcomes ("silent", "edge", "straddle", "gone"). Reading every
string in the entry made those outcome words candidates for the orphan-embed
match, so a short orphan embed reading "go" would have matched "gone" and been
blanked although it quoted someone else.
"""

import json

from app.services.withdrawal_redaction import _edit_wording_in


def _details(**kw) -> str:
    return json.dumps(kw)


def test_the_words_before_and_after_an_edit_are_read():
    raw = _details(old_text="I was not happy.", new_text="I was very happy.")
    assert _edit_wording_in(raw) == ["I was not happy.", "I was very happy."]


def test_the_quote_rebase_outcomes_are_never_read_as_words():
    raw = _details(
        old_text="before",
        new_text="after",
        quote_rebase=[{"excerpt_id": 7, "outcome": "gone"},
                      {"excerpt_id": 8, "outcome": "edge"}],
        speaker_name="Sam",
    )
    got = _edit_wording_in(raw)
    assert got == ["before", "after"]
    assert not any(w in got for w in ("gone", "edge", "Sam"))


def test_an_entry_without_words_yields_nothing():
    assert _edit_wording_in(_details(quote_rebase=[{"outcome": "silent"}])) == []
    assert _edit_wording_in(None) == []
    assert _edit_wording_in("") == []


def test_unreadable_or_non_object_details_yield_nothing():
    assert _edit_wording_in("not json") == []
    assert _edit_wording_in(json.dumps(["old_text", "x"])) == []
    assert _edit_wording_in(_details(old_text=3, new_text=None)) == []
