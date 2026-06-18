"""
Dataset CSV import service for Mixed Measures.

Follows the same preview -> import philosophy as csv_import.py but handles
dataset/questionnaire data rather than conversation transcripts.
"""

import csv
import io
import json
import math
import re
from sqlalchemy.orm import Session

from ..models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from ..models.recode import RecodeDefinition, RecodeType, OutputType

# ── Rounding precision constants ─────────────────────────────────────────────
PREVIEW_STATS_PRECISION = 1  # round(x, 1) for import preview statistics


# ═══════════════════════════════════════════════════════════════════════════════
# Known Scale Library
# ═══════════════════════════════════════════════════════════════════════════════

"""
KNOWN_SCALES — Expanded scale library for survey auto-detection.
Sources: Vagias (2006), Brown (2010).

Each entry:
  - name: unique key, used for display and alphabetical tiebreaker
  - labels: ordered list, low-to-high (1 = first label, N = last label)
  - canonical: True for the most standard version of each construct type

Matching rules (in priority order):
  1. Case-insensitive subset: all unique substantive values must be in the scale
  2. Minimum 2 unique substantive values required
  3. Minimum 50% coverage: data values must cover >= 50% of scale labels
  4. Tightest fit: fewest labels wins
  5. Best coverage: highest % of labels present in data wins
  6. Canonical preference: canonical=True wins over canonical=False
  7. Alphabetical tiebreaker on name
"""

