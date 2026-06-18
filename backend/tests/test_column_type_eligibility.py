"""Invariant I-D guard — the column-type eligibility sets are single-sourced and
the two numeric concepts stay distinct (#399, Seam-1).

Before #399 the "numeric-eligible" notion was hand-rolled in four backend sites
that *looked* inconsistent (binary in some, not others). Verification showed it
was actually TWO concepts, each already internally consistent:

  - VALUE_NUMERIC_TYPES        — "has usable value_numeric" / numeric operand
                                 (computed-column formulas, data-quality MCAR).
                                 Includes binary (0/1).
  - SCALE_SCORE_ELIGIBLE_TYPES — scale-score aggregation (domain_aggregate means).
                                 EXCLUDES binary deliberately.

The fix routed every site through these two constants in models/dataset.py. This
file locks (a) their exact membership, (b) the intentional binary boundary between
them, (c) that the call sites alias the canonical objects rather than redefining,
and (d) the str-enum hash property the whole refactor relies on (a raw string must
match an enum member in these frozensets, because string-comparing call sites
exist). If a future edit re-splits any of these, this test fails loudly instead of
the bug silently resurfacing across surfaces (the I-D sequential-reopen fingerprint).
"""
from app.models.dataset import (
    ColumnType,
    VALUE_NUMERIC_TYPES,
    SCALE_SCORE_ELIGIBLE_TYPES,
)


def test_value_numeric_types_membership():
    assert VALUE_NUMERIC_TYPES == {
        ColumnType.ORDINAL,
        ColumnType.NUMERIC,
        ColumnType.PERCENTAGE,
        ColumnType.BINARY,
    }


def test_scale_score_eligible_types_membership():
    assert SCALE_SCORE_ELIGIBLE_TYPES == {
        ColumnType.ORDINAL,
        ColumnType.NUMERIC,
        ColumnType.PERCENTAGE,
    }


def test_scale_score_is_value_numeric_minus_binary():
    """The two numeric concepts differ by exactly BINARY — the one intentional
    boundary. Document it as a test so a future 'just merge them' edit trips."""
    assert SCALE_SCORE_ELIGIBLE_TYPES < VALUE_NUMERIC_TYPES  # strict subset
    assert VALUE_NUMERIC_TYPES - SCALE_SCORE_ELIGIBLE_TYPES == {ColumnType.BINARY}


def test_str_enum_membership_property():
    """The refactor relies on raw strings matching enum members in these
    frozensets (computed_columns / data_quality compare string column_type
    values). Guard the property explicitly."""
    assert "ordinal" in VALUE_NUMERIC_TYPES
    assert "binary" in VALUE_NUMERIC_TYPES
    assert "binary" not in SCALE_SCORE_ELIGIBLE_TYPES
    assert "open_text" not in VALUE_NUMERIC_TYPES


def test_call_sites_alias_the_canonical_objects():
    """Every numeric-eligibility site must reference the single source, not a
    private copy. Identity (`is`) proves no shadow definition snuck back in."""
    from app.services.computed_columns import _NUMERIC_TYPES
    from app.services.equivalence_validators import NUMERIC_ELIGIBLE_COLUMN_TYPES

    assert _NUMERIC_TYPES is VALUE_NUMERIC_TYPES
    assert NUMERIC_ELIGIBLE_COLUMN_TYPES is SCALE_SCORE_ELIGIBLE_TYPES
