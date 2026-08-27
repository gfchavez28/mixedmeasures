"""A Data Quality toggle governs the tool's INFERENCES, never a declaration (#819).

**Measured on the GSS corpus.** Declare missing values on a column (42.6% of
`trust`), then untick *"Count 'Don't know' / 'N/A' as missing"*. The panel read,
verbatim:

    "No missing data detected — All 227097 values are present across 3 variables."

with `N Valid 75,699 / N Missing 0 / 0.0%` — **while the same row still printed
`N NA = 32,276`**. One click from a screen a researcher could paste into a
methods section.

**The mechanism was a single class doing three jobs.** `_classify_value`
returned `"na"` for a value matched by the recognized-N/A DEFAULTS, for one the
researcher had DECLARED on that column, and for a numeric cell analysis cannot
use (#595) — and `_is_missing` let one checkbox discard all three. The checkbox
names only the first, which is the only one that is the tool's own guess.

⚠️ **This is a two-sided property and needs both fixtures** (the #592 REPLACE
rule): the declared value must survive the toggle AND the inferred default must
still obey it. A one-sided test passes against "the toggle was deleted", which
would be a different defect wearing this fix's clothes.
"""

import json

import pytest

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.services.data_quality import compute_missing_summary

PID = 8190


def _seed(db, pid, *, column_type, missing_values, cells):
    """One project per fixture — the last test asks for BOTH at once."""
    db.add(Project(id=pid, name=f"DQ{pid}", user_id=1))
    db.flush()
    db.add(Dataset(id=pid, project_id=pid, name="D"))
    db.flush()
    db.add(DatasetColumn(id=pid, dataset_id=pid, column_code="q", column_name="q",
                         column_text="q", column_type=column_type,
                         missing_values=missing_values,
                         sequence_order=0, display_order=0))
    db.flush()
    for i, (text, num) in enumerate(cells):
        db.add(DatasetRow(id=pid * 100 + i, dataset_id=pid, row_identifier=f"R{i}"))
        db.flush()
        db.add(DatasetValue(row_id=pid * 100 + i, column_id=pid, value_text=text, value_numeric=num))
    db.flush()
    return pid


def _summary(db, pid, include_na):
    out = compute_missing_summary(db, pid, [pid], include_na=include_na, include_empty=True)
    return out["variables"][0], out


@pytest.fixture
def declared(db_session):
    """3 of 12 cells DECLARED missing — the state the toggle used to discard."""
    return db_session, _seed(
        db_session, PID,
        column_type=ColumnType.NUMERIC,
        missing_values=json.dumps([{"value": "99", "label": "Refused"}]),
        cells=[("Refused", None)] * 3 + [(str(50 + i), float(50 + i)) for i in range(9)],
    )


@pytest.fixture
def inferred(db_session):
    """4 of 10 cells matched by the DEFAULTS on an UNDECLARED column — the
    toggle's actual subject, and the positive control for it."""
    return db_session, _seed(
        db_session, PID + 1,
        column_type=ColumnType.NOMINAL,
        missing_values=None,
        cells=[("N/A", None)] * 4 + [("Yes", None)] * 6,
    )


class TestADeclarationIsNotADisplayOption:
    def test_declared_missing_values_survive_the_toggle(self, declared):
        on, _ = _summary(*declared, True)
        off, _ = _summary(*declared, False)
        assert on["n_missing"] == 3
        assert off["n_missing"] == 3, (
            "unticking a checkbox about auto-detected 'N/A' answers must not "
            "discard values the researcher declared missing on this column"
        )

    def test_the_headline_can_no_longer_contradict_the_row(self, declared):
        """`total_missing == 0` is what the "No missing data detected" banner
        keys on; with declared cells present it must never reach zero."""
        for include_na in (True, False):
            variable, whole = _summary(*declared, include_na)
            assert variable["n_na"] == 3
            assert whole["total_missing"] > 0, (
                "the banner fires on total_missing == 0 while the row prints n_na=3"
            )

    def test_n_na_still_counts_every_flavour(self, declared):
        # The payload field keeps its meaning across the class split.
        off, _ = _summary(*declared, False)
        assert off["n_na"] == 3


class TestTheToggleStillDoesItsJob:
    def test_auto_detected_na_still_obeys_the_toggle(self, inferred):
        """The positive control. A fix that made everything always-missing would
        pass every assertion in the class above and silently delete a feature."""
        on, _ = _summary(*inferred, True)
        off, _ = _summary(*inferred, False)
        assert on["n_missing"] == 4
        assert off["n_missing"] == 0
        assert off["n_na"] == 4, "the count is still reported, only not counted as missing"

    def test_the_two_fixtures_differ_on_the_axis_the_fix_generalises(self, declared, inferred):
        """The discrimination assertion: same toggle, opposite outcomes. Without
        this, a fixture where both behave alike would certify nothing."""
        declared_off, _ = _summary(*declared, False)
        inferred_off, _ = _summary(*inferred, False)
        assert declared_off["n_missing"] > 0
        assert inferred_off["n_missing"] == 0