KNOWN_SCALES: list[dict] = [
    # ── Agreement ────────────────────────────────────────────────────────
    {
        "name": "agreement-2pt",
        "labels": ["Disagree", "Agree"],
        "canonical": False,
    },
    {
        "name": "agreement-3pt",
        "labels": ["Disagree", "Undecided", "Agree"],
        "canonical": False,
    },
    {
        "name": "agreement-4pt",
        "labels": ["Strongly Disagree", "Disagree", "Agree", "Strongly Agree"],
        "canonical": True,
    },
    {
        "name": "agreement-5pt",
        "labels": [
            "Strongly Disagree", "Disagree",
            "Neither Agree nor Disagree",
            "Agree", "Strongly Agree",
        ],
        "canonical": True,
    },
    {
        "name": "agreement-5pt-undecided",
        "labels": [
            "Strongly Disagree", "Disagree", "Undecided",
            "Agree", "Strongly Agree",
        ],
        "canonical": False,
    },
    {
        "name": "agreement-6pt-degree",
        "labels": [
            "Disagree Strongly", "Disagree Moderately", "Disagree Slightly",
            "Agree Slightly", "Agree Moderately", "Agree Strongly",
        ],
        "canonical": False,
    },
    {
        "name": "agreement-6pt-completeness",
        "labels": [
            "Completely Disagree", "Mostly Disagree", "Slightly Disagree",
            "Slightly Agree", "Mostly Agree", "Completely Agree",
        ],
        "canonical": False,
    },
    {
        "name": "agreement-6pt-strength",
        "labels": [
            "Disagree Strongly", "Disagree", "Slightly Disagree",
            "Slightly Agree", "Agree", "Agree Strongly",
        ],
        "canonical": False,
    },
    {
        "name": "agreement-6pt-very-strongly",
        "labels": [
            "Disagree Very Strongly", "Disagree Strongly", "Disagree",
            "Agree", "Agree Strongly", "Agree Very Strongly",
        ],
        "canonical": False,
    },
    {
        "name": "agreement-7pt",
        "labels": [
            "Strongly Disagree", "Disagree", "Somewhat Disagree",
            "Neither Agree nor Disagree",
            "Somewhat Agree", "Agree", "Strongly Agree",
        ],
        "canonical": True,
    },

    # ── Satisfaction ─────────────────────────────────────────────────────
    {
        "name": "satisfaction-5pt",
        "labels": [
            "Very Dissatisfied", "Dissatisfied", "Neutral",
            "Satisfied", "Very Satisfied",
        ],
        "canonical": True,
    },
    {
        "name": "satisfaction-5pt-neither",
        "labels": [
            "Very Dissatisfied", "Dissatisfied",
            "Neither Satisfied nor Dissatisfied",
            "Satisfied", "Very Satisfied",
        ],
        "canonical": False,
    },
    {
        "name": "satisfaction-5pt-degree",
        "labels": [
            "Not at All Satisfied", "Slightly Satisfied",
            "Moderately Satisfied", "Very Satisfied",
            "Extremely Satisfied",
        ],
        "canonical": False,
    },
    {
        "name": "satisfaction-7pt",
        "labels": [
            "Completely Dissatisfied", "Mostly Dissatisfied",
            "Somewhat Dissatisfied",
            "Neither Satisfied nor Dissatisfied",
            "Somewhat Satisfied", "Mostly Satisfied",
            "Completely Satisfied",
        ],
        "canonical": True,
    },
    {
        "name": "satisfaction-7pt-moderately",
        "labels": [
            "Very Dissatisfied", "Moderately Dissatisfied",
            "Slightly Dissatisfied", "Neutral",
            "Slightly Satisfied", "Moderately Satisfied",
            "Very Satisfied",
        ],
        "canonical": False,
    },

    # ── Quality ──────────────────────────────────────────────────────────
    {
        "name": "quality-3pt",
        "labels": ["Poor", "Fair", "Good"],
        "canonical": False,
    },
    {
        "name": "quality-4pt",
        "labels": ["Very Poor", "Poor", "Good", "Very Good"],
        "canonical": False,
    },
    {
        "name": "quality-4pt-acceptable",
        "labels": ["Very Poor", "Poor", "Acceptable", "Very Good"],
        "canonical": False,
    },
    {
        "name": "quality-5pt",
        "labels": ["Poor", "Fair", "Good", "Very Good", "Excellent"],
        "canonical": True,
    },
    {
        "name": "quality-5pt-acceptable",
        "labels": [
            "Very Poor", "Poor", "Acceptable", "Good", "Very Good",
        ],
        "canonical": False,
    },
    {
        "name": "quality-5pt-average",
        "labels": [
            "Very Poor", "Below Average", "Average",
            "Above Average", "Excellent",
        ],
        "canonical": False,
    },
    {
        "name": "quality-5pt-very",
        "labels": ["Very Poor", "Poor", "Fair", "Good", "Very Good"],
        "canonical": False,
    },
    {
        "name": "quality-7pt",
        "labels": [
            "Very Poor", "Poor", "Fair", "Good",
            "Very Good", "Excellent", "Exceptional",
        ],
        "canonical": False,
    },

    # ── Frequency ────────────────────────────────────────────────────────
    {
        "name": "frequency-4pt",
        "labels": ["Never", "Rarely", "Sometimes", "Often"],
        "canonical": True,
    },
    {
        "name": "frequency-4pt-seldom",
        "labels": ["Never", "Seldom", "Some of the Time", "Most of the Time"],
        "canonical": False,
    },
    {
        "name": "frequency-5pt",
        "labels": ["Never", "Rarely", "Sometimes", "Often", "Always"],
        "canonical": True,
    },
    {
        "name": "frequency-5pt-seldom",
        "labels": [
            "Never", "Seldom", "About Half the Time",
            "Usually", "Always",
        ],
        "canonical": False,
    },
    {
        "name": "frequency-5pt-very-often",
        "labels": ["Never", "Rarely", "Sometimes", "Very Often", "Always"],
        "canonical": False,
    },
    {
        "name": "frequency-5pt-almost",
        "labels": [
            "Never", "Almost Never", "Occasionally",
            "Almost Every Time", "Every Time",
        ],
        "canonical": False,
    },
    {
        "name": "frequency-5pt-great-deal",
        "labels": [
            "Never", "Rarely", "Occasionally",
            "A Moderate Amount", "A Great Deal",
        ],
        "canonical": False,
    },
    {
        "name": "frequency-6pt-very",
        "labels": [
            "Never", "Very Rarely", "Rarely",
            "Occasionally", "Frequently", "Very Frequently",
        ],
        "canonical": False,
    },

    # ── Likelihood ───────────────────────────────────────────────────────
    {
        "name": "likelihood-3pt",
        "labels": ["Not Likely", "Somewhat Likely", "Very Likely"],
        "canonical": False,
    },
    {
        "name": "likelihood-4pt",
        "labels": [
            "Definitely Won't", "Probably Won't",
            "Probably Will", "Definitely Will",
        ],
        "canonical": False,
    },
    {
        "name": "likelihood-5pt",
        "labels": [
            "Extremely Unlikely", "Unlikely", "Neutral",
            "Likely", "Extremely Likely",
        ],
        "canonical": True,
    },
    {
        "name": "likelihood-6pt",
        "labels": [
            "Definitely Not", "Probably Not", "Possibly",
            "Probably", "Very Probably", "Definitely",
        ],
        "canonical": False,
    },

    # ── Importance ───────────────────────────────────────────────────────
    {
        "name": "importance-3pt",
        "labels": ["Not Important", "Moderately Important", "Very Important"],
        "canonical": False,
    },
    {
        "name": "importance-5pt",
        "labels": [
            "Not Important", "Slightly Important",
            "Moderately Important", "Very Important",
            "Extremely Important",
        ],
        "canonical": True,
    },
    {
        "name": "importance-5pt-not-at-all",
        "labels": [
            "Not at All Important", "Slightly Important",
            "Moderately Important", "Very Important",
            "Extremely Important",
        ],
        "canonical": False,
    },
    {
        "name": "importance-5pt-fairly",
        "labels": [
            "Not Important", "Slightly Important",
            "Fairly Important", "Important", "Very Important",
        ],
        "canonical": False,
    },
    {
        "name": "importance-5pt-essential",
        "labels": [
            "Not at All Important", "Of Little Importance",
            "Of Average Importance", "Very Important",
            "Absolutely Essential",
        ],
        "canonical": False,
    },
    {
        "name": "importance-7pt",
        "labels": [
            "Not at All Important", "Low Importance",
            "Slightly Important", "Neutral",
            "Moderately Important", "Very Important",
            "Extremely Important",
        ],
        "canonical": True,
    },

    # ── Priority ─────────────────────────────────────────────────────────
    {
        "name": "priority-5pt",
        "labels": [
            "Not a Priority", "Low Priority", "Medium Priority",
            "High Priority", "Essential",
        ],
        "canonical": True,
    },
    {
        "name": "priority-7pt",
        "labels": [
            "Not a Priority", "Low Priority", "Somewhat Priority",
            "Neutral", "Moderate Priority", "High Priority",
            "Essential Priority",
        ],
        "canonical": False,
    },

    # ── Effectiveness ────────────────────────────────────────────────────
    {
        "name": "effectiveness-5pt",
        "labels": [
            "Not Effective", "Slightly Effective",
            "Moderately Effective", "Very Effective",
            "Extremely Effective",
        ],
        "canonical": True,
    },

    # ── Familiarity ──────────────────────────────────────────────────────
    {
        "name": "familiarity-5pt",
        "labels": [
            "Not at All Familiar", "Slightly Familiar",
            "Somewhat Familiar", "Moderately Familiar",
            "Extremely Familiar",
        ],
        "canonical": True,
    },

    # ── Awareness ────────────────────────────────────────────────────────
    {
        "name": "awareness-5pt",
        "labels": [
            "Not at All Aware", "Slightly Aware",
            "Somewhat Aware", "Moderately Aware",
            "Extremely Aware",
        ],
        "canonical": True,
    },

    # ── Concern ──────────────────────────────────────────────────────────
    {
        "name": "concern-5pt",
        "labels": [
            "Not at All Concerned", "Slightly Concerned",
            "Somewhat Concerned", "Moderately Concerned",
            "Extremely Concerned",
        ],
        "canonical": True,
    },

    # ── Influence ────────────────────────────────────────────────────────
    {
        "name": "influence-5pt",
        "labels": [
            "Not at All Influential", "Slightly Influential",
            "Somewhat Influential", "Very Influential",
            "Extremely Influential",
        ],
        "canonical": True,
    },

    # ── Difficulty ───────────────────────────────────────────────────────
    {
        "name": "difficulty-5pt",
        "labels": [
            "Very Difficult", "Difficult", "Neutral",
            "Easy", "Very Easy",
        ],
        "canonical": True,
    },

    # ── Acceptability ────────────────────────────────────────────────────
    {
        "name": "acceptability-7pt",
        "labels": [
            "Totally Unacceptable", "Unacceptable",
            "Slightly Unacceptable", "Neutral",
            "Slightly Acceptable", "Acceptable",
            "Perfectly Acceptable",
        ],
        "canonical": True,
    },

    # ── Appropriateness ──────────────────────────────────────────────────
    {
        "name": "appropriateness-7pt",
        "labels": [
            "Absolutely Inappropriate", "Inappropriate",
            "Slightly Inappropriate", "Neutral",
            "Slightly Appropriate", "Appropriate",
            "Absolutely Appropriate",
        ],
        "canonical": True,
    },

    # ── Comparison ───────────────────────────────────────────────────────
    {
        "name": "comparison-5pt",
        "labels": [
            "Much Worse", "Somewhat Worse", "About the Same",
            "Somewhat Better", "Much Better",
        ],
        "canonical": True,
    },
    {
        "name": "comparison-5pt-higher-lower",
        "labels": [
            "Much Lower", "Lower", "About the Same",
            "Higher", "Much Higher",
        ],
        "canonical": False,
    },
    {
        "name": "comparison-5pt-change",
        "labels": [
            "Much Worse", "Somewhat Worse", "Stayed the Same",
            "Somewhat Better", "Much Better",
        ],
        "canonical": False,
    },

    # ── Expectations ─────────────────────────────────────────────────────
    {
        "name": "expectations-7pt",
        "labels": [
            "Far Below", "Moderately Below", "Slightly Below",
            "Met Expectations",
            "Slightly Above", "Moderately Above", "Far Above",
        ],
        "canonical": True,
    },

    # ── Support / Opposition ─────────────────────────────────────────────
    {
        "name": "support-5pt",
        "labels": [
            "Strongly Oppose", "Somewhat Oppose", "Neutral",
            "Somewhat Favor", "Strongly Favor",
        ],
        "canonical": True,
    },

    # ── Desirability ─────────────────────────────────────────────────────
    {
        "name": "desirability-5pt",
        "labels": [
            "Very Undesirable", "Undesirable", "Neutral",
            "Desirable", "Very Desirable",
        ],
        "canonical": True,
    },

    # ── Reflect Me ───────────────────────────────────────────────────────
    {
        "name": "reflect-me-7pt",
        "labels": [
            "Very Untrue of Me", "Untrue of Me",
            "Somewhat Untrue of Me", "Neutral",
            "Somewhat True of Me", "True of Me",
            "Very True of Me",
        ],
        "canonical": True,
    },

    # ── Beliefs ──────────────────────────────────────────────────────────
    {
        "name": "beliefs-7pt",
        "labels": [
            "Very Untrue of What I Believe",
            "Untrue of What I Believe",
            "Somewhat Untrue of What I Believe",
            "Neutral",
            "Somewhat True of What I Believe",
            "True of What I Believe",
            "Very True of What I Believe",
        ],
        "canonical": False,
    },

    # ── Knowledge of Action ──────────────────────────────────────────────
    {
        "name": "knowledge-of-action-7pt",
        "labels": [
            "Never True", "Rarely True",
            "Sometimes but Infrequently True", "Neutral",
            "Sometimes True", "Usually True", "Always True",
        ],
        "canonical": False,
    },

    # ── Truth ────────────────────────────────────────────────────────────
    {
        "name": "truth-7pt",
        "labels": [
            "Almost Never True", "Rarely True", "Usually Not True",
            "Occasionally True", "Often True", "Usually True",
            "Almost Always True",
        ],
        "canonical": False,
    },

    # ── Level / Degree (generic unipolar) ────────────────────────────────
    {
        "name": "level-3pt",
        "labels": ["Low", "Medium", "High"],
        "canonical": True,
    },
    {
        "name": "level-4pt-value",
        "labels": ["None", "Low", "Moderate", "High"],
        "canonical": False,
    },
    {
        "name": "level-5pt",
        "labels": [
            "Very Low", "Below Average", "Average",
            "Above Average", "Very High",
        ],
        "canonical": False,
    },
    {
        "name": "degree-3pt",
        "labels": ["Not at All", "Moderately", "Extremely"],
        "canonical": False,
    },
    {
        "name": "degree-5pt",
        "labels": [
            "Not at All", "Slightly", "Moderately",
            "Very", "Extremely",
        ],
        "canonical": False,
    },
    {
        "name": "extent-4pt",
        "labels": [
            "Not at All", "Very Little", "Somewhat",
            "To a Great Extent",
        ],
        "canonical": False,
    },

    # ── Problem Severity ─────────────────────────────────────────────────
    {
        "name": "problem-4pt",
        "labels": [
            "Not at All a Problem", "Minor Problem",
            "Moderate Problem", "Serious Problem",
        ],
        "canonical": True,
    },

    # ── Barriers ─────────────────────────────────────────────────────────
    {
        "name": "barriers-4pt",
        "labels": [
            "Not a Barrier", "Somewhat of a Barrier",
            "Moderate Barrier", "Extreme Barrier",
        ],
        "canonical": True,
    },

    # ── Responsibility ───────────────────────────────────────────────────
    {
        "name": "responsibility-4pt",
        "labels": [
            "Not at All Responsible", "Somewhat Responsible",
            "Mostly Responsible", "Completely Responsible",
        ],
        "canonical": True,
    },

    # ── Probability ──────────────────────────────────────────────────────
    {
        "name": "probability-5pt",
        "labels": [
            "Not Probable", "Somewhat Improbable", "Neutral",
            "Somewhat Probable", "Very Probable",
        ],
        "canonical": True,
    },

    # ── Consideration ────────────────────────────────────────────────────
    {
        "name": "consideration-3pt",
        "labels": [
            "Would Not Consider", "Might or Might Not Consider",
            "Definitely Consider",
        ],
        "canonical": True,
    },

    # ── Balance / Amount ─────────────────────────────────────────────────
    {
        "name": "balance-3pt",
        "labels": ["Too Little", "About Right", "Too Much"],
        "canonical": True,
    },
    {
        "name": "strictness-3pt",
        "labels": ["Too Lenient", "About Right", "Too Strict"],
        "canonical": False,
    },
    {
        "name": "harshness-3pt",
        "labels": ["Too Lenient", "About Right", "Too Harsh"],
        "canonical": False,
    },
    {
        "name": "weight-3pt",
        "labels": ["Too Light", "About Right", "Too Heavy"],
        "canonical": False,
    },
]


