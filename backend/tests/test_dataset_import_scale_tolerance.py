"""#364 — dataset auto-detect tolerates a few typo'd cells when matching
a known scale, instead of dropping the whole column to nominal.

Before the fix `_match_scale` required `lower_vals.issubset(lower_labels)` — a
single misspelled Likert label ("Stongly Agree") broke the match for the entire
column, so every affected ordinal column imported as nominal and the researcher
had to re-type each one. Now a small number of stray values is tolerated as long
as the matched labels clearly dominate, and the stray values are surfaced in the
preview so the researcher can fix them (they import with value_numeric=None).
"""
import os
os.environ["MM_DATABASE_PATH"] = ":memory:"

from app.services.dataset_import import _match_scale, preview_dataset_csv

# Canonical 4-point agreement scale labels (no ambiguous neutral label).
_FOURPT = ["Strongly Disagree", "Disagree", "Agree", "Strongly Agree"]


class TestMatchScaleTolerance:
    def test_clean_scale_still_matches(self):
        m = _match_scale(set(_FOURPT))
        assert m is not None
        assert set(m[1]) == set(_FOURPT)

    def test_single_typo_still_matches(self):
        # The misspelled label no longer drops the column to nominal.
        m = _match_scale(set(_FOURPT) | {"Stongly Agree"})
        assert m is not None
        assert set(m[1]) == set(_FOURPT)

    def test_two_typos_match_when_matched_dominate(self):
        m = _match_scale(set(_FOURPT) | {"Stongly Agree", "3"})
        assert m is not None  # 4 matched ≥ 2×2 unmatched

    def test_three_unmatched_rejected(self):
        # 2 matched, 3 unmatched — strays no longer dominated by real labels.
        assert _match_scale({"Strongly Disagree", "Agree", "Foo", "Bar", "Baz"}) is None

    def test_nominal_with_no_scale_overlap_not_matched(self):
        assert _match_scale({"Marketing", "Engineering", "Operations", "Sales"}) is None

    def test_low_dominance_not_matched(self):
        # 1 matched, 1 unmatched → matched doesn't dominate 2:1 (and coverage <0.5)
        assert _match_scale({"Strongly Agree", "Maybe"}) is None


class TestPreviewSurfacesUnmatched:
    def _preview_first_col(self, values: list[str], header: str = "Q1_Engagement"):
        csv_text = header + "\n" + "\n".join(values) + "\n"
        return preview_dataset_csv(csv_text)["columns"][0]

    def test_typo_column_detected_ordinal_with_unmatched_surfaced(self):
        col = self._preview_first_col([
            "Strongly Disagree", "Disagree", "Agree", "Strongly Agree",
            "Agree", "Disagree", "Stongly Agree",
        ])
        assert col["suggested_type"] == "ordinal"
        assert col["suggested_scale_unmatched"] == ["Stongly Agree"]

    def test_clean_column_has_no_unmatched_note(self):
        col = self._preview_first_col([
            "Strongly Disagree", "Disagree", "Agree", "Strongly Agree", "Agree",
        ])
        assert col["suggested_type"] == "ordinal"
        assert col["suggested_scale_unmatched"] is None
