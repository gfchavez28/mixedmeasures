"""Character-offset basis conversion (#687).

Excerpt char offsets are stored in **code points**, matching Python string indexing
and REFI-QDA (which specifies text selections as Unicode codepoints, first codepoint
numbered zero). The browser produces them in **UTF-16 code units**, and before the
#687 fix nothing converted — so any excerpt on a segment containing an astral-plane
character pointed at the wrong text everywhere Python touched it.

This module exists for the ONE remaining place that still receives pre-fix numbers:
a `.mmproject` written by a build older than format v5. The live wire is fixed at the
producer (`frontend/src/lib/text-offsets.ts`), and every other backend consumer
already indexed code points correctly.

⚠️ The repair migration (`a1b2c3d4e5f7`) deliberately INLINES its own copy of this
arithmetic rather than importing from here. A migration is a frozen historical
artifact — it must keep doing what it did on the day it ran, even if this module's
behaviour is later changed. That duplication is intentional, not drift.
"""

from __future__ import annotations


def has_astral(text: str) -> bool:
    """True if `text` contains a character outside the BMP.

    Python strings index code points, so an astral character is simply one above
    U+FFFF — no surrogate inspection needed, that is a UTF-16 concern. Every BMP
    character is one unit in both bases, so this is exactly the predicate for
    "could the two bases disagree here?".
    """
    return any(ord(ch) > 0xFFFF for ch in text)


def utf16_to_codepoint(text: str, utf16_index: int) -> int:
    """UTF-16 code-unit index → code-point index.

    Clamps at both ends: a negative index is 0, and one past the end of the string
    resolves to the string's code-point length. An index landing INSIDE a surrogate
    pair resolves to that pair's own code-point index rather than raising — a stale
    offset in an old archive is not worth failing an import over.
    """
    if utf16_index <= 0:
        return 0
    if not has_astral(text):
        return min(utf16_index, len(text))
    cp = 0
    units = 0
    for ch in text:
        if units >= utf16_index:
            break
        units += 2 if ord(ch) > 0xFFFF else 1
        cp += 1
    return cp