# ═══════════════════════════════════════════════════════════════════════════════
# Internal Helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _strip_bom(text: str) -> str:
    """Remove UTF-8 BOM if present."""
    return text.lstrip("\ufeff")


# -- N/A detection ------------------------------------------------------------

_NA_PREFIXES = [
    "not applicable", "n/a", "don't know", "do not know",
    "i don't know", "no answer", "no response", "prefer not",
    "decline to", "unable to", "cannot assess", "not enough",
    "i don't have enough",
]


def _is_na(value: str) -> bool:
    """Check if a value is a Not Applicable / Don't Know response."""
    lower = value.strip().lower()
    if not lower:
        return False
    if lower in ("na", "n/a"):
        return True
    return any(lower.startswith(p) for p in _NA_PREFIXES)


# -- LimeSurvey header parsing ------------------------------------------------

_LS_QUESTION_RE = re.compile(r"^([A-Z]\d{2}[A-Z]\d{2})\.\s*(.+)$")
_CODE_DOT_TEXT_RE = re.compile(r"^(\S+)\.\s+(.+)$")


def parse_header(header: str) -> dict:
    """
    Parse a LimeSurvey-style header into structured parts.

    Returns dict with question_code, group_code, column_text, raw_code.
    """
    header = header.strip()
    m = _LS_QUESTION_RE.match(header)
    if m:
        code = m.group(1)
        group = code.split("Q")[0] if "Q" in code else None
        return {
            "column_code": code,
            "group_code": group,
            "column_text": m.group(2).strip(),
            "raw_code": code,
        }
    m = _CODE_DOT_TEXT_RE.match(header)
    if m:
        return {
            "column_code": None,
            "group_code": None,
            "column_text": m.group(2).strip(),
            "raw_code": m.group(1),
        }
    return {
        "column_code": None,
        "group_code": None,
        "column_text": header,
        "raw_code": None,
    }


