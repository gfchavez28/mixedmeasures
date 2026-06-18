"""Tests for #358 — tighten dataset auto-detect percentage rule.

Before the fix, `_analyze_numeric()` used:
    all_integer and 0 <= min_val and max_val <= 100 and max_val >= 10

Any column whose values were integers in [0,100] with max ≥ 10 got typed as
PERCENTAGE. False positives: Tenure (1-11), Years_Experience, integer
Test_Score, Age (e.g. 18-65) — all auto-typed as percentage.

After the fix, percentage requires AT LEAST ONE of:
1. `%` glyph in values (existing `_PERCENT_SUFFIX_RE` check), OR
2. Header keyword match (`pct, percent, percentage, rate, share, proficiency,
   coverage, uptake, participation, compliance, completion`)

Otherwise fall back to `numeric` / `integer` / `decimal`. Researchers
manually override via the dataset import preview's type dropdown if the
heuristic misses a legitimate percent column.

Currency precedence preserved.
"""
import pytest

from app.models.dataset import ColumnType
from app.services.dataset_import import _analyze_numeric


# ═══════════════════════════════════════════════════════════════════════════════
# False positives (scenario 2 regressions) — should NOT be percentage
# ═══════════════════════════════════════════════════════════════════════════════


def test_principal_tenure_in_years_is_not_percentage():
    """The scenario 2 regression: Principal_Tenure values 1-11 (years) used
    to be classified as percentage because they fit the all-integer + max≥10
    rule. After fix → numeric/integer."""
    result = _analyze_numeric(
        ["1", "3", "4", "5", "6", "7", "8", "11"],
        header="Principal_Tenure",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.NUMERIC
    assert result["numeric_format"] == "integer"


def test_years_experience_is_not_percentage():
    """Teacher years-of-experience 0-40 → numeric, not percentage."""
    result = _analyze_numeric(
        ["0", "1", "5", "12", "15", "22", "30", "40"],
        header="Years_Experience",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.NUMERIC


def test_test_score_without_keyword_is_not_percentage():
    """0-100 integer scores (no header keyword) → numeric, not percentage.
    Researcher can manually override if they want percentage semantics."""
    result = _analyze_numeric(
        ["55", "62", "78", "85", "91", "100"],
        header="Score",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.NUMERIC
    assert result["numeric_format"] == "integer"


def test_age_is_not_percentage():
    """Age 18-65 → numeric. (Age is usually picked up as demographic earlier
    in the pipeline, but at the _analyze_numeric layer it should be numeric.)"""
    result = _analyze_numeric(
        ["18", "22", "35", "48", "55", "65"],
        header="Age",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.NUMERIC


def test_avg_score_decimal_without_keyword_is_not_percentage():
    """Decimal 0-100 values with no `%` glyph and no keyword → numeric.
    This drops the agent's draft 'decimal + range≥30' sub-rule that would
    have surprised users by re-typing Avg_Score, BMI, etc. as percentage."""
    result = _analyze_numeric(
        ["45.2", "67.8", "82.5", "91.3"],
        header="Avg_Score",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.NUMERIC
    assert result["numeric_format"] == "decimal"


# ═══════════════════════════════════════════════════════════════════════════════
# True positives — should STILL be percentage
# ═══════════════════════════════════════════════════════════════════════════════


def test_pct_frl_keyword_is_percentage():
    """`Pct_FRL` (Free/Reduced-Lunch %): all-integer, no glyph, but header
    keyword `pct` matches → percentage. The scenario 2 valid case."""
    result = _analyze_numeric(
        ["28", "42", "55", "65", "72", "78"],
        header="Pct_FRL",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.PERCENTAGE
    assert result["numeric_format"] == "percentage"


def test_response_rate_keyword_is_percentage():
    """Header keyword `rate` matches via word boundary inside `response_rate`."""
    result = _analyze_numeric(
        ["45.2", "67.8", "82.5", "91.3"],
        header="Response_Rate",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.PERCENTAGE


def test_coverage_keyword_is_percentage():
    result = _analyze_numeric(
        ["50", "60", "70", "85"],
        header="Coverage_2024",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.PERCENTAGE


def test_completion_keyword_is_percentage():
    result = _analyze_numeric(
        ["12", "34", "56", "78", "92"],
        header="Course_Completion",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.PERCENTAGE


def test_proficiency_keyword_is_percentage():
    result = _analyze_numeric(
        ["42", "55", "61", "72"],
        header="Prior_Math_Proficiency",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.PERCENTAGE


def test_explicit_percent_glyph_overrides_missing_keyword():
    """`%` glyph in values means percentage even without header keyword.
    Highest-priority rule, unchanged by #358."""
    result = _analyze_numeric(
        ["45%", "67%", "82%", "91%"],
        header="Score",  # no keyword
    )
    assert result is not None
    assert result["column_type"] == ColumnType.PERCENTAGE


# ═══════════════════════════════════════════════════════════════════════════════
# Currency precedence preserved
# ═══════════════════════════════════════════════════════════════════════════════


def test_currency_precedence_over_keyword():
    """Currency glyph wins over header keyword — `$` is the most specific
    type signal. Hypothetical 'Coverage_Rate' with $ values is currency,
    not percentage."""
    result = _analyze_numeric(
        ["$1000", "$2500", "$3000"],
        header="Salary",
    )
    assert result is not None
    assert result["column_type"] == ColumnType.NUMERIC
    assert result["numeric_format"] == "currency"


# ═══════════════════════════════════════════════════════════════════════════════
# Backwards-compat: callers without header
# ═══════════════════════════════════════════════════════════════════════════════


def test_no_header_arg_works_as_numeric():
    """Direct callers that don't pass a header (e.g. ad-hoc unit tests, future
    code) should still get sensible numeric classification — no crash on
    None header."""
    result = _analyze_numeric(["1", "5", "11"])  # no header param
    assert result is not None
    assert result["column_type"] == ColumnType.NUMERIC
    assert result["numeric_format"] == "integer"


def test_empty_header_works_as_numeric():
    """Empty string header is no signal — defaults to numeric."""
    result = _analyze_numeric(["1", "50", "99"], header="")
    assert result is not None
    assert result["column_type"] == ColumnType.NUMERIC


# ═══════════════════════════════════════════════════════════════════════════════
# Regex boundaries — make sure keywords don't false-match inside unrelated words
# ═══════════════════════════════════════════════════════════════════════════════


def test_keyword_inside_unrelated_word_does_not_match():
    """`rate` shouldn't match inside `narrate`, `iterate`, `accurate` etc.
    Word boundaries (`\\b`) prevent this. If this regresses, the false-
    positive rate climbs back up."""
    for header in ["narrate", "iterate", "accurate_score", "moderate_diff"]:
        result = _analyze_numeric(["1", "50", "99"], header=header)
        assert result is not None
        assert result["column_type"] == ColumnType.NUMERIC, (
            f"header={header!r} should NOT match percentage keyword"
        )


def test_keyword_at_word_boundary_does_match():
    """`rate` at a real word boundary (start/end, after `_`/`-`, spaces)
    SHOULD match. Counterpart to the boundary test above."""
    for header in ["rate", "Response Rate", "rate_per_capita", "completion-rate"]:
        result = _analyze_numeric(["1", "50", "99"], header=header)
        assert result is not None
        assert result["column_type"] == ColumnType.PERCENTAGE, (
            f"header={header!r} should match percentage keyword"
        )


def test_keyword_jammed_with_digits_does_not_match():
    """Letter+digit combinations (`Rate2024`, `Pct2023`) do NOT match because
    no word boundary separates the keyword from the digits — both are word
    chars. Researchers naming columns this way should either add a separator
    (`Rate_2024`) or manually pick `percentage` in the dropdown. Conservative
    bias is intentional — we'd rather miss `Rate2024` than mis-grab `Lstate25`."""
    for header in ["Rate2024", "Pct2023", "Coverage99"]:
        result = _analyze_numeric(["1", "50", "99"], header=header)
        assert result is not None
        assert result["column_type"] == ColumnType.NUMERIC, (
            f"header={header!r} should NOT match (letter+digit boundary)"
        )


def test_case_insensitive_keyword_match():
    """Mixed-case headers (PCT_FRL, Coverage_2024, response_RATE) all match."""
    for header in ["PCT_FRL", "Coverage_2024", "response_RATE", "Percentage_Complete"]:
        result = _analyze_numeric(["1", "50", "99"], header=header)
        assert result is not None
        assert result["column_type"] == ColumnType.PERCENTAGE, (
            f"header={header!r} should match percentage keyword case-insensitively"
        )
