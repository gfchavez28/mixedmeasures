"""Unit tests for the shared fuzzy name-matching primitives (J3-2b · B1).

These back both dataset-column equivalence find-matches and the J3-2b divergent-code
reconcile triage, so the normalizer's behavior is load-bearing for both.
"""
import os

os.environ.setdefault("MM_DATABASE_PATH", ":memory:")

from app.services.text_similarity import normalize_text, similarity_ratio


def test_normalize_lowercases_and_collapses_whitespace():
    assert normalize_text("  Active   Listening  ") == "active listening"


def test_normalize_strips_accents():
    assert normalize_text("Résumé") == "resume"


def test_normalize_drops_leading_bracket_prefix():
    # Column-code prefix strip — a no-op for ordinary code names, kept for equivalence.
    assert normalize_text("[Q1] Trust in leadership") == "trust in leadership"


def test_normalize_strips_edge_punctuation():
    assert normalize_text("Empathy!") == "empathy"


def test_similarity_identical_after_normalization_is_one():
    assert similarity_ratio("Empathy", "empathy ") == 1.0


def test_similarity_invariant_to_case_whitespace_accents():
    assert similarity_ratio("Active Listening", "active  listening") == 1.0


def test_similarity_unrelated_is_low():
    assert similarity_ratio("Empathy", "Budget Variance") < 0.4


def test_confident_threshold_is_070():
    # A close-but-not-identical pair lands at/above 0.70 (the "confident" cutoff).
    assert similarity_ratio("Active Listening", "Active Listenin") >= 0.70