# -- Name-like heuristic -------------------------------------------------------

_GENERIC_CODE_RE = re.compile(r'^[A-Z]*\d+$')
_LIMESURVEY_CODE_RE = re.compile(r'^[A-Z]\d{2}[A-Z]\d{2}$')


def _is_name_like(code: str | None) -> bool:
    """Check if a parsed raw_code looks like a meaningful column name (not a generic code)."""
    if not code:
        return False
    if len(code) <= 3:
        return False
    if _GENERIC_CODE_RE.match(code):
        return False
    if _LIMESURVEY_CODE_RE.match(code):
        return False
    if not any(c.isalpha() for c in code):
        return False
    return True


# -- Skip-column detection ----------------------------------------------------

_SKIP_CODES = {
    "id", "submitdate", "lastpage", "startlanguage", "seed",
    "startdate", "datestamp", "ipaddr", "referurl", "token", "optout",
}

_SKIP_HEADERS = {
    "response id", "respondent", "respondent id", "last page",
    "start language", "ip address", "referring url",
}

_SKIP_SUBSTRINGS = [
    "date submitted", "date started", "date last action",
]


def _is_skip_column(header: str, raw_code: str | None) -> bool:
    """Check if a column header looks like survey platform metadata."""
    lower = header.strip().lower()
    if lower in _SKIP_CODES or lower in _SKIP_HEADERS:
        return True
    if raw_code and raw_code.strip().lower() in _SKIP_CODES:
        return True
    return any(sub in lower for sub in _SKIP_SUBSTRINGS)


# -- Demographic detection -----------------------------------------------------

_DEMOGRAPHIC_KEYWORDS = {
    "gender", "race", "age", "ethnicity", "role", "sex", "income", "education",
}

_DEMOGRAPHIC_RE = re.compile(
    r"\b(?:" + "|".join(_DEMOGRAPHIC_KEYWORDS) + r")\b", re.IGNORECASE,
)


# -- Percentage header detection -----------------------------------------------
#
# #358: replace the greedy "all integer + 0<=min<=max<=100 + max>=10" rule
# (which captured Tenure, Years_Experience, integer Test_Score as percentage)
# with a stricter "header signal required" rule. Falls back to numeric when
# no `%` glyph and no keyword — researchers can still manually override via
# the dataset import preview's type dropdown.
#
# Keyword list covers common research column-naming vocab. Word boundaries
# match the existing `_DEMOGRAPHIC_RE` precedent so e.g. "rate" doesn't
# match inside "narrate" but does match inside "completion_rate".
_PERCENTAGE_KEYWORDS = {
    "pct", "percent", "percentage", "rate", "share",
    "proficiency", "coverage", "uptake", "participation",
    "compliance", "completion",
}

_PERCENTAGE_KEYWORD_RE = re.compile(
    r"\b(?:" + "|".join(_PERCENTAGE_KEYWORDS) + r")\b", re.IGNORECASE,
)


