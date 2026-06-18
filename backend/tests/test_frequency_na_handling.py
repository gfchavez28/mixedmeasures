"""Regression test for #381 — N/A strings leak into frequency distributions.

Surfaced by the scenario-4 hardening run (2026-05-23). A value the importer
recognizes as N/A (in `_NA_PREFIXES` / "na"/"n/a", e.g. "N/A") is preserved as
`value_text` with `value_numeric=NULL`. The value_text-keyed computes
(`compute_frequency_distribution`, `compute_proportion` values mode) must
exclude it so they match the Data Quality tab, which counts it as missing
(`include_na_as_missing=True`).

Fixed 2026-05-24: both computes now exclude `_is_na()`-recognized value_text.
"""
from app.services.metrics import (
    ResolvedRow,
    compute_frequency_distribution,
    compute_proportion,
)


def test_frequency_excludes_recognized_na_strings():
    rows = [
        ResolvedRow(1, None, "Yes"),
        ResolvedRow(2, None, "No"),
        ResolvedRow(3, None, "N/A"),   # importer-recognized missing
        ResolvedRow(4, None, "Yes"),
    ]
    result_data, valid_n, total_n = compute_frequency_distribution(rows)
    counts = result_data["counts"]
    lowered = {str(k).strip().lower() for k in counts}
    assert "n/a" not in lowered and "na" not in lowered, (
        f"'N/A' should not be a frequency category; counts={counts}"
    )
    # N/A excluded from valid_n, but total_n still counts every row.
    assert valid_n == 3
    assert total_n == 4
    assert counts.get("Yes") == 2 and counts.get("No") == 1


def test_proportion_values_mode_excludes_na_from_denominator():
    """#381: recognized N/A must not inflate the proportion denominator."""
    rows = [
        ResolvedRow(1, None, "Yes"),
        ResolvedRow(2, None, "Yes"),
        ResolvedRow(3, None, "No"),
        ResolvedRow(4, None, "Don't know"),  # recognized N/A → excluded
    ]
    result_data, valid_n, total_n = compute_proportion(
        rows, {"mode": "values", "threshold_values": ["Yes"]}
    )
    # Denominator is the 3 real responses, not 4.
    assert valid_n == 3
    assert total_n == 4
    assert result_data["count_meeting"] == 2
    assert result_data["proportion"] == round(2 / 3, 4)
