"""#687 — the code-point offset basis, and the fixtures the suite never had.

An AST sweep of the backend suite found **656 non-ASCII string literals, all BMP**
— overwhelmingly em-dashes in docstrings. Zero astral, zero combining marks, zero
RTL. That is why a defect on every char-offset path survived to v1.3.0: the offset
code was never exercised with data that could expose it.

These fixtures exist to change that. `ASTRAL_CASES` is deliberately shared, so a new
offset-touching test can pull the same corpus rather than inventing an ASCII one.
"""

from __future__ import annotations

import pytest

from app.services.text_offsets import has_astral, utf16_to_codepoint


# Each case: (label, text, the phrase a user would select inside it).
# The BMP entries are load-bearing NEGATIVES — they pin that the defect is
# astral-only, which is what makes the repair migration's WHERE clause sound.
ASTRAL_CASES = [
    ("emoji U+1F600", "Reaction 😀 then CODE THIS PHRASE and more", True),
    ("CJK Ext-B U+20000", "Glyph 𠀀 then CODE THIS PHRASE and more", True),
    ("math alnum U+1D400", "Sym 𝐀 then CODE THIS PHRASE and more", True),
    ("ZWJ family", "Fam 👨‍👩‍👧‍👦 then CODE THIS PHRASE and more", True),
    ("flag (regional indicators)", "Flag 🇺🇸 then CODE THIS PHRASE and more", True),
    ("skin-tone modifier", "Wave 👋🏽 then CODE THIS PHRASE and more", True),
    ("combining e + U+0301", "Café́ then CODE THIS PHRASE and more", False),
    ("Arabic (RTL)", "مرحبا then CODE THIS PHRASE and more", False),
    ("Devanagari", "नमस्ते then CODE THIS PHRASE and more", False),
    ("Thai", "สวัสดี then CODE THIS PHRASE and more", False),
    ("plain ASCII", "Hello then CODE THIS PHRASE and more", False),
]

TARGET = "CODE THIS PHRASE"


def _utf16_index_of(text: str, needle: str) -> int:
    """The index a BROWSER would report — UTF-16 code units.

    This is what `computeCharOffset` produced before the fix (and what every
    pre-v5 archive still carries), so it is the input the conversion must undo.
    """
    return len(text[: text.index(needle)].encode("utf-16-le")) // 2


@pytest.mark.parametrize("label,text,is_astral", ASTRAL_CASES, ids=[c[0] for c in ASTRAL_CASES])
def test_has_astral_classifies_the_corpus(label, text, is_astral):
    """The predicate that scopes both the migration and the import repair.

    If this drifts, the repair silently stops touching rows that need it (or starts
    touching rows that do not), and nothing else would notice.
    """
    assert has_astral(text) is is_astral


@pytest.mark.parametrize("label,text,is_astral", ASTRAL_CASES, ids=[c[0] for c in ASTRAL_CASES])
def test_converting_a_browser_offset_recovers_the_selected_text(label, text, is_astral):
    """The whole defect, in one assertion, across the whole corpus.

    Pre-fix, slicing the browser's UTF-16 index with Python code points returned
    drifted text for the astral half. Converting first must return the exact phrase
    for EVERY case — astral and BMP alike.
    """
    u16 = _utf16_index_of(text, TARGET)
    cp = utf16_to_codepoint(text, u16)
    assert text[cp : cp + len(TARGET)] == TARGET


@pytest.mark.parametrize("label,text,is_astral", ASTRAL_CASES, ids=[c[0] for c in ASTRAL_CASES])
def test_the_bases_diverge_exactly_on_the_astral_cases(label, text, is_astral):
    """Pins the SCOPE claim, not just the fix.

    BMP text has drift 0, so the two bases coincide and no repair is needed —
    that is what bounds the migration to a small, identifiable row set. Asserting
    it here means a future change that widened the drift to BMP would fail loudly
    rather than quietly enlarging the blast radius.
    """
    u16 = _utf16_index_of(text, TARGET)
    cp = text.index(TARGET)
    assert (u16 != cp) is is_astral, f"{label}: drift={u16 - cp}"


def test_conversion_clamps_rather_than_raising():
    text = "Reaction 😀 done"
    assert utf16_to_codepoint(text, -5) == 0
    assert utf16_to_codepoint(text, 0) == 0
    # Past the end resolves to the code-point length, not an exception — a stale
    # offset in an old archive must not fail an import.
    assert utf16_to_codepoint(text, 10_000) == len(text)


def test_an_index_inside_a_surrogate_pair_resolves_to_the_pair():
    """Only reachable from malformed input; the DOM never hands one out.

    Resolving to the pair's own code-point index (rather than raising) is the
    documented behaviour — a selection boundary is not worth an exception.
    """
    text = "ab😀cd"  # 😀 occupies UTF-16 units 2..3, code point index 2
    assert utf16_to_codepoint(text, 2) == 2
    assert utf16_to_codepoint(text, 3) == 3  # mid-pair → next boundary
    assert utf16_to_codepoint(text, 4) == 3  # after the pair
