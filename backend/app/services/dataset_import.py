"""
Dataset CSV import service for Mixed Measures.

Follows the same preview -> import philosophy as csv_import.py but handles
dataset/questionnaire data rather than conversation transcripts.
"""

import csv
import io
import json
import logging
import math
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from itertools import islice
from sqlalchemy import insert as sa_insert
from sqlalchemy.orm import Session

from ..models.dataset import (
    ColumnType,
    Dataset,
    DatasetColumn,
    DatasetRow,
    DatasetValue,
)
from ..models.recode import RecodeDefinition, RecodeType, OutputType
from .missing_values import (  # noqa: F401 — _NA_PREFIXES/_is_na re-export (#592 slab 1)
    _NA_PREFIXES,
    _is_na,
    is_missing,
    matched_missing_label,
    missing_rules_for,
)
from .dataset_rows import materialise_manual_cells  # #897

# #691: this module called logger.warning() at two sites with no `logger` in scope,
# so a malformed .sav — the exact case the warnings exist to report — raised
# NameError mid-import instead of degrading gracefully. Both branches are
# user-reachable (scale_values/scale_labels length mismatch; a cells_are_codes
# column with mismatched labels/values). Guarded by tests/test_logger_defined_sweep.py,
# which fails the suite for ANY module that uses `logger.` without defining it —
# the instance was a singleton backend-wide, and the class is what stays closed.
logger = logging.getLogger(__name__)

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

A spelling of a scale point is its own entry (``agreement-5pt`` and
``agreement-5pt-neutral`` differ only in the midpoint), because the labels a
column is matched to are the labels its cells are numbered by.