def _header_signals_percentage(header: str | None) -> bool:
    """Match `_PERCENTAGE_KEYWORD_RE` against a normalized header.

    The naive `\\bpct\\b` against raw `Pct_FRL` doesn't match because
    Python regex `\\b` treats `_` as a word character — there's no
    word-to-non-word transition after `pct`. Real-world percentage
    column names almost always use `_` / `-` separators
    (`Pct_FRL`, `response_rate`, `coverage-2024`), so normalize them
    to spaces first. Letter-to-letter sequences like `narrate` stay
    glued (and correctly do NOT match `rate`).
    """
    if not header:
        return False
    normalized = re.sub(r"[_\-\.]+", " ", header)
    return bool(_PERCENTAGE_KEYWORD_RE.search(normalized))


def _is_demographic(text: str) -> bool:
    """Match short text containing a demographic keyword at a word boundary."""
    if len(text) > 40:
        return False
    return bool(_DEMOGRAPHIC_RE.search(text))


_SUBTYPE_KEYWORDS = {
    "role": {"role", "position", "title", "department"},
    "race": {"race", "ethnicity"},
    "gender": {"gender", "sex"},
    "age": {"age"},
}


def _detect_demographic_subtype(header_text: str) -> str | None:
    """Detect the demographic subtype from the column header text."""
    lower = header_text.lower()
    for subtype, keywords in _SUBTYPE_KEYWORDS.items():
        for kw in keywords:
            if re.search(r'\b' + kw + r'\b', lower):
                return subtype
    return None


# -- Boolean detection ---------------------------------------------------------

_BOOLEAN_PAIRS = [
    {"yes", "no"}, {"true", "false"}, {"1", "0"}, {"y", "n"}, {"t", "f"},
]


def _is_boolean(values: set[str]) -> bool:
    if not values or len(values) > 2:
        return False
    lower = {v.lower() for v in values}
    return any(lower.issubset(pair) for pair in _BOOLEAN_PAIRS)


# -- Numeric helpers -----------------------------------------------------------

_CURRENCY_RE = re.compile(r"[\$\u20ac\u00a3\u00a5]")  # $ € £ ¥
_PERCENT_SUFFIX_RE = re.compile(r"\d\s*%$")


def _strip_numeric(value: str) -> float | None:
    """Strip formatting characters ($, EUR, GBP, %, commas) and parse as float."""
    s = value.strip()
    if not s:
        return None
    cleaned = re.sub(r"[\$\u20ac\u00a3\u00a5,%]", "", s).strip()
    try:
        n = float(cleaned)
        return n if math.isfinite(n) else None
    except (ValueError, OverflowError):
        return None


def _analyze_numeric(values: list[str], header: str | None = None) -> dict | None:
    """
    Analyze values for numeric patterns.

    Returns dict with question_type (ColumnType), numeric_format, numeric_min,
    numeric_max -- or None if values are not all numeric.

    The ``header`` parameter (#358) gates percentage classification: a column
    is only classified as PERCENTAGE when (a) at least one value carries a
    `%` glyph, or (b) the column header matches `_PERCENTAGE_KEYWORD_RE`
    (pct/percent/rate/share/proficiency/coverage/uptake/participation/
    compliance/completion). All other integer columns in [0,100] — including
    years-of-tenure, age ranges, count-of-events, integer test scores —
    fall back to NUMERIC. Researchers can manually override via the
    dataset import preview's type dropdown.
    """
    if not values:
        return None

    nums = []
    has_currency = False
    has_percent = False
    all_integer = True

    for v in values:
        s = v.strip()
        if _CURRENCY_RE.search(s):
            has_currency = True
        if _PERCENT_SUFFIX_RE.search(s):
            has_percent = True
        n = _strip_numeric(s)
        if n is None:
            return None
        nums.append(n)
        if not n.is_integer():
            all_integer = False

    min_val = min(nums)
    max_val = max(nums)

    # Header keyword check (#358). Defensive against None / empty header so
    # direct unit-test callers without a header still get integer/decimal
    # classification correctly.
    header_signals_percentage = _header_signals_percentage(header)

    # Determine format
    if has_currency:
        fmt = "currency"
    elif has_percent:
        fmt = "percentage"
    elif header_signals_percentage:
        fmt = "percentage"
    elif all_integer:
        fmt = "integer"
    else:
        fmt = "decimal"

    qtype = ColumnType.PERCENTAGE if fmt == "percentage" else ColumnType.NUMERIC

    return {
        "column_type": qtype,
        "numeric_format": fmt,
        "numeric_min": min_val,
        "numeric_max": max_val,
    }


# -- Scale matching ------------------------------------------------------------


# A column matches a known scale even when a few of its distinct values aren't in
# the scale, as long as the matched values clearly dominate (#364). This guards
# against BOTH failure modes: (a) a single misspelled Likert label ("Srongly
# Disagree") dropping a clean ordinal column to nominal and forcing the researcher
# to re-type every affected column at import, and (b) a genuinely nominal column
# coincidentally overlapping a scale on one or two labels being mis-typed ordinal.
_SCALE_MAX_UNMATCHED = 2


def _scale_match_within_tolerance(
    matched: set[str], unmatched: set[str],
) -> bool:
    """Whether a column's value set matches a scale despite a few stray values.

    Requires at least one matched label, no more than `_SCALE_MAX_UNMATCHED`
    distinct unmatched values, and matched values to outnumber unmatched at
    least 2:1. With zero unmatched (the old strict-subset case) this is always
    True, so previously-matching columns keep matching.
    """
    if not matched:
        return False
    if len(unmatched) > _SCALE_MAX_UNMATCHED:
        return False
    if len(matched) < 2 * len(unmatched):
        return False
    return True


