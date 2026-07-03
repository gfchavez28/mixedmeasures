"""Shared fuzzy name-matching primitives.

Single-sources the text normalizer + similarity ratio used by:
  - dataset-column equivalence matching (`routers/equivalence.py` find-matches),
  - J3-2b divergent-code triage (`services/project_portability.py::build_merge_code_preview`).

`difflib.SequenceMatcher` is stdlib — no dependency. Pure functions, no app imports
(so any layer can import this without a cycle).
"""
import re
import unicodedata
from difflib import SequenceMatcher


def normalize_text(text: str) -> str:
    """Normalize text for fuzzy matching.

    Lowercase, strip accents (NFD + drop combining marks), drop a leading
    ``[bracketed]`` code prefix, collapse internal whitespace, strip edge
    punctuation. The bracket strip is a no-op for ordinary code names (it only
    matters for dataset column codes), so the same normalizer is safe for both
    callers — extracted verbatim from the former `equivalence._normalize_text`.
    """
    text = text.strip().lower()
    # Strip accents
    text = "".join(
        c for c in unicodedata.normalize("NFD", text)
        if unicodedata.category(c) != "Mn"
    )
    # Remove common prefixes like column codes in brackets
    text = re.sub(r"^\[.*?\]\s*", "", text)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text)
    # Remove punctuation at edges
    text = text.strip(".,;:!?-–—")
    return text


def similarity_ratio(a: str, b: str) -> float:
    """SequenceMatcher ratio of two NORMALIZED strings, in [0.0, 1.0].

    The 0.70 threshold (a 'confident' match) is the same one the crosswalk's
    Suggest auto-pair uses (the internal design notes).
    """
    return SequenceMatcher(None, normalize_text(a), normalize_text(b)).ratio()
