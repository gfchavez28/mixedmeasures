"""Matching things by a researcher-supplied identifier — the ONE place the
"a key naming two candidates matches NOTHING" rule lives.

Extracted 2026-09-22 (queue row 49) from
`participant_linking.py::link_rows_by_identifier_column`, which had been the only
implementation and is now a caller.

🔴 **WHY IT IS A RULE AND NOT A PREFERENCE.** When a value appears on two
candidates there is no non-arbitrary way to pick one, and every available
tie-break encodes a judgement the researcher never made — lowest id is "whichever
was imported first", most recent is "whichever was edited last". Linking one of
them silently attaches a person, or a coding, to the wrong row, and nothing
afterwards can tell that it happened. **So neither is taken, and the duplicate is
REPORTED** — which is a refusal the researcher can act on.

⚠️ **The comparison is TRIM-THEN-EXACT and stays CASE-SENSITIVE** (#414 DEC-2).
Trimming catches the spreadsheet round trip that pads a cell; case-folding would
merge `P01` and `p01`, which in a participant register can genuinely be two
people.

⚠️ **Every emptiness check is on the STRING, never on truthiness of a result.**
Index 0 is a valid position and `""` is a valid absence — #414's `is not None`
rule, reached from the key side.

**This module answers ONE question and deliberately owns nothing else.** The two
callers match different things (a dataset ROW to a participant; a coding UNIT to
a segment or cell) against different key spaces, so a shared "matcher" would be a
shared parameter list rather than a shared rule.
"""
from __future__ import annotations

from typing import Iterable, TypeVar

T = TypeVar("T")

#: `Participant.identifier` is `String(100)`; a longer value cannot be stored, so
#: it is reported as unusable rather than truncated into a different identifier.
IDENTIFIER_MAX_LENGTH = 100


def normalize_key(raw: str | None) -> str:
    """Trim a supplied identifier. `None` and whitespace-only both become `""`.

    The ONE normalisation, so a matcher and the refusal it reports can never
    disagree about what the researcher's cell said.
    """
    return raw.strip() if raw else ""


def group_unique_by_key(
    pairs: Iterable[tuple[str, T]],
) -> tuple[dict[str, T], list[str]]:
    """Split `(key, candidate)` pairs into the unambiguous ones and the duplicates.

    Returns `(unique, duplicate_keys)`:

    - `unique` — `{key: the one candidate}` for every key naming exactly one;
    - `duplicate_keys` — sorted, for the refusal. **Their candidates appear in
      neither result**: a key naming two things matches nothing.

    ⚠️ Keys are taken as given. Callers normalise first (`normalize_key`) and
    decide their own emptiness rule, because "blank" means different things to a
    participant register and to a coding import.
    """
    by_key: dict[str, list[T]] = {}
    for key, candidate in pairs:
        by_key.setdefault(key, []).append(candidate)

    unique = {k: v[0] for k, v in by_key.items() if len(v) == 1}
    duplicates = sorted(k for k, v in by_key.items() if len(v) > 1)
    return unique, duplicates