def _match_scale(values: set[str]) -> tuple[str, list[str]] | None:
    """
    Find the best matching known scale for a set of values.

    Matching rules (in priority order):
      1. Tolerant match: most data values must appear in the scale, allowing a
         small number of stray values (typos) — see `_scale_match_within_tolerance`
      2. Minimum 2 unique substantive values required
      3. Minimum 50% coverage: matched data values must cover >= 50% of scale labels
      4. Tightest fit: fewest labels wins
      5. Best coverage: highest percentage of labels present in data wins
      6. Canonical preference: canonical=True wins over canonical=False
      7. Alphabetical tiebreaker on name

    Returns (scale_name, ordered_labels) or None.
    """
    if not values or len(values) < 2:
        return None
    lower_vals = {v.lower() for v in values}
    matches: list[tuple[dict, float]] = []
    for scale in KNOWN_SCALES:
        lower_labels = {label.lower() for label in scale["labels"]}
        matched = lower_vals & lower_labels
        unmatched = lower_vals - lower_labels
        if not _scale_match_within_tolerance(matched, unmatched):
            continue
        # Coverage is the fraction of the SCALE's labels present in the matched
        # (in-scale) data — stray values don't count toward or against it.
        coverage = len(matched) / len(scale["labels"])
        if coverage >= 0.5:
            matches.append((scale, coverage))
    if not matches:
        return None
    matches.sort(key=lambda x: (
        len(x[0]["labels"]),       # tightest fit (fewest labels)
        -x[1],                     # best coverage (highest %)
        not x[0]["canonical"],     # canonical preference (True first)
        x[0]["name"],              # alphabetical tiebreaker
    ))
    best = matches[0][0]
    return (best["name"], best["labels"])


# -- Numeric value computation for answers -------------------------------------


def _compute_value_numeric(
    raw_value: str,
    question_type: str,
    scale_labels: list[str] | None,
) -> float | None:
    """Compute the numeric encoding for a cell value."""
    if _is_na(raw_value):
        return None

    if question_type == ColumnType.ORDINAL.value:
        if scale_labels:
            label_map = {l.lower(): float(i + 1) for i, l in enumerate(scale_labels)}
            return label_map.get(raw_value.strip().lower())
        return None

    if question_type in (ColumnType.NUMERIC.value, ColumnType.PERCENTAGE.value):
        return _strip_numeric(raw_value)

    if question_type == ColumnType.BINARY.value:
        lower = raw_value.strip().lower()
        if lower in ("yes", "true", "1", "y", "t"):
            return 1.0
        if lower in ("no", "false", "0", "n", "f"):
            return 0.0
        return None

    return None


# -- Column type detection -----------------------------------------------------

# #380: high-cardinality categorical detection. A non-numeric column with >10
# distinct values used to fall straight through to open_text, which excluded it
# from analysis (frequency/group-by/cross-tab) and blocked recodes — wrong for
# demographic categoricals like industry sector (18 NAICS labels), geography, or
# detailed ethnicity. We now classify such a column as NOMINAL when it looks like
# a set of repeated short labels rather than free prose. The three signals:
#   - bounded cardinality (a 200-category "variable" is not analytically useful)
#   - low uniqueness ratio (free text is near-unique; labels repeat)
#   - short average label length (labels are short; prose runs long)
# uniqueness ratio is the primary discriminator; avg length is the backstop.
# Tuned against the scenario-4 Family Leave Survey (Industry_Sector: 18 unique,
# ratio 0.045, avg len 16) and a genuine-comment control that must stay open_text.
NOMINAL_MAX_CARDINALITY = 100        # ceiling — beyond this, default to open_text
NOMINAL_MAX_UNIQUENESS_RATIO = 0.5   # unique/n must be below this (labels repeat)
NOMINAL_MAX_AVG_LABEL_LEN = 30       # avg label length (chars) — prose runs longer


def _looks_like_nominal_labels(substantive_set: set[str], substantive_list: list[str]) -> bool:
    """#380: heuristic for a high-cardinality categorical (repeated short labels)
    vs genuine free text. Caller has already ruled out numeric and <=10-unique."""
    n = len(substantive_list)
    unique_count = len(substantive_set)
    if n == 0 or unique_count == 0:
        return False
    if unique_count > NOMINAL_MAX_CARDINALITY:
        return False
    if (unique_count / n) >= NOMINAL_MAX_UNIQUENESS_RATIO:
        return False
    avg_label_len = sum(len(v) for v in substantive_set) / unique_count
    return avg_label_len <= NOMINAL_MAX_AVG_LABEL_LEN


