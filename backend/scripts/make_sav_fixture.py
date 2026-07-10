"""Regenerate the SPSS test fixture at ``tests/reference_data/spss_sample.sav``.

Dev-only. Writing a .sav needs a DataFrame, so this imports pandas — which is
deliberately NOT a backend dependency (see ``services/sav_import.py``, which
reads with ``output_format="dict"`` precisely to avoid it). The fixture is
committed as a binary so the test suite never needs pandas.

    cd backend && source venv/bin/activate
    pip install pandas pyreadstat      # dev-only, not in requirements
    python scripts/make_sav_fixture.py

The fixture deliberately exercises every branch of the adapter:

* ``pid``       — string identifier, one value blank (system-missing)
* ``gender``    — nominal + value labels (labels must NOT imply an order)
* ``satisfied`` — ordinal + a 5-point label map + code 9 declared user-missing
                  ("Refused" must never become a 6th scale point)
* ``support``   — ordinal + a ZERO-BASED 0..3 label map (proves value_numeric
                  preserves SPSS codes rather than renumbering 1..N)
* ``score``     — measure='scale', continuous, one system-missing cell
* ``joined``    — a date, to pin the ISO stringification
"""

import datetime as dt
from pathlib import Path

import pandas as pd
import pyreadstat

_REFERENCE_DATA = Path(__file__).resolve().parent.parent / "tests" / "reference_data"
DEST = _REFERENCE_DATA / "spss_sample.sav"
DEST_PARTIAL = _REFERENCE_DATA / "spss_partial_labels.sav"
DEST_EDGE = _REFERENCE_DATA / "spss_edge_cases.sav"


def make_partial_labels() -> None:
    """Fixture for #536 — ordinals whose labels don't cover the observed codes.

    * ``stress`` — endpoint-anchored (labels on 1 and 7 only; the ubiquitous
      SPSS pattern) → must promote at FULL width with synthesized interior points
    * ``agree``  — fully-labelled 1..5 but the data carries a non-integer 2.5
      and an undeclared 9 → both stay strays, and the #364 warning must surface
    * ``slider`` — 1="Low"/100="High": a continuous variable wearing two labels
      → must demote (no promotion, raw numbers throughout, no mixed cells)
    * ``mood``   — endpoint-anchored AND code 99 declared user-missing → 99 is
      missing, not a stray; the synthesized scale must not absorb it
    """
    df = pd.DataFrame(
        {
            "stress": [1, 2, 3, 4, 5, 6, 7, 4],
            "agree": [1, 2, 3, 4, 5, 9, 2.5, 1],
            "slider": [1, 10, 25, 40, 55, 70, 85, 100],
            "mood": [1, 3, 99, 7, 2, 5, 6, 4],
        }
    )

    pyreadstat.write_sav(
        df,
        str(DEST_PARTIAL),
        column_labels={"stress": "How stressed were you this week?"},
        variable_value_labels={
            "stress": {1: "Not at all", 7: "Extremely"},
            "agree": {
                1: "Strongly disagree",
                2: "Disagree",
                3: "Neutral",
                4: "Agree",
                5: "Strongly agree",
            },
            "slider": {1: "Low", 100: "High"},
            "mood": {1: "Bad", 7: "Good"},
        },
        variable_measure={
            "stress": "ordinal",
            "agree": "ordinal",
            "slider": "ordinal",
            "mood": "ordinal",
        },
        missing_ranges={"mood": [{"lo": 99, "hi": 99}]},
    )
    print(f"wrote {DEST_PARTIAL} ({DEST_PARTIAL.stat().st_size} bytes)")


def make_edge_cases() -> None:
    """Fixture for #541 — duplicate value labels + string user-missing values.

    * ``flavor`` — ordinal whose label map duplicates one string across two
      codes (legal in SPSS, usually a copy-paste typo) → the codes must stay
      distinguishable after import (suffix disambiguation), never collapse
      last-wins
    * ``region`` — string variable with two declared discrete missing values
      ("XX", "SKIP" — pyreadstat reports them as lo==hi string dicts) → they
      import as MISSING, not as data
    """
    df = pd.DataFrame(
        {
            "flavor": [1, 2, 3, 4, 1, 2],
            "region": ["North", "South", "XX", "East", "SKIP", "West"],
        }
    )

    pyreadstat.write_sav(
        df,
        str(DEST_EDGE),
        variable_value_labels={
            "flavor": {1: "Agree", 2: "Agree", 3: "Neutral", 4: "Disagree"},
        },
        variable_measure={"flavor": "ordinal", "region": "nominal"},
        missing_ranges={"region": ["XX", "SKIP"]},
    )
    print(f"wrote {DEST_EDGE} ({DEST_EDGE.stat().st_size} bytes)")


def main() -> None:
    df = pd.DataFrame(
        {
            "pid": ["P001", "P002", "P003", ""],
            "gender": [1, 2, 2, 1],
            "satisfied": [5, 1, 9, 3],  # 9 = Refused (declared user-missing)
            "support": [0, 3, 1, 2],  # zero-based scale
            "score": [88.0, 71.5, float("nan"), 60.0],
            "joined": [
                dt.date(2026, 7, 9),
                dt.date(2020, 1, 1),
                dt.date(2024, 12, 31),
                None,
            ],
        }
    )

    pyreadstat.write_sav(
        df,
        str(DEST),
        column_labels={"satisfied": "Overall, I am satisfied with the program"},
        variable_value_labels={
            "gender": {1: "Male", 2: "Female"},
            "satisfied": {
                1: "Strongly disagree",
                2: "Disagree",
                3: "Neutral",
                4: "Agree",
                5: "Strongly agree",
                9: "Refused",
            },
            "support": {0: "None", 1: "A little", 2: "Some", 3: "A lot"},
        },
        variable_measure={
            "pid": "nominal",
            "gender": "nominal",
            "satisfied": "ordinal",
            "support": "ordinal",
            "score": "scale",
            "joined": "scale",
        },
        missing_ranges={"satisfied": [{"lo": 9, "hi": 9}]},
    )
    print(f"wrote {DEST} ({DEST.stat().st_size} bytes)")
    make_partial_labels()
    make_edge_cases()


if __name__ == "__main__":
    main()