Matching rules: `_match_scale` owns them. Two library-wide properties are
pinned by `tests/test_dataset_import_scale_ranking.py`: every scale, given
exactly its own labels, is recognised as itself, and no two entries share a
label set (the numbering would then depend on a tiebreak).
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
    # #1102: the midpoint spelled "Neutral" or "Neither agree nor disagree".
    # Without these, a column using either spelling matched a smaller scale
    # and its midpoint answers imported with no number.
    {
        "name": "agreement-3pt-neutral",
        "labels": ["Disagree", "Neutral", "Agree"],
        "canonical": False,
    },
    {
        "name": "agreement-3pt-neither",
        "labels": ["Disagree", "Neither Agree nor Disagree", "Agree"],
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
        "name": "agreement-5pt-neutral",
        "labels": [
            "Strongly Disagree", "Disagree", "Neutral",
            "Agree", "Strongly Agree",
        ],
        "canonical": False,
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
    {
        "name": "agreement-7pt-neutral",
        "labels": [
            "Strongly Disagree", "Disagree", "Somewhat Disagree",
            "Neutral",
            "Somewhat Agree", "Agree", "Strongly Agree",
        ],
        "canonical": False,
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


def _csv_lines(text: str) -> Iterator[str]:
    """Yield ``text`` one line at a time, without a copy of the whole file.

    \ud83d\udd34 **`io.StringIO(text)` stores its buffer as UCS-4 \u2014 MEASURED at exactly
    4.00 bytes per character**, whatever compact representation the source
    string has. So `csv.reader(io.StringIO(text))` on a 36 MB file allocates
    **144 MB** before a single row is read and holds it for the whole parse, and
    every reader on this path paid it: the preview, `_scan_source_rows`, and the
    import's own write loop \u2014 so an import paid it twice. Measured on a 160 KB
    fixture: `io.StringIO(text)` alone is 640,224 B resident where this
    generator is **28 B**.

    \u26a0\ufe0f **It is the CONSTRUCTOR, not the class \u2014 do not "fix" the writer.**
    Measured on the same fixture: `io.StringIO(text)` is 4.00 B/char while
    `io.StringIO().write(text)` is **1.25 B/char**, because writing goes through
    the compact unicode writer and only widens if the content needs it. So
    `xlsx_to_csv_text`'s `StringIO` sink is already cheap, and replacing it with
    a list-and-join is slightly WORSE (measured at GSS's shape: 289.4 MB vs
    293.7 MB peak).

    Each line is yielded WITH its terminator, exactly as `StringIO.readline`
    gives it, so `csv.reader` sees byte-identical input \u2014 including a quoted
    field spanning several lines, where the reader pulls further lines from this
    iterator itself, and a final line with no terminator.

    \u26a0\ufe0f Splitting on ``\\n`` alone is not a simplification: `io.StringIO`'s
    default ``newline="\\n"`` does no translation either, so a ``\\r\\n`` file
    yields lines ending ``\\r\\n`` from both and `csv.reader` strips the ``\\r``.
    Pinned by `test_dataset_preview_streaming.py::TestCsvLinesMatchesStringIO`,
    which compares the two readers over a corpus of awkward CSV.
    """
    start = 0
    end = len(text)
    while start < end:
        nl = text.find("\n", start)
        if nl < 0:
            yield text[start:]
            return
        yield text[start:nl + 1]
        start = nl + 1


class CsvReadError(csv.Error, ValueError):
    """A file the CSV reader cannot read, with a sentence saying where and why (#1083).

    🔴 **Both bases, on purpose.** Every caller that already caught `csv.Error` or
    `ValueError` keeps catching this one, so no path can turn it into a 500 — and
    the endpoints that know it show `str(exc)` instead of rewriting it to *"check
    the file format"*, which named neither the line nor the fault.
    """


def csv_error_sentence(exc: csv.Error, where: str) -> str:
    """What `csv.reader` refused, as guidance (#1083). ``where`` is "Line 7" or similar.

    Two of the reader's errors have a cause a researcher can act on, and each is
    named rather than echoed:

    - **`field larger than field limit`** — a value over `csv.field_size_limit()`
      (131,072 characters). Almost always a quotation mark that opens a value and
      never closes, so the rest of the file reads as one value.
    - **`new-line character seen in unquoted field`** — a carriage return inside a
      value. A file saved with old Mac line endings (a carriage return alone) is
      one long line of them, so every row fails at once.

    ⚠️ The limit is NOT raised to let a long value through. It is process-global
    state shared by every reader in the app, and what it catches here is the
    unclosed quote, which would otherwise swallow the rest of the file silently.
    """
    message = str(exc)
    if "field larger than field limit" in message:
        return (
            f"{where} holds a value longer than {csv.field_size_limit():,} characters, "
            "the most one value can be. That is usually a quotation mark that opens a "
            "value and is never closed, so everything after it reads as one value — "
            "check the quotation marks on that line."
        )
    if "new-line character seen in unquoted field" in message:
        return (
            f"{where} has a line break inside a value that is not in quotes. A file "
            "saved with old Mac line endings does this on every line — save it again "
            "as “CSV UTF-8” and try again."
        )
    return f"{where} could not be read as CSV ({message}). Check the file and try again."


#: How many malformed records a report names (#985). The count covers them all;
#: past a handful the fault is the file's convention, not a few rows.
OVERLONG_EXAMPLE_LIMIT = 10


@dataclass
class OverlongRecords:
    """Records with MORE values than the header has columns (#985).

    The surplus is the signature of a quoting fault — an answer holding a comma
    that nobody wrapped in quotes — and every value after that comma sits one
    column to the right of where it belongs, with the last one dropped. Silent
    before this: the preview `zip`ped the surplus away and the import never read
    past the header's width, so the two agreed with each other and not with the
    file.

    ⚠️ **A SHORT record is not reported, deliberately.** A trailing cell left off
    means "no answer" in hand-edited CSV and imports correctly; it is also
    indistinguishable from a missing comma, so flagging it would cry wolf on the
    most common malformation there is.
    ⚠️ **Empty surplus is not reported either** — ``1,2,3,`` under a three-column
    header is a trailing-comma export artefact, and nothing is displaced.

    ``record`` is the record's number in the FILE (for a new dataset, its record
    number there too); ``line`` is where it starts, which is what a text editor
    or a spreadsheet shows. ``row_id`` is filled in by an import once the record
    has a row, so a report written after the fact can link to it.
    """

    header_width: int
    count: int = 0
    examples: list[dict] = field(default_factory=list)

    def note(self, record: int, line: int, cells: int) -> None:
        self.count += 1
        if len(self.examples) < OVERLONG_EXAMPLE_LIMIT:
            self.examples.append(
                {"record": record, "line": line, "cells": cells, "row_id": None},
            )

    def as_payload(self) -> dict:
        return {
            "count": self.count,
            "header_width": self.header_width,
            "examples": [dict(e) for e in self.examples],
        }


class CsvRecords:
    """THE reader of dataset CSV text: its header, then its RECORDS (#983, #985).

    Every reader of the text — the import preview, the column describer and
    narrower, the import's scan and write passes, both append steps — iterates
    this, so they cannot disagree about what a record is or how many there are.
    Before it, the preview skipped a blank line and the import made a respondent
    of it (#983), and nothing noticed a row that was too long (#985).

    🔴 **What a record is.** A blank LINE (no delimiter at all) is not one in a
    file with two or more columns: a record whose answers are all empty is
    written ``,,`` and still counts. In a ONE-column file the two are the same
    bytes, and a blank line is how a spreadsheet writes an empty answer, so a
    blank line BETWEEN records is a record there — skipping it would shrink the
    base a response rate is computed on. Blank lines after the last record are
    dropped in both cases (a file's trailing newlines are not respondents).

    🔴 **A line of nothing but spaces or tabs is a blank line too — in a file of
    two or more columns (#1083 c).** It reads as ONE cell, and no respondent of a
    wider file is written that way (an empty record has its commas), so it was a
    phantom respondent moving the base a response rate is computed on (#830d).
    ⚠️ **In a ONE-column file it stays a record**, deliberately: narrowing a wider
    file to one column and the `.xlsx`/`.sav` adapters both write a whitespace
    answer as a bare line, and reading it as blank would drop a real respondent
    when it is the last one.

    🔴 **A file the reader cannot read raises `CsvReadError`, naming the line the
    failing record STARTS on (#1083)** — the same line the overlong report uses.

    ⚠️ **Single-pass**, like the reader underneath it. ``overlong`` is complete
    only once the records have been read to the end.
    """

    def __init__(self, text: str):
        self._reader = csv.reader(_csv_lines(_strip_bom(text)))
        try:
            self.header: list[str] = next(self._reader, None) or []
        except csv.Error as exc:
            raise CsvReadError(csv_error_sentence(exc, "Line 1 (the header)")) from exc
        self.width = len(self.header)
        self.overlong = OverlongRecords(header_width=self.width)
        self._started = False

    def __iter__(self) -> Iterator[list[str]]:
        if self._started:
            raise RuntimeError("CsvRecords can be read once")
        self._started = True
        return self._records()

    def _records(self) -> Iterator[list[str]]:
        reader = self._reader
        width = self.width
        pending_blank_lines = 0
        record = 0
        previous_line = reader.line_num
        while True:
            # `line_num` counts physical lines consumed, so a quoted answer
            # spanning three lines moves it by three; the record STARTS on the
            # line after the previous record ended.
            line = previous_line + 1
            try:
                cells = next(reader)
            except StopIteration:
                return
            except csv.Error as exc:
                raise CsvReadError(csv_error_sentence(exc, f"Line {line:,}")) from exc
            previous_line = reader.line_num
            if not cells:
                if width == 1:
                    pending_blank_lines += 1
                continue
            if width > 1 and len(cells) == 1 and not cells[0].strip():
                # #1083 (c): spaces or a tab and no delimiter — a blank line in a
                # wider file, never a respondent (see the class docstring).
                continue
            for _ in range(pending_blank_lines):
                record += 1
                yield [""]
            pending_blank_lines = 0
            record += 1
            if len(cells) > width > 0 and any(c.strip() for c in cells[width:]):
                self.overlong.note(record, line, len(cells))
            yield cells


# -- N/A detection ------------------------------------------------------------
# #592 slab 1: _NA_PREFIXES/_is_na MOVED to services/missing_values.py — the
# declared-missing predicate module, where they are the DEFAULT rule set for
# columns with no declaration. Re-exported here under the old names (imported
# at the top of this file) so the many existing importers (grouping,
# code_analysis, computed_columns, data_quality, export_r, …) are unchanged;
# slab 2 migrates call sites to the column-aware predicate.


# -- LimeSurvey header parsing ------------------------------------------------

_LS_QUESTION_RE = re.compile(r"^([A-Z]\d{2}[A-Z]\d{2})\.\s*(.+)$")
_CODE_DOT_TEXT_RE = re.compile(r"^(\S+)\.\s+(.+)$")


def parse_header(header: str) -> dict:
    """
    Parse a LimeSurvey-style header into structured parts.

    Returns dict with column_code, group_code, column_text, raw_code.
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


# -- Identifier detection (#414) -----------------------------------------------
#
# Participant/row identity codes (P001, R-17, respondent names). Header-hint-
# gated (scoping DEC-9): value shape alone must never trigger — a near-unique
# numeric measure is not an ID. Runs BEFORE the skip check in
# `_detect_column_type` because the skip lists swallow id-family headers
# ("id", "respondent id"), silently discarding the identity column.
#
# Two keyword tiers:
#   strong — the header names a PERSON concept; trusted even for 1..N values
#   weak   — bare id-words; demoted back to skip when the values are just a
#            sequential row counter (LimeSurvey's `id` column)
# "response" is a negative signal: a "Response ID" is a platform response key,
# not a person (bare camelCase `ResponseId` never matches — no word boundary).

_IDENTIFIER_STRONG_RE = re.compile(
    r"\b(?:participant|respondent|subject|pid)\b", re.IGNORECASE,
)
_IDENTIFIER_WEAK_RE = re.compile(
    r"\b(?:id|ids|uid|identifier)\b", re.IGNORECASE,
)
_IDENTIFIER_NEGATIVE_RE = re.compile(r"\bresponse\b", re.IGNORECASE)

IDENTIFIER_MIN_UNIQUENESS_RATIO = 0.95  # identity values are (near-)unique per row
IDENTIFIER_MAX_AVG_LEN = 40             # codes are short; prose runs long
IDENTIFIER_MAX_AVG_TOKENS = 4           # "Maria Lopez" yes, a sentence no
IDENTIFIER_MIN_SUBSTANTIVE = 3          # too few rows to judge uniqueness


def _normalize_header_words(text: str | None) -> str:
    """Lower + collapse ``_``/``-``/``.`` to spaces so ``\\b`` can fire —
    Python regex treats ``_`` as a word character, so ``\\bid\\b`` never
    matches inside ``participant_id`` (the `_header_signals_percentage`
    lesson)."""
    if not text:
        return ""
    return re.sub(r"[_\-\.]+", " ", text).lower()


@dataclass(frozen=True)
class SubstantiveValues:
    """One column's substantive values — non-empty, and not recognised missing.

    🔴 **``cell_count`` is CELLS and ``distinct`` is KINDS, and the detection
    heuristics divide one by the other.** `_is_identifier_column` requires
    ``len(distinct) / cell_count`` to be HIGH (an identity is near-unique per
    record) and `_looks_like_nominal_labels` requires it to be LOW (a category
    repeats). Passing the distinct count as the cell count makes that ratio 1.0
    for every column, which reads every id-ish header as an identifier and every
    repeated-label column as free prose. They are separate fields, and nothing
    may derive one from the other.

    ``distinct`` is in FIRST-SEEN order, which `suggested_scale_unmatched`
    reports in (#364 — "preserve original casing + first-seen order"), so it is
    a tuple rather than a set. ``unique`` is the same values as a frozenset,
    derived once in `of` so the two cannot disagree.

    ⚠️ **This carries no cell LIST, deliberately (#973 b').** `preview_dataset_csv`
    used to hold every cell of every column at once, and nothing downstream ever
    wanted the duplicates: the three consumers of the old list called `len()` on
    it twice and walked it once to collect first-seen distinct values — so all
    three are count- or distinct-derivable, which is what made the streaming
    rewrite ONE pass rather than two. ⚠️ **Dropping the list is not by itself a
    memory win** — see the note in `preview_dataset_csv`'s parse loop, which
    records the measurement that refutes that reading.
    """

    distinct: tuple[str, ...]
    unique: frozenset[str]
    cell_count: int

    @classmethod
    def of(cls, distinct: tuple[str, ...], cell_count: int) -> "SubstantiveValues":
        """THE constructor — `unique` is derived here and nowhere else."""
        return cls(distinct=distinct, unique=frozenset(distinct), cell_count=cell_count)

    @classmethod
    def from_cells(cls, cells: list[str]) -> "SubstantiveValues":
        """From a cell list, for callers that legitimately hold one.

        The preview does NOT — it tallies as it streams and calls `of` — so this
        is for tests and for any caller working from an already-materialised
        column. It is the definition of the two fields, kept executable.
        """
        return cls.of(tuple(dict.fromkeys(cells)), len(cells))


def _is_sequential_counter(substantive_set: frozenset[str] | set[str]) -> bool:
    """True when the values are a dense integer sequence starting at 0/1 —
    a platform row counter, not an identity referenced by other sources."""
    try:
        ints = {int(v) for v in substantive_set}
    except ValueError:
        return False
    return min(ints) in (0, 1) and (max(ints) - min(ints) + 1) == len(ints)


def _is_identifier_column(
    header: str,
    raw_code: str | None,
    values: SubstantiveValues,
) -> bool:
    """#414 / DEC-9: header-hint-gated participant-identifier detection."""
    words = _normalize_header_words(header)
    code_words = _normalize_header_words(raw_code)
    if _IDENTIFIER_NEGATIVE_RE.search(words) or _IDENTIFIER_NEGATIVE_RE.search(code_words):
        return False
    strong = bool(
        _IDENTIFIER_STRONG_RE.search(words) or _IDENTIFIER_STRONG_RE.search(code_words)
    )
    weak = bool(
        _IDENTIFIER_WEAK_RE.search(words) or _IDENTIFIER_WEAK_RE.search(code_words)
    )
    if not (strong or weak):
        return False
    # CELLS, not kinds — see SubstantiveValues. An identity is near-unique per
    # record, so this ratio is the discriminator and collapsing the two makes it
    # 1.0 for every column.
    n = values.cell_count
    if n < IDENTIFIER_MIN_SUBSTANTIVE:
        return False
    unique_count = len(values.distinct)
    if (unique_count / n) < IDENTIFIER_MIN_UNIQUENESS_RATIO:
        return False
    avg_len = sum(len(v) for v in values.distinct) / unique_count
    if avg_len > IDENTIFIER_MAX_AVG_LEN:
        return False
    avg_tokens = sum(len(v.split()) for v in values.distinct) / unique_count
    if avg_tokens > IDENTIFIER_MAX_AVG_TOKENS:
        return False
    # A bare id-word over a dense 1..N counter is platform metadata — keep skip.
    if not strong and _is_sequential_counter(values.unique):
        return False
    return True


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


def _is_boolean(values: frozenset[str] | set[str]) -> bool:
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


def _analyze_numeric(values: Sequence[str], header: str | None = None) -> dict | None:
    """
    Analyze values for numeric patterns.

    Returns dict with column_type (ColumnType), numeric_format, numeric_min,
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
    matched: frozenset[str] | set[str], unmatched: frozenset[str] | set[str],
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


def _match_scale(values: frozenset[str] | set[str]) -> tuple[str, list[str]] | None:
    """
    Find the best matching known scale for a set of values.

    Which scales qualify:
      - At least 2 distinct substantive values.
      - Tolerant match: most data values must appear in the scale, allowing a
        small number of stray values (typos) — see `_scale_match_within_tolerance`.
      - Coverage: the matched values cover >= 50% of the scale's labels.

    Which qualifying scale wins (in priority order):
      1. Fewest unmatched values — a scale that numbers every answer beats one
         that leaves an answer out
      2. Tightest fit: fewest labels
      3. Best coverage: highest percentage of labels present in the data
      4. Canonical preference: canonical=True wins over canonical=False
      5. Alphabetical tiebreaker on name

    🔴 **Rule 1 is what #364's tolerance needs, and it was missing until #1102.**
    Before the tolerance, every qualifying scale held every value, so "fewest
    labels" alone picked the tightest correct scale. After it, a smaller scale
    could qualify with a real answer counted as a stray, and "fewest labels" then
    preferred it: `agreement-5pt`'s own five labels matched `agreement-4pt`, so
    the midpoint imported with no number and Agree/Strongly agree scored 3/4.
    Nine of the library's scales failed to recognise their own labels that way
    (measured). A stray is now only ever what no qualifying scale accounts for.

    Returns (scale_name, ordered_labels) or None.
    """
    if not values or len(values) < 2:
        return None
    lower_vals = {v.lower() for v in values}
    matches: list[tuple[dict, float, int]] = []
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
            matches.append((scale, coverage, len(unmatched)))
    if not matches:
        return None
    matches.sort(key=lambda x: (
        x[2],                      # fewest unmatched values (#1102)
        len(x[0]["labels"]),       # tightest fit (fewest labels)
        -x[1],                     # best coverage (highest %)
        not x[0]["canonical"],     # canonical preference (True first)
        x[0]["name"],              # alphabetical tiebreaker
    ))
    best = matches[0][0]
    return (best["name"], best["labels"])


# -- Numeric value computation for answers -------------------------------------


def _coerce_scale_codes(scale_values: list[float]) -> list[int | float]:
    """Store an integral scale code as an int, so both import paths agree (#28).

    The CSV path derives codes from `range(1, n+1)` and stores `[1, 2, 3]`; the
    .sav path receives them as JSON floats and would store `[1.0, 2.0, 3.0]` for
    the same logical scale. `routers/export_r.py` emits `scale_values` verbatim as
    R factor levels, so the divergence would surface in exported scripts.
    """
    return [int(v) if float(v).is_integer() else float(v) for v in scale_values]


def _compute_value_numeric(
    raw_value: str,
    question_type: str,
    scale_labels: list[str] | None,
    scale_values: list[float] | None = None,
    missing_rules: list | None = None,
) -> float | None:
    """Compute the numeric encoding for a cell value.

    ``scale_values`` (#28) supplies the codes an ordinal scale's labels actually
    carry, parallel to ``scale_labels``. SPSS files know them (a scale may be
    0-based, or skip codes); CSV imports do not and pass None, which keeps the
    historical positional 1..N encoding byte-for-byte. A length mismatch falls
    back to positional rather than silently mis-encoding.

    ``missing_rules`` (#592) is the COLUMN's parsed missing declaration —
    None = undeclared, the recognized-N/A defaults (behavior unchanged for
    every caller that doesn't pass it). A declared column's rules REPLACE the
    defaults, so a declared "99" encodes NULL and a declared-[] column's
    "N/A" encodes as data.
    """
    if is_missing(raw_value, missing_rules):
        return None

    if question_type == ColumnType.ORDINAL.value:
        if scale_labels:
            if scale_values and len(scale_values) == len(scale_labels):
                codes = [float(v) for v in scale_values]
            else:
                codes = [float(i + 1) for i in range(len(scale_labels))]
            label_map = {l.lower(): codes[i] for i, l in enumerate(scale_labels)}
            return label_map.get(raw_value.strip().lower())
        # #580: an ordinal column with NO scale labels (a bare-numeric Likert item
        # the user overrode to ordinal — inference only ever suggests ORDINAL when
        # a known TEXT scale matches) used to return None here, so value_numeric was
        # NULL in every cell and the column silently vanished from every numeric
        # analysis — violating the VALUE_NUMERIC_TYPES/SCALE_SCORE_ELIGIBLE_TYPES
        # contract that ordinal's value_numeric is reliably populated. A bare number
        # IS its own code, so fall back to the numeric parse (identical to how a
        # NUMERIC column encodes the same cell). A non-numeric cell in such a column
        # still yields None, exactly as an out-of-scale label would.
        return _strip_numeric(raw_value)

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
# #575: a numbers-only column with more distinct values than this is treated as a
# continuous measure, not a labellable scale — the wizard won't seed a code editor.
VALUE_LABEL_SEED_MAX_CODES = 30

NOMINAL_MAX_CARDINALITY = 100        # ceiling — beyond this, default to open_text
NOMINAL_MAX_UNIQUENESS_RATIO = 0.5   # unique/n must be below this (labels repeat)
NOMINAL_MAX_AVG_LABEL_LEN = 30       # avg label length (chars) — prose runs longer


def _looks_like_nominal_labels(values: SubstantiveValues) -> bool:
    """#380: heuristic for a high-cardinality categorical (repeated short labels)
    vs genuine free text. Caller has already ruled out numeric and <=10-unique."""
    # CELLS, not kinds — a category REPEATS, which is the whole signal here, and
    # a collapsed ratio of 1.0 sends every such column to open_text.
    n = values.cell_count
    unique_count = len(values.distinct)
    if n == 0 or unique_count == 0:
        return False
    if unique_count > NOMINAL_MAX_CARDINALITY:
        return False
    if (unique_count / n) >= NOMINAL_MAX_UNIQUENESS_RATIO:
        return False
    avg_label_len = sum(len(v) for v in values.distinct) / unique_count
    return avg_label_len <= NOMINAL_MAX_AVG_LABEL_LEN


def _detect_column_type(
    header: str,
    parsed: dict,
    values: SubstantiveValues,
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
        # #28: only a format that KNOWS its scale codes fills this (SPSS .sav, via
        # sav_import.apply_sav_metadata). Inference over CSV text never can, so
        # None here means "positional 1..N" downstream.
        "suggested_scale_values": None,
        "suggested_scale_unmatched": None,
        "suggested_demographic_subtype": None,
        "numeric_format": None,
        "numeric_min": None,
        "numeric_max": None,
    }

    # 0. Identifier (#414) — MUST run before skip: the skip lists swallow
    # id-family headers ("id", "respondent id"), discarding the identity column.
    if _is_identifier_column(header, parsed["raw_code"], values):
        result["suggested_type"] = ColumnType.IDENTIFIER.value
        return result

    # 1. Skip (platform metadata)
    if _is_skip_column(header, parsed["raw_code"]):
        result["suggested_type"] = ColumnType.SKIP.value
        return result

    # 2. Demographic (short headers only — check parsed question text, not raw header)
    if _is_demographic(parsed["column_text"]):
        result["suggested_type"] = ColumnType.DEMOGRAPHIC.value
        result["suggested_demographic_subtype"] = _detect_demographic_subtype(parsed["column_text"])
        return result

    if not values.distinct:
        return result  # defaults to open_text

    # 3. Binary
    if _is_boolean(values.unique):
        result["suggested_type"] = ColumnType.BINARY.value
        return result

    # 4. Small cardinality (<=10 unique): scale first, then numeric, then nominal
    if len(values.distinct) <= 10:
        match = _match_scale(values.unique)
        if match:
            result["suggested_type"] = ColumnType.ORDINAL.value
            result["suggested_scale_name"] = match[0]
            result["suggested_scale_labels"] = match[1]
            # Surface any values not in the matched scale (#364). These keep
            # their text but import with value_numeric=None, so every statistic
            # leaves them out. Since #1102 they are values NO qualifying scale
            # accounts for — a typo, or a spelling the library does not know —
            # never a point of a larger scale. Preserve original casing +
            # first-seen order.
            #
            # ⚠️ Walking `distinct` rather than every cell is the SAME result:
            # the first cell carrying a given lower-cased form is also the first
            # DISTINCT value carrying it, because first-seen order is preserved
            # by both. The case-fold de-dup below is still needed — "Agree" and
            # "agree" are two distinct values and one unmatched report.
            label_lower = {l.lower() for l in match[1]}
            unmatched = [v for v in values.distinct if v.lower() not in label_lower]
            seen: set[str] = set()
            unmatched_unique = [
                v for v in unmatched if not (v.lower() in seen or seen.add(v.lower()))
            ]
            result["suggested_scale_unmatched"] = unmatched_unique or None
            return result

        # #358: pass header so the percentage keyword check can fire
        numeric = _analyze_numeric(values.distinct, header=header)
        if numeric:
            result["suggested_type"] = numeric["column_type"].value
            result["numeric_format"] = numeric["numeric_format"]
            result["numeric_min"] = numeric["numeric_min"]
            result["numeric_max"] = numeric["numeric_max"]
            return result

        result["suggested_type"] = ColumnType.NOMINAL.value
        return result

    # 5. High cardinality (>10 unique)
    numeric = _analyze_numeric(values.distinct, header=header)  # #358
    if numeric:
        result["suggested_type"] = numeric["column_type"].value
        result["numeric_format"] = numeric["numeric_format"]
        result["numeric_min"] = numeric["numeric_min"]
        result["numeric_max"] = numeric["numeric_max"]
        return result

    # 5b. High-cardinality categorical (#380): repeated short labels, not prose
    if _looks_like_nominal_labels(values):
        result["suggested_type"] = ColumnType.NOMINAL.value
        return result

    # 6. Open text
    result["suggested_type"] = ColumnType.OPEN_TEXT.value
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════════════════════
# Excel (.xlsx) adapter (#523)
# ═══════════════════════════════════════════════════════════════════════════════
#
# .xlsx support is a format ADAPTER: the workbook is converted to CSV text at the
# router boundary and everything downstream (type inference, N/A handling, import)
# runs the existing CSV pipeline unchanged. Keep it that way — new formats should
# adapt into CSV text here, never fork the inference/import code paths.

# Structural caps: a .xlsx is a ZIP, so a small upload can inflate enormously.
# These bound the parse work independently of the 50 MB upload cap.
# ── The real size gate: CELLS (#799/#803) ────────────────────────────────────
# The byte and dimension caps beside this one are cheap PRE-FILTERS; neither
# bounds what an import actually costs.
#
#   * BYTES vary ~4x by format — a compressed .xlsx expands into roughly four
#     times its size in CSV — so the same 50 MB budget buys wildly different
#     work depending on which file the researcher happens to have.
#   * DIMENSIONS MULTIPLY. 100,000 rows and 500 columns are each defensible on
#     their own and authorise **50,000,000 cells** together — 16x the file that
#     already exceeded every memory target in this codebase.
#
# What costs time and memory is CELLS, and it is linear in them: MEASURED at
# 23.4 / 23.6 / 24.0 s per million cells across 410K / 1.03M / 2.05M-cell
# imports of the same real file.
#
# 4,000,000 is set ABOVE the largest real dataset this has been driven against
# (GSS: 75,699 x 41 = 3,103,659) on purpose. Sizing the cap to what fits the
# <256 MB resident target would put it near 2M cells and REFUSE an ordinary
# research dataset, which is the tool declining real work.
#
# ⚠️ **The memory budget is two numbers, not one, and this is the deliberate
# part.** `<256 MB` is a RESIDENT target — a steady-state property of a server
# answering requests, and the paginated grid honours it (96 MB per page, down
# from 5,877 MB). An import is a one-off TRANSIENT: measured at 297 MB (CSV) and
# 346 MB (.xlsx) for 3.1M cells, so ~450 MB at this cap. That allowance is
# chosen and stated here rather than discovered later.
MAX_DATASET_CELLS = 4_000_000

# #973 (c): how many rows the cheap first stage shows per column. Bounded by
# CONSTRUCTION rather than by a cap — `DESCRIBE_SAMPLE_ROWS x n_cols` cells for
# any file, so a 422-column workbook costs ~8,000 cells to describe.
DESCRIBE_SAMPLE_ROWS = 5


class DatasetTooLargeError(ValueError):
    """Refused: over `MAX_DATASET_CELLS` (#803).

    ⚠️ A DISTINCT type, not a bare `ValueError`, because the preview endpoint
    catches `(ValueError, csv.Error, TypeError)` and replaces it with "Unable to
    parse CSV file. Check the file format and try again." — a diagnosis it has
    not established, about a file that parses perfectly well. That is the #797
    defect exactly, and a shared exception type is how it would have recurred.
    The router catches this one FIRST and shows its message verbatim.
    """


# 🔴 **The remedy sentence, shared by both cap messages, and it no longer names
# the wizard (#973 defect 1).** Both used to say *"Importing fewer columns — the
# wizard can skip any you don't need"*, and **a researcher shown either message
# can never reach that screen**: the cap is enforced at PREVIEW, which is
# upstream of the wizard (`.xlsx` refuses on declared dimensions before reading a
# cell, `.sav` on its metadata, CSV by bailing mid-stream). The tool refused a
# file and then named an action that cannot be taken from inside it.
#
# ⚠️ **Skipping would not have helped even from inside the wizard**, because
# `import_dataset_csv` measures `len(headers)` — the FILE's full width — while
# `_scan_source_rows` beside it honours `cfg["skip"]`. That is #973 (a), it is
# INERT until the two-stage preview (c) exists, and it is deliberately not
# addressed by this sentence. Say only what is true today.
#
# ⚠️ Unlike the APPEND remedy (`append_cell_count_error`), splitting by rows DOES
# work here: two files import as two datasets, each under the cap. The cap counts
# one dataset, so on the append path the same advice is false.
CELL_CAP_REMEDY = (
    "Removing columns you do not need, or splitting the rows across more than "
    "one file, will bring it under — both have to be done in the file itself, "
    "before importing."
)


def cell_cap_exceeded_message(n_cols: int) -> str:
    """The refusal for a STREAMING path, which bails before it has counted.

    ⚠️ Deliberately does NOT quote a row total. The caller stops the moment the
    cap is crossed, so it does not know how many rows the file has — and a
    message naming the count at the point of the bail would state a number that
    is simply wrong, which is the #797 lesson (report what you know, never a
    plausible-looking guess).
    """
    return (
        f"This dataset is over the {MAX_DATASET_CELLS:,}-value limit at "
        f"{n_cols:,} columns. {CELL_CAP_REMEDY}"
    )


def cell_count_error(n_rows: int, n_cols: int) -> str | None:
    """The refusal message for an over-cap dataset, or None if it fits.

    ONE function so CSV, .xlsx and .sav refuse at the same size for the same
    reason — the three formats had three different limits expressed in three
    different units, and none of them was cells.
    """
    cells = n_rows * n_cols
    if cells <= MAX_DATASET_CELLS:
        return None
    return (
        f"This dataset is {n_rows:,} rows x {n_cols:,} columns = {cells:,} values, "
        f"over the {MAX_DATASET_CELLS:,} limit. {CELL_CAP_REMEDY}"
    )


def append_cell_count_error(
    existing_rows: int, incoming_rows: int, n_cols: int,
) -> str | None:
    """The refusal for an APPEND that would take a dataset over the cap (#972).

    🔴 **A SEPARATE message, because `cell_count_error`'s advice cannot work on
    this path — importing it would import the bug.** That message says *"Importing
    fewer columns — the wizard can skip any you don't need"*, and an append maps a
    file onto the dataset's EXISTING columns, so deselecting a file column does not
    change the dataset's width by one cell. Its other half, *"splitting the file by
    rows"*, is wrong here too: the cap counts the whole dataset, so two appends of
    half the rows land at exactly the same total. That is #973's defect (a refusal
    naming an action that cannot be taken) arriving on a second path.

    🔴 **Stated as HEADROOM rather than a predicted total, which is what makes it
    both honest and useful.** `append_import` skips duplicate rows, so the file's
    row count is an UPPER bound on what actually lands — and finding the real
    number means fingerprinting every existing row, i.e. the full read this
    refusal exists to avoid. Room-for-N and this-file-has-M are each exact, so no
    "up to" hedge is needed, and N is the number the researcher actually wants: how
    many records they may append.

    ⚠️ **`room <= 0` is reachable and needs its own sentence.** A dataset can pass
    its import cap and grow past it afterwards, because a computed or derived
    column adds WIDTH to every existing row. "Room for -3 more records" is nonsense
    and the remedy is different, so it is answered separately.
    """
    if n_cols <= 0:
        return None
    if (existing_rows + incoming_rows) * n_cols <= MAX_DATASET_CELLS:
        return None

    current = existing_rows * n_cols
    room = MAX_DATASET_CELLS // n_cols - existing_rows
    if room <= 0:
        return (
            f"This dataset already holds {existing_rows:,} records x {n_cols:,} "
            f"variables = {current:,} values, at the {MAX_DATASET_CELLS:,} limit, "
            "so no more records can be appended. Removing variables or records "
            "from the dataset is what brings it under."
        )
    return (
        f"This dataset holds {existing_rows:,} records x {n_cols:,} variables = "
        f"{current:,} of the {MAX_DATASET_CELLS:,}-value limit, so it has room for "
        f"{room:,} more records. This file has {incoming_rows:,}."
    )


MAX_XLSX_ROWS = 100_000
MAX_XLSX_COLS = 500

XLSX_MAGIC = b"PK\x03\x04"  # xlsx files are ZIP containers


class XlsxImportError(ValueError):
    """User-facing .xlsx parse/validation failure (surfaced as HTTP 400)."""


def is_xlsx_upload(filename: str | None, content: bytes) -> bool:
    """True when the upload should take the .xlsx adapter path.

    Requires BOTH the extension and the ZIP magic — a mis-renamed CSV falls
    through to the text path (where it may still parse), and a renamed
    non-zip binary fails fast instead of confusing openpyxl.
    """
    return bool(filename) and filename.lower().endswith(".xlsx") and content[:4] == XLSX_MAGIC


def _xlsx_cell_to_str(value) -> str:
    """Stringify a cell the way Excel's own save-as-CSV would (CSV parity).

    Order matters: bool is a subclass of int, so it must be checked first.
    """
    import datetime as _dt

    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        # openpyxl yields 3.0 for a typed 3 — trim so value_text matches the CSV twin.
        if value.is_integer() and abs(value) < 1e15:
            return str(int(value))
        return str(value)
    if isinstance(value, _dt.datetime):
        if value.hour == 0 and value.minute == 0 and value.second == 0 and value.microsecond == 0:
            return value.date().isoformat()
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, (_dt.date, _dt.time)):
        return value.isoformat()
    return str(value)


def _open_xlsx(content: bytes):
    """Open an uploaded workbook read-only, or raise XlsxImportError."""
    import io as _io
    import zipfile

    from openpyxl import load_workbook
    from openpyxl.utils.exceptions import InvalidFileException

    try:
        return load_workbook(_io.BytesIO(content), read_only=True, data_only=True)
    except (InvalidFileException, zipfile.BadZipFile, KeyError, ValueError, OSError) as e:
        raise XlsxImportError(f"Unable to read the Excel file: {e}") from e


def _xlsx_sheet(wb, sheet_name: str | None):
    """The requested worksheet plus the workbook's sheet names, validated."""
    sheet_names = list(wb.sheetnames)
    if not sheet_names:
        raise XlsxImportError("The Excel workbook contains no worksheets.")
    target = sheet_name or sheet_names[0]
    if target not in sheet_names:
        raise XlsxImportError(f'Worksheet "{target}" was not found in the workbook.')
    return wb[target], sheet_names, target


def describe_xlsx(content: bytes, sheet_name: str | None = None) -> dict:
    """The cheap first stage for a workbook (#973 c) — `describe_csv_text`'s twin.

    Returns ``{"headers", "row_count", "samples", "sheet_names"}``.

    🔴 **MEASURED: 0.02 s and ~2 MB on the GSS workbook, against 9.3 s and 222 MB
    for the full conversion.** That gap is what makes a two-stage preview worth
    having at all on this format: `xlsx_to_csv_text` materialises every cell of
    the sheet and then the whole CSV string, so an over-cap workbook costs the
    memory the cap exists to refuse just to find out what its columns are called.

    ⚠️ **Applies NO cap**, for the reason `describe_csv_text` gives.
    ⚠️ ``row_count`` is openpyxl's DECLARED `max_row`, which can OVERCOUNT on a
    sheet carrying formatting residue — the same figure `xlsx_to_csv_text` uses
    for its cheap pre-check, and stated as approximate for the same reason. The
    authoritative count comes from the narrowed conversion in stage two.
    """
    wb = _open_xlsx(content)
    try:
        ws, sheet_names, _target = _xlsx_sheet(wb, sheet_name)
        headers: list[str] = []
        samples: list[list[str]] = []
        for i, row in enumerate(ws.iter_rows(values_only=True, max_row=DESCRIBE_SAMPLE_ROWS + 1)):
            cells = [_xlsx_cell_to_str(v) for v in row]
            if i == 0:
                while cells and cells[-1] == "":
                    cells.pop()
                headers = cells
                samples = [[] for _ in headers]
                continue
            for j, sample in enumerate(samples):
                sample.append(cells[j] if j < len(cells) else "")
        declared_rows = max((ws.max_row or 1) - 1, 0)
    finally:
        wb.close()

    if not headers:
        raise XlsxImportError('The selected worksheet has no header row.')
    return {
        "headers": headers,
        "row_count": declared_rows,
        "samples": samples,
        "sheet_names": sheet_names,
    }


def xlsx_to_csv_text(
    content: bytes, sheet_name: str | None = None, columns: list[int] | None = None,
) -> tuple[str, list[str]]:
    """Convert one worksheet of a .xlsx upload into CSV text.

    Returns (csv_text, sheet_names). ``sheet_name`` None selects the first sheet.
    Formula cells carry the file's cached computed value (``data_only=True``); a
    workbook saved without computed caches yields blanks for them.

    ``columns`` (#973 c) narrows the conversion to those ORIGINAL column indices,
    in order. 🔴 **It narrows while READING, not afterwards** — this function's
    cost is one Python `str` per cell of the sheet plus the whole CSV string, so a
    selection applied after the fact would spend exactly the memory the cell cap
    exists to refuse. With a selection the cap is then applied to the SELECTION,
    which is the whole of #973 (a): there is no wider file left to count.

    Raises XlsxImportError for anything the user should fix (bad zip, unknown
    sheet, empty sheet, over-cap dimensions).
    """
    import io as _io

    wb = _open_xlsx(content)

    try:
        ws, sheet_names, target = _xlsx_sheet(wb, sheet_name)

        # #803: refuse on the sheet's DECLARED dimensions, before any cell is
        # read — an over-cap workbook must not cost the memory it is being
        # refused for. openpyxl's max_row/max_column can OVERCOUNT (formatting
        # residue, trimmed later), so this only ever refuses what is genuinely
        # over; the authoritative check runs on the trimmed dimensions below.
        # ⚠️ #973 (c): with a SELECTION the declared width is the selection's,
        # because that is all this conversion will emit. Counting the sheet's
        # full width here would refuse the very file the selection exists to
        # rescue, which is the dead end (c) is fixing.
        if columns is not None:
            try:
                _refuse_unknown_columns(columns, ws.max_column or 0)
            except ColumnSelectionError as e:
                raise XlsxImportError(str(e)) from e
        declared_cols = len(columns) if columns is not None else (ws.max_column or 0)
        declared = cell_count_error(ws.max_row or 0, declared_cols)
        if declared:
            raise XlsxImportError(declared)

        rows: list[list[str]] = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= MAX_XLSX_ROWS:
                raise XlsxImportError(
                    f"The worksheet has more than {MAX_XLSX_ROWS:,} rows. "
                    "Split the data into smaller files and import them separately."
                )
            if len(row) > MAX_XLSX_COLS:
                raise XlsxImportError(
                    f"The worksheet has more than {MAX_XLSX_COLS} columns."
                )
            if columns is None:
                rows.append([_xlsx_cell_to_str(v) for v in row])
            else:
                # Narrow HERE: one list per row holding only the selection, so
                # the unselected cells are never stringified and never retained.
                rows.append([
                    _xlsx_cell_to_str(row[c]) if c < len(row) else "" for c in columns
                ])
    finally:
        wb.close()

    # Excel sheets often report phantom trailing rows/columns (formatting residue).
    # Trim fully-empty trailing rows, then size every row to the header's width.
    while rows and all(v == "" for v in rows[-1]):
        rows.pop()
    if not rows:
        raise XlsxImportError(f'Worksheet "{target}" has no data.')

    header = rows[0]
    # ⚠️ #973 (c): only trim trailing blank headers when converting the WHOLE
    # sheet. With a selection the width IS the selection — chosen from the header
    # list `describe_xlsx` already trimmed — so trimming again could silently
    # return fewer columns than were asked for, and every `column_index` the
    # wizard holds would then point one place to the left.
    if columns is None:
        while header and header[-1] == "":
            header.pop()
    if not header:
        raise XlsxImportError(f'Worksheet "{target}" has no header row.')
    width = len(header)

    # #803: the authoritative check, on the TRIMMED dimensions. The pre-read
    # check above uses openpyxl's declared size, which can overcount.
    trimmed = cell_count_error(len(rows) - 1, width)
    if trimmed:
        raise XlsxImportError(trimmed)

    out = _io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(header)
    for row in rows[1:]:
        sized = row[:width] + [""] * (width - len(row[:width]))
        writer.writerow(sized)

    return out.getvalue(), sheet_names


class ColumnSelectionError(ValueError):
    """Refused: the selection names a column this file does not have (#973 c).

    ⚠️ **A DISTINCT type, not a bare `ValueError`, for exactly `DatasetTooLargeError`'s
    reason (#797).** The preview and import endpoints catch
    `(ValueError, csv.Error, TypeError)` and rewrite it to "Unable to parse CSV
    file. Check the file format" — a diagnosis that is wrong here twice over: the
    file parses perfectly, and the fault is in the REQUEST. Both routers catch
    this one first and show its message verbatim.
    """


def _refuse_unknown_columns(columns: list[int], width: int) -> None:
    """Refuse a selection naming a column this file does not have (#973 c).

    ONE message for all three formats, for the same reason `cell_count_error` is
    one function: a selection is a claim about the file, and the three adapters
    would otherwise disagree about what an out-of-range index means.
    """
    beyond = [i for i in columns if i >= width]
    if beyond:
        raise ColumnSelectionError(
            f"The selection names column {beyond[0] + 1}, but this file has "
            f"{width:,} column{'' if width == 1 else 's'}. Re-read the file's "
            "columns and choose again."
        )


def describe_csv_text(text: str) -> dict:
    """The cheap first stage (#973 c): what columns are here, and how many rows.

    Returns ``{"headers": [...], "row_count": int, "samples": [[str, ...], ...]}``
    — one sample list per column, at most `DESCRIBE_SAMPLE_ROWS` long.

    🔴 **This deliberately does NOT apply `MAX_DATASET_CELLS`, and that is the
    whole point.** It is the escape hatch FROM that refusal: a researcher whose
    file is over the cap has to be able to see the column list in order to choose
    a subset, and every other reader on this path refuses first — `.xlsx` on its
    declared dimensions before reading a cell, `.sav` on its metadata,
    `preview_dataset_csv` by bailing mid-stream. Refusing here too would make the
    escape hatch refuse for the same reason as the wall.

    ⚠️ **What bounds it instead is that it accumulates nothing**: a row counter
    and five sample values per column, whatever the file's size. The one cost
    that scales is the caller's whole-file `str`, which the 50 MB upload cap
    already bounds.
    """
    records = CsvRecords(text)
    headers = records.header
    samples: list[list[str]] = [[] for _ in headers]
    row_count = 0

    # `CsvRecords` decides what a record is (#983), for this stage and every
    # later one, so the two stages agree about how big the file is.
    for row in records:
        row_count += 1
        if row_count <= DESCRIBE_SAMPLE_ROWS:
            for i, sample in enumerate(samples):
                cell = row[i].strip() if i < len(row) else ""
                sample.append(cell)

    return {"headers": headers, "row_count": row_count, "samples": samples}


def select_csv_columns(text: str, columns: list[int]) -> str:
    """The narrowed text alone — see `narrow_csv_columns`."""
    return narrow_csv_columns(text, columns)[0]


def narrow_csv_columns(text: str, columns: list[int]) -> tuple[str, OverlongRecords]:
    """Re-emit `text` carrying only `columns`, by ORIGINAL index and in order.

    Returns the narrowed text AND the ORIGINAL file's `OverlongRecords` (#985):
    the narrowed text is exactly as wide as the selection by construction, so the
    evidence of a too-long record exists only here, and a preview of the
    narrowed text alone could never report it.

    🔴 **Narrowing happens at the ADAPTER — for every format — so that everything
    downstream sees a file that IS the selection (#973 c).** The alternative,
    threading a selection through `preview_dataset_csv` and `import_dataset_csv`
    separately, keeps two notions of "which column is number 3": the preview's
    `column_index` is a position in this text, and the import RE-READS the upload,
    so a narrowing that renumbered on one path and not the other would put the
    researcher's type choices on the wrong columns, silently.

    Doing it here also makes #973 (a) fall out rather than be a second change:
    `cell_count_error(row_count, len(headers))` is already counting the selection,
    because the selection is all there is.

    ⚠️ **Records are re-emitted, not lines (#983).** A blank line that is not a
    record is dropped, and a one-column file's empty-answer record is written
    ``""`` — `csv.writer`'s spelling of a single empty field — so the narrowed
    text holds no blank line at all and reads back as the same records whatever
    width the selection is.

    🔴 **An index past the last column is REFUSED, and all three adapters refuse
    it the same way.** The router cannot check this — it does not know the file's
    width until an adapter has read the header — so each adapter checks its own.
    Without it the three would disagree: CSV and `.xlsx` would emit an empty
    column (keeping the count) while `.sav` has no variable to read and would
    return FEWER columns than were asked for, which silently shifts every
    `column_index` the wizard holds. ⚠️ A cell absent from a SHORT ROW is still
    an ordinary empty cell — that is a ragged record, not a bad selection.
    """
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    records = CsvRecords(text)
    header = records.header
    _refuse_unknown_columns(columns, len(header))
    writer.writerow([header[i] for i in columns])
    for row in records:
        writer.writerow([row[i] if i < len(row) else "" for i in columns])
    return out.getvalue(), records.overlong


def preview_dataset_csv(
    file_contents: str,
    missing_rules_by_column: dict[str, list] | None = None,
) -> dict:
    """
    Parse a survey CSV and return per-column analysis with auto-detected types.

    Args:
        file_contents: The CSV file as a decoded string (BOM handled internally).
        missing_rules_by_column: #592 slab 5 — declared missing rules keyed by
            HEADER name, known before import only for formats that carry their
            own declaration (``.sav``). Columns absent from the map fall back to
            the recognized-N/A defaults, which is every CSV/XLSX column: at
            preview time no DatasetColumn exists, so there is nothing to declare
            on yet. This is a PRE-pass, not an overlay: type detection,
            ``na_count`` and ``numeric_min``/``max`` all consume the substantive
            set, so a post-hoc fix cannot reach them. Without it, preserving
            .sav's user-missing codes (#596) makes a "Refused" cell read as real
            text and flips `suggested_type` ordinal→nominal — and for a
            non-ordinal column nothing downstream corrects it, so the flip
            persists into the imported column.

    Returns:
        Dict with ``total_rows``, ``columns`` and ``overlong_records`` (#985,
        `OverlongRecords.as_payload`).  Each column entry
        contains: column_name, column_index, sample_values, unique_count,
        empty_count, empty_percent, na_count, all_numeric, avg_text_length,
        suggested_type, suggested_scale_name, suggested_scale_labels,
        suggested_column_code, suggested_group_code, suggested_column_text,
        numeric_format, numeric_min, numeric_max.

    🔴 **Reads POSITIONALLY, and that is load-bearing twice over (#973 b').**
    Every other reader of this CSV text is positional — `_scan_source_rows`,
    `import_dataset_csv`'s write loop, `append_preview` — and this function was
    the only one keyed by header NAME. Two consequences, both reproduced before
    the change:

    * a row with FEWER cells than headers made `csv.DictReader` pad with
      ``None``, and ``None.strip()`` raised `AttributeError` — which the preview
      endpoint does not catch, so an ordinary ragged CSV answered **500**. The
      import accepts the same file and stores the trailing cells as empty.
    * two columns sharing a header collapsed in the row dict, so BOTH preview
      columns described the second one's values and each value was tallied
      twice — an ``empty_percent`` over 100% and, worse, a preview that
      disagreed with what the import would store.

    ⚠️ **Memory is bounded by CARDINALITY, not by rows.** Peak scales with how
    many DISTINCT values each column holds, so a survey collapses and a column
    of genuinely unique free text does not. The whole-file ``str`` this takes as
    its argument is a separate cost, owned by `_upload_to_csv_text`.
    """
    records = CsvRecords(file_contents)
    headers = records.header

    # #973 (b'): ONE tally per column POSITION — {value: how many cells held it},
    # in first-seen order. Never a cell list; no consumer ever wanted the
    # duplicates. The blank cell rides the tally under the "" key and is popped
    # out below, which keeps the hot loop to a single dict operation per cell.
    #
    # 🔴 **The dedup is NOT where the saving came from, and #973 said it was.**
    # Measured: replacing the cell lists with these tallies and changing nothing
    # else took the at-the-cap case from 531 MB to 644 — WORSE. The old code
    # built its per-column sets one column at a time and discarded each; these
    # are all live at once, and a dict entry costs ~38 B against a list slot's
    # 8 B, so the trade loses whenever values do not repeat. What paid for the
    # result is `_csv_lines` (read its docstring). This structure earns its place
    # on the REAL corpora, where values repeat heavily — BES 283 → 160 MB — and
    # on time, because `is_missing` is now asked once per distinct value.
    tallies: list[dict[str, int]] = [{} for _ in headers]
    total_rows = 0

    # #803: a plain .csv declares no dimensions, so the cap can only be applied
    # while reading. Bail the MOMENT it is crossed rather than after the count —
    # accumulating an over-cap file would spend exactly the memory the cap exists
    # to refuse.
    n_cols = len(headers)
    max_rows_for_cap = MAX_DATASET_CELLS // n_cols if n_cols else None

    for row in records:
        # `CsvRecords` decides what a record is — a blank line is not one in a
        # file of two or more columns — and the import reads through the same
        # class, so the two cannot disagree about the count (#983).
        total_rows += 1
        if max_rows_for_cap is not None and total_rows > max_rows_for_cap:
            raise DatasetTooLargeError(cell_cap_exceeded_message(n_cols))
        # A short row means the trailing cells are ABSENT, which is what an empty
        # cell means — and is exactly what the import stores for them
        # (`if col_idx >= len(data_row): continue`). Padding once per short row
        # keeps the per-cell path branch-free; `zip` drops any surplus cells,
        # which is what the import does too — `CsvRecords` REPORTS them (#985).
        if len(row) < n_cols:
            row = row + [""] * (n_cols - len(row))
        for tally, cell in zip(tallies, row):
            cell = cell.strip()
            tally[cell] = tally.get(cell, 0) + 1

    columns = []
    for col_idx, header in enumerate(headers):
        tally = tallies[col_idx]
        empty_count = tally.pop("", 0)
        # Every counted row tallied exactly one cell into every column, so this
        # needs no second walk of the tally.
        non_empty_count = total_rows - empty_count

        # Substantive = non-empty AND non-missing (drives type detection,
        # na_count, and the numeric min/max below).
        # #592 slab 5: column-aware when the FORMAT carried a declaration
        # (.sav's user-missing), else the recognized-N/A defaults — which is
        # every text-format column, since no DatasetColumn exists to declare on
        # until import. (It no longer calls `_is_na` bare — the scan's allowlist
        # emptied with slab 5 — and the defaults are the TYPE-free prefix rule
        # here because no type is known until detection; #1048 recounts below.)
        # ⚠️ Asked once per DISTINCT value, not once per cell: `is_missing` is a
        # pure function of (text, rules), and the per-cell form was 3.1M calls on
        # the GSS corpus to answer a few hundred distinct questions.
        preview_rules = (missing_rules_by_column or {}).get(header)
        missing_distinct = [v for v in tally if is_missing(v, preview_rules)]
        missing_set = set(missing_distinct)
        substantive_distinct = tuple(v for v in tally if v not in missing_set)
        substantive_cells = sum(tally[v] for v in substantive_distinct)
        substantive = SubstantiveValues.of(substantive_distinct, substantive_cells)
        na_count = non_empty_count - substantive_cells

        # Stats
        sample_values = list(islice(tally, 5))
        unique_count = len(tally)
        empty_percent = (
            round(empty_count / total_rows * 100, PREVIEW_STATS_PRECISION) if total_rows else 0.0
        )
        all_numeric = bool(substantive_distinct) and all(
            _strip_numeric(v) is not None for v in substantive_distinct
        )
        avg_text_length = (
            round(
                sum(len(v) * n for v, n in tally.items()) / non_empty_count,
                PREVIEW_STATS_PRECISION,
            )
            if non_empty_count
            else 0.0
        )

        # #575: the complete sorted distinct code set for a likely scale (all
        # numeric + bounded cardinality), so the wizard's value-labels editor can
        # seed every code, not just the 5 sample_values. Skip continuous measures.
        distinct_numeric_values = None
        if all_numeric and unique_count <= VALUE_LABEL_SEED_MAX_CODES:
            parsed_codes = {_strip_numeric(v) for v in substantive_distinct}
            distinct_numeric_values = sorted(c for c in parsed_codes if c is not None)

        # Parse header
        parsed = parse_header(header)

        # Detect type
        detection = _detect_column_type(header, parsed, substantive, col_idx)

        # 🔴 #1079 (a): detection judged the cells by the PREFIX rule, because no
        # type is known before it — so a free-text column whose answers mostly
        # BEGIN with a non-answer phrase ("Not enough housing", "Unable to
        # trust…") had those answers removed first, and what was left looked
        # like a handful of repeated labels. Measured by the audit: at 50% the
        # column came back NOMINAL with na_count 100 of 200 — imported as
        # categories, and every read then dropped exactly the answers #1048 set
        # out to keep. The same answers beginning "Too little" came back free text.
        # So a column the prefix rule calls closed is asked ONCE MORE under the
        # free-text rule, and taken as free text only if that detection says so.
        # ⚠️ ESCALATION ONLY, never a swap: the prefix rule is right for a closed
        # scale — "Not enough information to say" is an off-scale non-answer on an
        # Agree/Disagree item, and detecting under the whole-answer rule would put
        # it back in the substantive set, where the scale match reports it as an
        # UNMATCHED value (a suspected typo for the researcher to fix) instead of a
        # non-answer. A handful of such phrases cannot make a closed column look
        # like prose; only many DISTINCT answers can, and that is free text.
        # (A `.sav` column with a declaration is judged by it whatever this says —
        # `missing_rules_for` — and its declared values are codes, which cannot
        # make a column look like prose; so no clause excludes it here. One did,
        # and no reachable input could fail it: #941, removed by a mutant.)
        if (
            detection["suggested_type"] != ColumnType.OPEN_TEXT.value
            and missing_distinct
        ):
            free_text_rules = missing_rules_for(None, ColumnType.OPEN_TEXT)
            kept = [v for v in missing_distinct if not is_missing(v, free_text_rules)]
            if kept:
                still_missing = missing_set.difference(kept)
                as_free_text = tuple(v for v in tally if v not in still_missing)
                recheck = _detect_column_type(
                    header, parsed,
                    SubstantiveValues.of(as_free_text, sum(tally[v] for v in as_free_text)),
                    col_idx,
                )
                if recheck["suggested_type"] == ColumnType.OPEN_TEXT.value:
                    detection = recheck

        # #1048: detection above judged cells by the prefix defaults (no type
        # was known yet), which is right for telling categories from text. A
        # column detected as FREE TEXT is imported under the whole-answer
        # defaults instead, so its `na_count` is recounted under them — the
        # number must describe what the import will do with the column.
        # ⚠️ Only the values the prefix rule flagged are re-asked: the free-text
        # rule is strictly NARROWER (`test_free_text_missing.py` holds the two
        # lists to that), so nothing it calls missing can be outside them —
        # and re-asking every distinct answer was part of a 1.3 s slowdown on
        # the BES file that this and `missing_values._NA_FIRST_LETTERS` removed
        # together (measured together, not apportioned).
        judged_by = missing_rules_for(preview_rules, detection["suggested_type"])
        if judged_by is not preview_rules:
            na_count = sum(tally[v] for v in missing_distinct if is_missing(v, judged_by))

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
            "suggested_scale_values": detection["suggested_scale_values"],
            "suggested_scale_unmatched": detection["suggested_scale_unmatched"],
            "distinct_numeric_values": distinct_numeric_values,
            "suggested_column_code": parsed["column_code"],
            "suggested_group_code": parsed["group_code"],
            "suggested_column_text": parsed["column_text"],
            "suggested_column_name": parsed["raw_code"] if _is_name_like(parsed.get("raw_code")) else None,
            "suggested_demographic_subtype": detection.get("suggested_demographic_subtype"),
            "numeric_format": detection["numeric_format"],
            "numeric_min": detection["numeric_min"],
            "numeric_max": detection["numeric_max"],
        })

    return {
        "total_rows": total_rows,
        "columns": columns,
        "overlong_records": records.overlong.as_payload(),
    }


def _scan_source_rows(
    text: str, column_configs: list[dict],
) -> tuple[int, dict, dict, OverlongRecords]:
    """ONE streaming pass over the CSV, for everything the import needs to know
    about the data BEFORE it writes anything (#799).

    Returns ``(row_count, distinct_numeric, na_values, overlong)`` — the last
    the file's too-long records (#985), complete because the pass reads to the
    end.

    ⚠️ **This replaces `data_rows = list(reader)`, and the reason is memory:**
    MEASURED on a real GSS extract (75,699 x 41), that list materialised
    3,103,700 Python `str` objects and took peak RSS from 223 MB to **511 MB** —
    twice the <256 MB backend target, for a file well inside the 50 MB upload
    cap.

    ⚠️ **It is also FASTER, which the naive fix would not have been.** The two
    scans it replaces lived INSIDE the per-column loop, so the row list was
    walked once per qualifying column — 4 numeric columns meant 4 walks. Simply
    swapping the list for a fresh `csv.reader` each time would have re-parsed a
    43 MB string once per column. Accumulating every column's answer in a single
    pass costs one parse total.

    Both predicates come from the CONFIG, not from the database, so this can run
    before any column exists:

    * numeric/percentage columns need their DISTINCT values — `_analyze_numeric`
      takes `list(set(...))`, so a set is what it actually wanted;
    * ordinal columns with scale labels need the set of cells their effective
      missing rule recognises, to seed the auto recode's exclude channel.
    """
    want_numeric: dict[int, list] = {}
    want_na: dict[int, list] = {}
    for cfg in column_configs:
        if cfg.get("skip"):
            continue
        idx = cfg["column_index"]
        qtype = cfg.get("column_type", "")
        # #1048: the rules the column will be JUDGED by — its declaration, or
        # the defaults its type calls for (the prefix rule for both kinds here).
        rules = missing_rules_for(cfg.get("missing_values"), qtype or None)
        if qtype in (ColumnType.NUMERIC.value, ColumnType.PERCENTAGE.value):
            want_numeric[idx] = rules
        if (
            qtype == ColumnType.ORDINAL.value
            and cfg.get("scale_labels")
            and not cfg.get("cells_are_codes")
        ):
            want_na[idx] = rules

    distinct_numeric: dict[int, set] = {i: set() for i in want_numeric}
    na_values: dict[int, set] = {i: set() for i in want_na}

    records = CsvRecords(text)
    row_count = 0
    for row in records:
        row_count += 1
        n = len(row)
        for idx, rules in want_numeric.items():
            if idx < n:
                cell = row[idx].strip()
                if cell and not is_missing(cell, rules):
                    distinct_numeric[idx].add(cell)
        for idx, rules in want_na.items():
            if idx < n:
                cell = row[idx].strip()
                if cell and is_missing(cell, rules):
                    na_values[idx].add(cell)
    return row_count, distinct_numeric, na_values, records.overlong


def import_dataset_csv(
    db: Session,
    project_id: int,
    name: str,
    column_configs: list[dict],
    file_contents: str,
    description: str | None = None,
    source: str | None = None,
    participant_link_column_index: int | None = None,
    overlong: OverlongRecords | None = None,
) -> dict:
    """
    Import a dataset CSV into the database.

    All writes happen in a single transaction — nothing is committed until
    every object has been created successfully.

    Each row gets a system-generated record identifier (R0001, R0002,
    etc.) based on CSV row order.  Participant linking (#414) runs in the
    same transaction when `participant_link_column_index` names an
    identifier column; otherwise it remains a post-import operation via
    the row-link endpoints / retro link-by-column.

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
        overlong: #985 — the too-long records of the file BEFORE a column
            selection narrowed it (`narrow_csv_columns`). The narrowed text is
            exactly as wide as the selection, so its own scan would find none;
            the router passes the original's report and this fills in its rows.

    Returns:
        Summary dict: dataset_id, columns_created, rows_created,
        values_created, recognized_missing_*, participant_link_report
        (None unless linking ran), overlong_records (#985).
    """
    text = _strip_bom(file_contents)
    headers = CsvRecords(text).header
    # #799: ONE streaming pass instead of a retained row list — see
    # `_scan_source_rows`. The list cost 288 MB on a real import and was walked
    # once per qualifying column.
    row_count, distinct_numeric_by_idx, na_values_by_idx, scanned_overlong = (
        _scan_source_rows(text, column_configs)
    )
    if overlong is None:
        overlong = scanned_overlong
    # #803: the cap is enforced on the OPERATION, not only at the wizard. The
    # preview endpoint refuses first and more cheaply, but scripts and direct API
    # callers never pass it — the #589 lesson, restated for size.
    _over = cell_count_error(row_count, len(headers))
    if _over:
        raise DatasetTooLargeError(_over)

    # Build config lookup by column index
    cfg_by_idx: dict[int, dict] = {cfg["column_index"]: cfg for cfg in column_configs}

    # Auto-ID padding: len(str(row_count)) + 2 extra zeros
    pad_width = len(str(row_count)) + 2

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
        # #28: an SPSS import supplies the scale's real codes (possibly 0-based or
        # gapped). Anything else omits them and keeps the positional 1..N encoding.
        scale_values = cfg.get("scale_values")
        if scale_values and len(scale_values) != len(scale_labels or []):
            logger.warning(
                "scale_values/scale_labels length mismatch on column %s (%s vs %s) — "
                "falling back to positional encoding",
                col_idx, len(scale_values), len(scale_labels or []),
            )
            scale_values = None

        # Scale metadata
        scale_labels_json = None
        scale_values_json = None
        scale_pts = None
        # #575: a cells-are-codes column defers ALL scale handling (metadata +
        # recode + substitution) to the apply_value_labels post-pass, so it's
        # created bare here and the cell loop stores the raw numeric code.
        cells_are_codes = bool(cfg.get("cells_are_codes"))
        if qtype == ColumnType.ORDINAL and scale_labels and not cells_are_codes:
            scale_labels_json = json.dumps(scale_labels)
            scale_values_json = json.dumps(
                _coerce_scale_codes(scale_values)
                if scale_values
                else list(range(1, len(scale_labels) + 1))
            )
            scale_pts = len(scale_labels)

        # #592: the column's declared missing rules (config-borne — the wizard
        # in slab 4, .sav in slab 5). None = the recognized-N/A defaults.
        col_missing_rules = cfg.get("missing_values")

        # Numeric metadata (computed from data)
        n_fmt: str | None = None
        n_min: float | None = None
        n_max: float | None = None
        if qtype in (ColumnType.NUMERIC, ColumnType.PERCENTAGE):
            # #799: precomputed in the single scan pass — already DISTINCT,
            # which is what `_analyze_numeric` reduced it to anyway.
            col_vals = distinct_numeric_by_idx.get(col_idx, set())
            # #358: pass the CSV header (not column_text override) so the
            # percentage keyword check uses the original column name.
            col_header = headers[col_idx] if col_idx < len(headers) else None
            info = _analyze_numeric(list(col_vals), header=col_header)
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
            # `is not None` — an explicit [] declaration ("nothing is missing")
            # must persist, never fold into the NULL default (the falsy-zero rule).
            missing_values=(
                json.dumps(col_missing_rules)
                if col_missing_rules is not None else None
            ),
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

        # #575: cells-are-codes columns get their primary scale_map from the
        # apply_value_labels post-pass, not here.
        if qtype_str != ColumnType.ORDINAL.value or not scale_labels or cfg.get("cells_are_codes"):
            continue

        # Build mapping: label -> code. The primary scale_map recode is a SECOND
        # owner of value_numeric — `append_import` re-applies it to new rows, and
        # the recode workbench re-applies it on demand. It must agree with
        # `_compute_value_numeric`, or an SPSS 0-based scale imports as 0..3 and
        # then silently rewrites to 1..4 on the first append (#28).
        scale_values = cfg.get("scale_values")
        if scale_values and len(scale_values) == len(scale_labels):
            codes = _coerce_scale_codes(scale_values)
        else:
            codes = list(range(1, len(scale_labels) + 1))
        mapping = {label: codes[i] for i, label in enumerate(scale_labels)}

        # Pre-scan data rows for missing values (#592: column-aware — the
        # exclude channel seeds FROM the effective rule, §J.2)
        col_missing_rules = cfg.get("missing_values")
        # #799: precomputed in the single scan pass.
        na_values = na_values_by_idx.get(col_idx, set())

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
    # #415: track values recognized as missing (N/A / refusal labels) so the
    # import results screen can disclose the silent missing-handling (#381/#384).
    recognized_missing_count = 0
    recognized_missing_labels: set[str] = set()

    # #796b: BATCHED. This loop used to `db.flush()` once per row and `db.add()`
    # an ORM instance per cell. MEASURED on a real GSS extract (75,699 x 41 =
    # 3,103,659 values): **374.8s**, six minutes for one file and past any
    # timeout a client can reasonably offer. Batching the row flush (75,699
    # round trips -> 38) and inserting values via a Core executemany took it to
    # **76.4s — 4.9x** — with identical row/value counts, record identifiers and
    # uuids.
    #
    # Rows still become ORM objects: there are only tens of thousands, and
    # `DatasetRow` carries a Python-side `uuid` default (the Track J identity
    # spine) that a Core insert would not apply. VALUES go through Core:
    # `DatasetValue` has no defaults and no post-insert consumer in this
    # function, so nothing needs the instances.
    #
    # ⚠️ **This is a SPEED fix and NOT a memory fix — do not read it as one.**
    # Peak RSS was 521 MB before and 533 MB after, and the staged measurement
    # says why: baseline 59 MB -> **223 MB** after openpyxl's workbook read ->
    # **511 MB** after `data_rows = list(reader)` materialises 3.1M Python str
    # objects. The per-cell ORM instances were never the driver. Both real
    # drivers predate this loop and neither is addressed here (see #799); the
    # <256 MB backend target is still exceeded on a file this size.
    #
    # ⚠️ The batch sizes bound what THIS loop adds on top, not the total.
    #
    # ⚠️ **The ORM row insert is deliberately NOT converted to Core, and this is
    # measured rather than assumed.** SQLAlchemy emits one INSERT per row for
    # this mapper even under `add_all` (RETURNING is available and the page size
    # is 1000, so the reason is the mapper, not the dialect). A Core insert with
    # RETURNING is **3.0x** faster on 75,699 rows — but that is 5.7s -> 1.9s
    # against a 76.4s import, **5% of the total**, and it would require spelling
    # `DatasetRow`'s Python-side `uuid` and `created_at` defaults here, where
    # they would silently diverge the day the model changes. Not worth it. The
    # values were the win; the rows are not.
    ROW_BATCH = 2_000
    VALUE_BATCH = 10_000
    pending_values: list[dict] = []

    # #1048: the rules each column's cells are JUDGED by — its declaration, or
    # the defaults its TYPE calls for (whole answers on free text). Resolved
    # once per column; the declaration persisted above stays the raw config.
    judge_rules_by_idx = {
        idx: missing_rules_for(cfg_by_idx.get(idx, {}).get("missing_values"),
                               cfg_by_idx.get(idx, {}).get("column_type") or None)
        for idx in columns
    }
    # #985: the rows the report's named records land on, so a report written
    # after the import can link to them.
    overlong_by_record = {e["record"]: e for e in overlong.examples}

    def _drain_values() -> None:
        if pending_values:
            db.execute(sa_insert(DatasetValue), pending_values)
            pending_values.clear()

    # #799: stream the rows a SECOND time rather than holding them. Two parses
    # of the CSV text total (this and `_scan_source_rows`) replace one parse plus
    # a retained 3.1M-object list — measured at ~0.8s per parse against a ~76s
    # import, i.e. ~1% of the time for 288 MB of memory.
    # `CsvRecords` again — the SAME record rule the scan counted by (#983), so
    # `rows_created` and the rows written cannot disagree.
    source_rows = iter(CsvRecords(text))
    batch_start = 0
    while True:
        batch = list(islice(source_rows, ROW_BATCH))
        if not batch:
            break
        ds_rows = [
            DatasetRow(
                dataset_id=dataset.id,
                participant_id=None,
                # System-generated record identifier — numbering is unchanged
                # from the per-row loop this replaces.
                row_identifier=f"R{str(batch_start + i + 1).zfill(pad_width)}",
                submitted_at=None,
            )
            for i in range(len(batch))
        ]
        db.add_all(ds_rows)
        db.flush()  # ONE flush per batch, not per row — populates ds_row.id

        for i, ds_row in enumerate(ds_rows):
            named = overlong_by_record.get(batch_start + i + 1)
            if named is not None:
                named["row_id"] = ds_row.id

        for ds_row, data_row in zip(ds_rows, batch):
            for col_idx, column in columns.items():
                if col_idx >= len(data_row):
                    continue
                cell = data_row[col_idx].strip()
                if not cell:
                    continue

                cfg = cfg_by_idx.get(col_idx, {})
                col_missing_rules = judge_rules_by_idx[col_idx]

                # #415: recognized-missing accounting. Mirrors the per-column
                # na_count in preview_dataset_csv and the value-keyed compute rule
                # (missing everywhere; #592: column-aware when the config declares).
                # value_text still stores the raw label; value_numeric lands None.
                if is_missing(cell, col_missing_rules):
                    recognized_missing_count += 1
                    if len(recognized_missing_labels) < 25:
                        recognized_missing_labels.add(cell)

                if cfg.get("cells_are_codes"):
                    # #575: the cell IS the numeric code; keep it (value_text stays the
                    # raw code). apply_value_labels substitutes the label + owns the
                    # scale metadata/recode in the post-pass below. Passing scale_labels
                    # to _compute here would route to label→code and NULL a bare code.
                    # #592: a declared-missing code stores NULL, never its number.
                    value_numeric = (
                        None if is_missing(cell, col_missing_rules)
                        else _strip_numeric(cell)
                    )
                else:
                    value_numeric = _compute_value_numeric(
                        cell, cfg.get("column_type", ""), cfg.get("scale_labels"),
                        cfg.get("scale_values"),
                        missing_rules=col_missing_rules,
                    )

                col_type = cfg.get("column_type", "")
                wc = len(cell.split()) if col_type == "open_text" and cell.strip() else None

                # #607: a labelled missing rule substitutes its label into the cell,
                # exactly as the declare endpoint, the append channel, and the .sav
                # adapter do — otherwise the same code renders two ways in one
                # column ("99" here, "Refused" everywhere else) and the append
                # dedup fingerprint misses precisely the rows it exists to match.
                # `recognized_missing_labels` above records the RAW cell (the
                # disclosure lists what the file carried).
                # A plain dict, never an ORM instance: 3.1M `DatasetValue` objects
                # in one identity map is what cost 521 MB (#796b).
                pending_values.append({
                    "row_id": ds_row.id,
                    "column_id": column.id,
                    "value_text": matched_missing_label(cell, col_missing_rules) or cell,
                    "value_numeric": value_numeric,
                    "word_count": wc,
                })
                values_created += 1

            if len(pending_values) >= VALUE_BATCH:
                _drain_values()

        # ⚠️ The record-identifier counter. `range(0, n, ROW_BATCH)` used to
        # advance this; the streaming loop must do it by hand, and a fixture
        # with only ONE batch cannot tell the difference — every batch would
        # restart at R0000001.
        batch_start += len(batch)

    _drain_values()
    db.flush()

    # #897 — every row-creating path asks the same question, and this one is
    # wired even though it is a NO-OP TODAY: an import builds its own dataset,
    # so no `source="manual"` column can exist yet and the call returns at its
    # first query. It is here because the fail-closed AST scan pins the
    # RELATIONSHIP between "constructs a DatasetRow" and "materialises cells"
    # rather than the sites that happen to need it today — and because row 47
    # makes "a dataset that already has hand-made variables" a reachable state.
    # Cost on the 75,699-row import: one SELECT returning nothing.
    materialise_manual_cells(db, dataset.id)

    # -- 3b. Declared value labels (#575) --------------------------------------
    # For each cells-are-codes column, apply the authored code→label dictionary
    # the SAME way the retro path and .sav import do — substitute the label into
    # value_text, keep the code in value_numeric, set scale metadata + a primary
    # scale_map. Reusing apply_value_labels (vs re-implementing inline) keeps
    # undeclared codes numeric and handles nominal, which _compute_value_numeric
    # would silently NULL. Lazy import: value_labels imports from this module.
    value_label_unlabeled: dict[int, list[float]] = {}
    codes_columns = [
        (idx, col) for idx, col in columns.items()
        if cfg_by_idx.get(idx, {}).get("cells_are_codes")
    ]
    if codes_columns:
        from .value_labels import apply_value_labels

        for col_idx, column in codes_columns:
            cfg = cfg_by_idx.get(col_idx, {})
            labels = cfg.get("scale_labels")
            values = cfg.get("scale_values")
            if not labels or not values or len(labels) != len(values):
                logger.warning(
                    "cells_are_codes column %s missing/mismatched labels/values — "
                    "skipping value-label substitution", col_idx,
                )
                continue
            pairs = [(float(code), label) for code, label in zip(values, labels)]
            result = apply_value_labels(db, column, pairs, target_type=column.column_type)
            if result["unlabeled_codes"]:
                value_label_unlabeled[col_idx] = result["unlabeled_codes"]

    # -- 4. Participant linking (#414, DEC-6) ------------------------------------
    # `is not None` is load-bearing: column index 0 is a valid link column.
    participant_link_report = None
    if participant_link_column_index is not None:
        link_col = columns.get(participant_link_column_index)
        if link_col is None or link_col.column_type != ColumnType.IDENTIFIER:
            raise ValueError(
                "participant_link_column_index must reference a non-skipped identifier column"
            )
        # Function-level import: participant_linking imports _is_na from this
        # module at top level, so the reverse edge must stay lazy.
        from .participant_linking import link_rows_by_identifier_column

        participant_link_report = link_rows_by_identifier_column(
            db,
            project_id=project_id,
            dataset_id=dataset.id,
            column_id=link_col.id,
        )

    return {
        "dataset_id": dataset.id,
        "columns_created": len(columns),
        "rows_created": row_count,
        "values_created": values_created,
        "recognized_missing_count": recognized_missing_count,
        "recognized_missing_labels": sorted(recognized_missing_labels),
        "participant_link_report": participant_link_report,
        "value_label_unlabeled": value_label_unlabeled,
        "overlong_records": overlong.as_payload(),
    }