def _detect_column_type(
    header: str,
    parsed: dict,
    substantive_set: set[str],
    substantive_list: list[str],
    col_idx: int,
) -> dict:
    """
    Auto-detect the suggested type for a CSV column.

    Returns a dict with suggested_type, scale info, and numeric metadata.
    """
    result: dict = {
        "suggested_type": ColumnType.OPEN_TEXT.value,
        "suggested_scale_name": None,
        "suggested_scale_labels": None,
        "suggested_scale_unmatched": None,
        "suggested_demographic_subtype": None,
        "numeric_format": None,
        "numeric_min": None,
        "numeric_max": None,
    }

    # 1. Skip (platform metadata)
    if _is_skip_column(header, parsed["raw_code"]):
        result["suggested_type"] = ColumnType.SKIP.value
        return result

    # 2. Demographic (short headers only — check parsed question text, not raw header)
    if _is_demographic(parsed["column_text"]):
        result["suggested_type"] = ColumnType.DEMOGRAPHIC.value
        result["suggested_demographic_subtype"] = _detect_demographic_subtype(parsed["column_text"])
        return result

    if not substantive_set:
        return result  # defaults to open_text

    # 3. Binary
    if _is_boolean(substantive_set):
        result["suggested_type"] = ColumnType.BINARY.value
        return result

    # 4. Small cardinality (<=10 unique): scale first, then numeric, then nominal
    if len(substantive_set) <= 10:
        match = _match_scale(substantive_set)
        if match:
            result["suggested_type"] = ColumnType.ORDINAL.value
            result["suggested_scale_name"] = match[0]
            result["suggested_scale_labels"] = match[1]
            # Surface any values not in the matched scale (#364). These import
            # with value_numeric=None (blank) — the researcher should review them
            # as likely typos. Preserve original casing + first-seen order.
            label_lower = {l.lower() for l in match[1]}
            unmatched = [v for v in substantive_list if v.lower() not in label_lower]
            seen: set[str] = set()
            unmatched_unique = [
                v for v in unmatched if not (v.lower() in seen or seen.add(v.lower()))
            ]
            result["suggested_scale_unmatched"] = unmatched_unique or None
            return result

        # #358: pass header so the percentage keyword check can fire
        numeric = _analyze_numeric(list(substantive_set), header=header)
        if numeric:
            result["suggested_type"] = numeric["column_type"].value
            result["numeric_format"] = numeric["numeric_format"]
            result["numeric_min"] = numeric["numeric_min"]
            result["numeric_max"] = numeric["numeric_max"]
            return result

        result["suggested_type"] = ColumnType.NOMINAL.value
        return result

    # 5. High cardinality (>10 unique)
    numeric = _analyze_numeric(list(substantive_set), header=header)  # #358
    if numeric:
        result["suggested_type"] = numeric["column_type"].value
        result["numeric_format"] = numeric["numeric_format"]
        result["numeric_min"] = numeric["numeric_min"]
        result["numeric_max"] = numeric["numeric_max"]
        return result

    # 5b. High-cardinality categorical (#380): repeated short labels, not prose
    if _looks_like_nominal_labels(substantive_set, substantive_list):
        result["suggested_type"] = ColumnType.NOMINAL.value
        return result

    # 6. Open text
    result["suggested_type"] = ColumnType.OPEN_TEXT.value
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════════════════════


def preview_dataset_csv(file_contents: str) -> dict:
    """
    Parse a survey CSV and return per-column analysis with auto-detected types.

    Args:
        file_contents: The CSV file as a decoded string (BOM handled internally).

    Returns:
        Dict with ``total_rows`` and ``columns`` list.  Each column entry
        contains: column_name, column_index, sample_values, unique_count,
        empty_count, empty_percent, na_count, all_numeric, avg_text_length,
        suggested_type, suggested_scale_name, suggested_scale_labels,
        suggested_column_code, suggested_group_code, suggested_column_text,
        numeric_format, numeric_min, numeric_max.
    """
    text = _strip_bom(file_contents)
    reader = csv.DictReader(io.StringIO(text))
    headers = reader.fieldnames or []

    # Collect all values per column
    col_all_values: dict[str, list[str]] = {h: [] for h in headers}
    total_rows = 0

    for row in reader:
        total_rows += 1
        for h in headers:
            col_all_values[h].append(row.get(h, "").strip())

    columns = []
    for col_idx, header in enumerate(headers):
        all_vals = col_all_values[header]
        non_empty = [v for v in all_vals if v]
        empty_count = len(all_vals) - len(non_empty)

        # Unique values preserving first-seen order
        unique_ordered = list(dict.fromkeys(non_empty))

        # Substantive = non-empty AND non-N/A (used for type detection)
        substantive_list = [v for v in non_empty if not _is_na(v)]
        substantive_set = set(substantive_list)
        na_count = len(non_empty) - len(substantive_list)

        # Stats
        sample_values = unique_ordered[:5]
        unique_count = len(set(non_empty))
        empty_percent = (
            round(empty_count / total_rows * 100, PREVIEW_STATS_PRECISION) if total_rows else 0.0
        )
        all_numeric = bool(substantive_set) and all(
            _strip_numeric(v) is not None for v in substantive_set
        )
        avg_text_length = (
            round(sum(len(v) for v in non_empty) / len(non_empty), PREVIEW_STATS_PRECISION)
            if non_empty
            else 0.0
        )

        # Parse header
        parsed = parse_header(header)

        # Detect type
        detection = _detect_column_type(
            header, parsed, substantive_set, substantive_list, col_idx,
        )

        columns.append({
            "column_name": header,
            "column_index": col_idx,
            "sample_values": sample_values,
            "unique_count": unique_count,
            "empty_count": empty_count,
            "empty_percent": empty_percent,
            "na_count": na_count,
            "all_numeric": all_numeric,
            "avg_text_length": avg_text_length,
            "suggested_type": detection["suggested_type"],
            "suggested_scale_name": detection["suggested_scale_name"],
            "suggested_scale_labels": detection["suggested_scale_labels"],
            "suggested_scale_unmatched": detection["suggested_scale_unmatched"],
            "suggested_column_code": parsed["column_code"],
            "suggested_group_code": parsed["group_code"],
            "suggested_column_text": parsed["column_text"],
            "suggested_column_name": parsed["raw_code"] if _is_name_like(parsed.get("raw_code")) else None,
            "suggested_demographic_subtype": detection.get("suggested_demographic_subtype"),
            "numeric_format": detection["numeric_format"],
            "numeric_min": detection["numeric_min"],
            "numeric_max": detection["numeric_max"],
        })

    return {"total_rows": total_rows, "columns": columns}


