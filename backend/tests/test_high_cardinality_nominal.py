"""Regression tests for #380 — high-cardinality categorical detection.

Surfaced by the scenario-4 hardening run (2026-05-23). A categorical column
with >10 distinct SHORT, HIGHLY-REPEATED labels (e.g. 18 NAICS industry
sectors) used to be classified `open_text` because `_detect_column_type`
had no `nominal` branch for the >10-unique case — only numeric, else
open_text. That excluded the column from analysis (`/metrics/analysis-columns`)
and blocked CategoryGroup/ScaleMap recodes.

Fixed 2026-05-24: step 5b classifies a >10-unique non-numeric column as nominal
when it looks like repeated short labels (bounded cardinality, low uniqueness
ratio, short avg label length) rather than free prose. The control tests guard
against over-correcting the heuristic onto genuine free text (see #358's rigor).
"""
from app.services.dataset_import import _detect_column_type


def _parsed(header: str) -> dict:
    return {"column_text": header, "raw_code": None}


def _detect(header: str, values: list[str]):
    substantive_list = values
    substantive_set = set(values)
    return _detect_column_type(header, _parsed(header), substantive_set, substantive_list, 5)


def test_high_cardinality_short_label_column_is_nominal():
    # 18 short NAICS-style sector labels, repeated across many rows
    sectors = [
        "Public administration", "Construction", "Retail trade", "Healthcare",
        "Information", "Education", "Agriculture", "Professional services",
        "Management", "Transportation", "Manufacturing", "Finance",
        "Real estate", "Accommodation", "Utilities", "Mining",
        "Wholesale trade", "Arts",
    ]
    res = _detect("Industry_Sector", sectors * 20)  # 360 cells, 18 unique (~5% ratio)
    assert res["suggested_type"] == "nominal", (
        f"expected nominal for an 18-label categorical, got {res['suggested_type']}"
    )


def test_geography_many_short_labels_is_nominal():
    """Borderline: dozens of short city labels repeated across rows → nominal
    (the issue explicitly calls out geography as a target)."""
    cities = [f"City{i:02d}" for i in range(60)]
    res = _detect("Home_City", cities * 8)  # 480 cells, 60 unique (12.5% ratio)
    assert res["suggested_type"] == "nominal", res["suggested_type"]


def test_tiny_dataset_categorical_is_nominal():
    """Small N with >10 short repeated labels still reads as categorical."""
    labels = [f"Program {chr(65+i)}" for i in range(12)]  # 12 short labels
    res = _detect("Program", labels * 3)  # 36 cells, 12 unique (33% ratio)
    assert res["suggested_type"] == "nominal", res["suggested_type"]


def test_genuine_open_text_stays_open_text():
    """Control: long, near-unique prose must remain open_text after the #380 fix."""
    comments = [
        f"This is a distinct free-text comment number {i} describing the "
        f"respondent's experience with the leave policy and its many effects."
        for i in range(200)
    ]
    res = _detect("Comment", comments)
    assert res["suggested_type"] == "open_text", res["suggested_type"]


def test_near_unique_id_column_is_identifier_not_nominal():
    """Control: an ID column (every value unique, ratio 1.0) is not a category.
    Pre-#414 the correct answer was open_text (the least-wrong type available);
    since #414 added the identifier type + header-gated detection, `Resp_ID`
    over unique codes is now IDENTIFIER — the #380 concern (must not be
    nominal) still holds."""
    ids = [f"R{i:05d}" for i in range(500)]  # 500 unique short codes, ratio 1.0
    res = _detect("Resp_ID", ids)
    assert res["suggested_type"] == "identifier", res["suggested_type"]


def test_high_cardinality_distinct_short_phrases_stays_open_text():
    """Control: many distinct short open-ended answers (high uniqueness) stay
    open_text even though each answer is short — uniqueness ratio is the guard."""
    answers = [f"reason number {i}" for i in range(150)]  # 150 unique in 150 rows
    res = _detect("Why_Not", answers)
    assert res["suggested_type"] == "open_text", res["suggested_type"]
