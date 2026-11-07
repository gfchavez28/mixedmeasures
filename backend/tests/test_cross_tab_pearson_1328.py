"""A cross-tab's χ² is Pearson's, uncorrected, and V comes from it (#1328, D49).

1.5.9's session A (record: the git-ignored
the internal design notes). scipy's
`chi2_contingency` applies Yates's continuity correction by default exactly when
df = 1 — every 2×2 submatrix — and the app's Cramér's V came from that corrected
statistic, which no package or source computes. The review's table [12 5; 6 11]
executed: Yates χ² 2.9514 / p .0858 / V .2946; Pearson 4.25 / .0393 / .3536;
Fisher .0844 (unchanged). Larger tables were never corrected, so they cannot move.
"""

import pytest
from scipy.stats import chi2_contingency

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.services.cross_tabulation import compute_cross_tabulation

PID = 13280
ROW, COL, ROW3 = 132801, 132802, 132803


def _seed(db, cells: dict[tuple[str, str], int], row_values=("Yes", "No")):
    db.add(Project(id=PID, name="Yates", user_id=1))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="d"))
    db.flush()
    for i, (cid, name) in enumerate([(ROW, "row"), (COL, "col")]):
        db.add(DatasetColumn(id=cid, dataset_id=PID, column_code=name, column_name=name,
                             column_text=name, column_type=ColumnType.NOMINAL,
                             sequence_order=i, display_order=i))
    db.flush()
    r = vid = 0
    for (rv, cv), count in cells.items():
        for _ in range(count):
            r += 1
            db.add(DatasetRow(id=PID * 100 + r, dataset_id=PID))
            db.flush()
            for cid, text in ((ROW, rv), (COL, cv)):
                vid += 1
                db.add(DatasetValue(id=PID * 1000 + vid, row_id=PID * 100 + r,
                                    column_id=cid, value_text=text))
    db.flush()


def test_the_filed_2x2_is_pearsons_and_V_comes_from_it(db_session):
    _seed(db_session, {("Yes", "Left"): 12, ("Yes", "Right"): 5,
                       ("No", "Left"): 6, ("No", "Right"): 11})
    chi = compute_cross_tabulation(db_session, PID, ROW, COL)["chi_square"]
    assert chi["statistic"] == pytest.approx(4.25, abs=1e-3)
    assert chi["p_value"] == pytest.approx(0.0393, abs=1e-4)
    assert chi["cramers_v"] == pytest.approx(0.354, abs=1e-3)
    assert chi["fisher_exact_p"] == pytest.approx(0.0844, abs=1e-4)
    # Discrimination: the corrected statistic the app printed before.
    assert chi["statistic"] != pytest.approx(2.9514, abs=1e-2)


def test_a_larger_table_never_had_a_correction_so_it_does_not_move(db_session):
    cells = {("Yes", "Left"): 9, ("Yes", "Mid"): 4, ("Yes", "Right"): 3,
             ("No", "Left"): 2, ("No", "Mid"): 6, ("No", "Right"): 8}
    _seed(db_session, cells)
    chi = compute_cross_tabulation(db_session, PID, ROW, COL)["chi_square"]
    table = [[9, 4, 3], [2, 6, 8]]
    # scipy's DEFAULT call (correction=True) — identical above df = 1.
    assert chi["statistic"] == pytest.approx(round(chi2_contingency(table)[0], 3))
    assert chi["df"] == 2