def import_dataset_csv(
    db: Session,
    project_id: int,
    name: str,
    column_configs: list[dict],
    file_contents: str,
    description: str | None = None,
    source: str | None = None,
) -> dict:
    """
    Import a dataset CSV into the database.

    All writes happen in a single transaction — nothing is committed until
    every object has been created successfully.

    Each row gets a system-generated record identifier (R0001, R0002,
    etc.) based on CSV row order.  Participant linking is a post-import
    operation handled by the recode/management layer.

    Args:
        db: SQLAlchemy session.
        project_id: The project to import into.
        name: Display name for the Dataset.
        column_configs: Per-column configuration.  Each dict may contain:
            column_index (int), skip (bool), column_type (str),
            column_text (str), column_code (str|None),
            group_code (str|None), group_label (str|None),
            scale_labels (list[str]|None).
        file_contents: The CSV file as a decoded string.
        description: Optional description.
        source: Optional source platform name (e.g. "LimeSurvey").

    Returns:
        Summary dict: dataset_id, columns_created, rows_created,
        values_created.
    """
    text = _strip_bom(file_contents)
    reader = csv.reader(io.StringIO(text))
    headers = next(reader)
    data_rows = list(reader)

    # Build config lookup by column index
    cfg_by_idx: dict[int, dict] = {cfg["column_index"]: cfg for cfg in column_configs}

    # Auto-ID padding: len(str(row_count)) + 2 extra zeros
    pad_width = len(str(len(data_rows))) + 2

    # -- 1. Create dataset -----------------------------------------------------
    dataset = Dataset(
        project_id=project_id,
        name=name,
        description=description,
        source=source,
        import_config=json.dumps(column_configs),
    )
    db.add(dataset)
    db.flush()

    # -- 2. Create columns (non-skipped) ----------------------------------------
    columns: dict[int, DatasetColumn] = {}  # col_idx -> DatasetColumn
    seq = 0

    for cfg in sorted(column_configs, key=lambda c: c["column_index"]):
        col_idx = cfg["column_index"]
        if cfg.get("skip") or cfg.get("column_type") == ColumnType.SKIP.value:
            continue

        qtype = ColumnType(cfg["column_type"])
        scale_labels = cfg.get("scale_labels")

        # Scale metadata
        scale_labels_json = None
        scale_values_json = None
        scale_pts = None
        if qtype == ColumnType.ORDINAL and scale_labels:
            scale_labels_json = json.dumps(scale_labels)
            scale_values_json = json.dumps(list(range(1, len(scale_labels) + 1)))
            scale_pts = len(scale_labels)

        # Numeric metadata (computed from data)
        n_fmt: str | None = None
        n_min: float | None = None
        n_max: float | None = None
        if qtype in (ColumnType.NUMERIC, ColumnType.PERCENTAGE):
            col_vals = [
                row[col_idx].strip()
                for row in data_rows
                if col_idx < len(row)
                and row[col_idx].strip()
                and not _is_na(row[col_idx].strip())
            ]
            # #358: pass the CSV header (not column_text override) so the
            # percentage keyword check uses the original column name.
            col_header = headers[col_idx] if col_idx < len(headers) else None
            info = _analyze_numeric(list(set(col_vals)), header=col_header)
            if info:
                n_fmt = info["numeric_format"]
                n_min = info["numeric_min"]
                n_max = info["numeric_max"]

        column = DatasetColumn(
            dataset_id=dataset.id,
            column_code=cfg.get("column_code") or f"C{seq + 1:03d}",
            column_name=cfg.get("column_name"),
            group_code=cfg.get("group_code"),
            group_label=cfg.get("group_label"),
            column_text=cfg.get(
                "column_text",
                headers[col_idx] if col_idx < len(headers) else "",
            ),
            column_type=qtype,
            sequence_order=seq,
            scale_labels=scale_labels_json,
            scale_values=scale_values_json,
            scale_points=scale_pts,
            numeric_min=n_min,
            numeric_max=n_max,
            numeric_format=n_fmt,
            demographic_subtype=cfg.get("demographic_subtype"),
        )
        db.add(column)
        columns[col_idx] = column
        seq += 1

    db.flush()  # get column IDs

    # -- 2b. Create RecodeDefinitions for ordinal columns ----------------------
    for col_idx, column in columns.items():
        cfg = cfg_by_idx.get(col_idx, {})
        qtype_str = cfg.get("column_type", "")
        scale_labels = cfg.get("scale_labels")

        if qtype_str != ColumnType.ORDINAL.value or not scale_labels:
            continue

        # Build mapping: label -> 1-based index
        mapping = {label: i + 1 for i, label in enumerate(scale_labels)}

        # Pre-scan data rows for N/A values
        na_values = set()
        for row in data_rows:
            if col_idx < len(row):
                cell = row[col_idx].strip()
                if cell and _is_na(cell):
                    na_values.add(cell)

        exclude_values_json = json.dumps(sorted(na_values)) if na_values else None

        # Name: use scale point count
        recode_name = f"{len(scale_labels)}-point scale"

        recode_def = RecodeDefinition(
            column_id=column.id,
            name=recode_name,
            recode_type=RecodeType.SCALE_MAP,
            output_type=OutputType.NUMERIC,
            mapping=json.dumps(mapping),
            exclude_values=exclude_values_json,
            is_primary=True,
            is_auto_detected=True,
            sequence_order=0,
        )
        db.add(recode_def)

    db.flush()  # get recode definition IDs

    # -- 3. Process data rows -> rows + values ----------------------------------
    values_created = 0

    for row_idx, data_row in enumerate(data_rows):
        # System-generated record identifier
        record_id = f"R{str(row_idx + 1).zfill(pad_width)}"

        # Create row (no participant linking at import time)
        ds_row = DatasetRow(
            dataset_id=dataset.id,
            participant_id=None,
            row_identifier=record_id,
            submitted_at=None,
        )
        db.add(ds_row)
        db.flush()

        # Create values
        for col_idx, column in columns.items():
            if col_idx >= len(data_row):
                continue
            cell = data_row[col_idx].strip()
            if not cell:
                continue

            cfg = cfg_by_idx.get(col_idx, {})
            value_numeric = _compute_value_numeric(
                cell, cfg.get("column_type", ""), cfg.get("scale_labels"),
            )

            col_type = cfg.get("column_type", "")
            wc = len(cell.split()) if col_type == "open_text" and cell.strip() else None

            db.add(DatasetValue(
                row_id=ds_row.id,
                column_id=column.id,
                value_text=cell,
                value_numeric=value_numeric,
                word_count=wc,
            ))
            values_created += 1

    db.flush()

    return {
        "dataset_id": dataset.id,
        "columns_created": len(columns),
        "rows_created": len(data_rows),
        "values_created": values_created,
    }
