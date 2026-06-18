"""Tests for the import-time recode pipeline (_compute_value_numeric)."""
import pytest
from app.services.dataset_import import _compute_value_numeric

RECODE_CASES = [
    # Ordinal with scale_labels (1-indexed position)
    ("Excellent", "ordinal", ["Poor", "Fair", "Good", "Very Good", "Excellent"], 5.0),
    ("Poor", "ordinal", ["Poor", "Fair", "Good", "Very Good", "Excellent"], 1.0),
    ("good", "ordinal", ["Poor", "Fair", "Good", "Very Good", "Excellent"], 3.0),
    ("  Excellent ", "ordinal", ["Poor", "Fair", "Good", "Very Good", "Excellent"], 5.0),
    # Ordinal without scale_labels → None
    ("Excellent", "ordinal", None, None),
    # Ordinal with label not in scale → None
    ("Unknown", "ordinal", ["Poor", "Fair", "Good", "Very Good", "Excellent"], None),
    # Numeric
    ("42", "numeric", None, 42.0),
    ("3.14", "numeric", None, 3.14),
    ("-7.5", "numeric", None, -7.5),
    ("$1,234", "numeric", None, 1234.0),
    # Percentage
    ("85", "percentage", None, 85.0),
    ("99.9", "percentage", None, 99.9),
    # Binary
    ("Yes", "binary", None, 1.0),
    ("no", "binary", None, 0.0),
    ("true", "binary", None, 1.0),
    ("FALSE", "binary", None, 0.0),
    ("1", "binary", None, 1.0),
    ("0", "binary", None, 0.0),
    ("y", "binary", None, 1.0),
    ("n", "binary", None, 0.0),
    # N/A values → None
    ("N/A", "ordinal", ["Poor", "Fair", "Good", "Very Good", "Excellent"], None),
    ("NA", "ordinal", ["Low", "Medium", "High"], None),
    ("Not Applicable", "numeric", None, None),
    ("Don't Know", "ordinal", ["Low", "Medium", "High"], None),
    ("Prefer not to say", "numeric", None, None),
    ("Decline to answer", "binary", None, None),
    # Open-ended type → None
    ("Some text", "open_text", None, None),
    # Demographic → None
    ("Male", "demographic", None, None),
    # Unrecognized binary → None
    ("maybe", "binary", None, None),
]

ORDINAL_CASES = [c for c in RECODE_CASES if c[1] == "ordinal" and c[3] is not None]
NUMERIC_BINARY_CASES = [c for c in RECODE_CASES if c[1] in ("numeric", "percentage", "binary") and c[3] is not None]
NONE_CASES = [c for c in RECODE_CASES if c[3] is None]


@pytest.mark.parametrize("raw,qtype,labels,expected", ORDINAL_CASES)
def test_ordinal_scale_mapping(raw, qtype, labels, expected):
    result = _compute_value_numeric(raw, qtype, labels)
    assert result == expected


@pytest.mark.parametrize("raw,qtype,labels,expected", NUMERIC_BINARY_CASES)
def test_numeric_and_binary(raw, qtype, labels, expected):
    result = _compute_value_numeric(raw, qtype, labels)
    assert result == expected


@pytest.mark.parametrize("raw,qtype,labels,expected", NONE_CASES)
def test_na_and_edge_cases(raw, qtype, labels, expected):
    result = _compute_value_numeric(raw, qtype, labels)
    assert result is None
