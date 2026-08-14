"""#687 — repair excerpt offsets stored in UTF-16 code units

Revision ID: a1b2c3d4e5f7
Revises: c4d5e6f7a8b9
Create Date: 2026-08-07

Char-range excerpt offsets were PRODUCED in the browser in **UTF-16 code units**
(`Text.length` + a DOM `Range` offset, per the DOM spec) and CONSUMED in Python by
slicing `str`, which indexes **code points**. Nothing converted between them, so any
excerpt on a segment containing an astral-plane character (emoji, CJK Extension B,
mathematical alphanumerics, ZWJ sequences, flags, skin-tone modifiers) points at the
wrong characters everywhere Python touches it — the XLSX export, the Canvas embed
cache, and the DOCX/HTML/PDF canvas export. The producer is fixed as of this release;
this repairs what it already wrote.

## Scope: astral segments only

Every BMP character occupies exactly one unit in BOTH bases, so for a segment whose
text contains no surrogate pair the two numbering systems coincide and the stored
value is already correct. That is not an optimisation — it is what makes the repair
*safe*: the rows this touches are exactly the rows that are wrong, identified from
the data rather than from a guess about provenance.

## Why this is one-way and why that is fine

The conversion is not injective in general (several UTF-16 indices inside a surrogate
pair map to one code-point index), so `downgrade()` cannot restore the exact prior
bytes. It converts back on the pair boundaries, which round-trips every offset a
browser could actually have produced — the DOM never hands out an index inside a
pair. A downgrade also lands the data on a build whose frontend reads UTF-16, so
converting back is the behaviour that build needs.

## Time-range excerpts are untouched

`start_time`/`end_time` are seconds, not string indices (D29). Only the char-range
shape (`start_offset IS NOT NULL`) is in scope, and the WHERE clause says so.
"""
from alembic import op
import sqlalchemy as sa


revision = 'a1b2c3d4e5f7'
down_revision = 'c4d5e6f7a8b9'
branch_labels = None
depends_on = None


def _has_astral(text: str) -> bool:
    """True if `text` contains a character outside the BMP.

    Python strings are code points, so an astral character is simply one above
    U+FFFF — no surrogate inspection needed (that is a UTF-16 concern).
    """
    return any(ord(ch) > 0xFFFF for ch in text)


def _utf16_to_codepoint(text: str, i16: int) -> int:
    """UTF-16 code-unit index → code-point index."""
    if i16 <= 0:
        return 0
    cp = 0
    units = 0
    for ch in text:
        if units >= i16:
            break
        units += 2 if ord(ch) > 0xFFFF else 1
        cp += 1
    return cp


def _codepoint_to_utf16(text: str, cp_index: int) -> int:
    """Code-point index → UTF-16 code-unit index (the downgrade direction)."""
    if cp_index <= 0:
        return 0
    units = 0
    for i, ch in enumerate(text):
        if i >= cp_index:
            break
        units += 2 if ord(ch) > 0xFFFF else 1
    return units


def _convert(convert) -> None:
    """Walk char-range excerpts on astral segments and rewrite their offsets."""
    conn = op.get_bind()

    rows = conn.execute(sa.text("""
        SELECT e.id, e.start_offset, e.end_offset, s.text
        FROM excerpt e
        JOIN segments s ON s.id = e.segment_id
        WHERE e.segment_id IS NOT NULL
          AND e.start_offset IS NOT NULL
    """)).fetchall()

    updates = []
    for exc_id, start, end, text in rows:
        if not text or not _has_astral(text):
            continue  # the two bases coincide — already correct
        new_start = convert(text, start)
        new_end = convert(text, end)
        if new_start == start and new_end == end:
            continue
        # ck_excerpt_offsets_valid_range requires end > start STRICTLY. A range that
        # collapses under conversion could only come from an already-degenerate row;
        # skip it rather than trade a wrong offset for a failed migration.
        if new_end <= new_start:
            continue
        updates.append({"eid": exc_id, "s": new_start, "e": new_end})

    for u in updates:
        conn.execute(
            sa.text("UPDATE excerpt SET start_offset = :s, end_offset = :e WHERE id = :eid"),
            u,
        )


def upgrade() -> None:
    _convert(_utf16_to_codepoint)


def downgrade() -> None:
    _convert(_codepoint_to_utf16)
