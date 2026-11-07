"""The app takes R's Mann–Whitney rule and says which method it used (#1326 STAT-12, D58).

1.5.9's session A (record: the git-ignored
the internal design notes). scipy's
`method='auto'` goes exact only at 8 or fewer, so on the review's tie-free
10 v 10 data the app printed the normal approximation's .037635 where R's
`wilcox.test` — and jamovi and JASP, which call it — print the exact .035463.
Now the app takes R's rule (exact when both groups are under 50 and nothing is
tied; else the tie-corrected normal approximation with a continuity correction)
and states it as `p_method`, the FIFTEENTH stated-basis member.

⚠️ scipy's `method='exact'` IGNORES ties silently (measured, 1.18.0: [1,2,2,3]
v [2,3,4,4] gives .2 exact against .134 asymptotic), so the tie test is the
app's own and this file pins both sides of it.
"""

import csv
import io
import re
from pathlib import Path

import pytest
from scipy.stats import mannwhitneyu

from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.project import Project
from app.services import comparisons
from app.services.comparisons import (
    MANN_WHITNEY_EXACT_MAX_N,
    P_METHOD_CSV_LABEL,
    P_METHOD_EXACT,
    P_METHOD_NORMAL_APPROXIMATION,
    _run_test,
    mann_whitney_p_method,
)

TS_MIRROR = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "p-method.ts"

X = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
Y = [6, 10, 12, 14, 16, 18, 20, 21, 22, 23]


def _mw(x, y):
    result, reason = _run_test({"x": x, "y": y}, ["x", "y"], "mann_whitney_u", False,
                               nonparametric=True)
    assert reason is None
    return result


class TestTheRule:
    def test_tie_free_and_small_is_exact_and_matches_R(self):
        t = _mw(X, Y)
        assert t["p_method"] == P_METHOD_EXACT
        assert t["p"] == pytest.approx(0.035463, abs=1e-6)   # R 4.3.3, the review
        # Discrimination: the p the app printed before (scipy's auto).
        assert t["p"] != pytest.approx(0.037635, abs=1e-6)

    def test_a_tie_anywhere_in_the_combined_sample_is_the_approximation(self):
        x, y = [1, 2, 3, 4, 5], [5, 6, 7, 8, 9]          # 5 in both groups
        assert mann_whitney_p_method(x, y) == P_METHOD_NORMAL_APPROXIMATION
        t = _mw(x, y)
        assert t["p_method"] == P_METHOD_NORMAL_APPROXIMATION
        assert t["p"] == pytest.approx(
            round(float(mannwhitneyu(x, y, method="asymptotic").pvalue), 6))
        # scipy's exact would have IGNORED the tie — the trap the rule exists for.
        assert t["p"] != pytest.approx(
            round(float(mannwhitneyu(x, y, method="exact").pvalue), 6))

    def test_a_tie_within_one_group_counts_too(self):
        assert mann_whitney_p_method([1, 1, 2], [3, 4, 5]) == P_METHOD_NORMAL_APPROXIMATION

    def test_the_size_boundary_straddles_R(self):
        """R: exact iff n.x < 50 and n.y < 50 — 49 is exact, 50 is not."""
        assert MANN_WHITNEY_EXACT_MAX_N == 50
        small = [float(i) for i in range(49)]
        big = [float(i) for i in range(50)]
        other = [i + 0.5 for i in range(200, 210)]
        assert mann_whitney_p_method(small, other) == P_METHOD_EXACT
        assert mann_whitney_p_method(big, other) == P_METHOD_NORMAL_APPROXIMATION
        assert mann_whitney_p_method(other, big) == P_METHOD_NORMAL_APPROXIMATION
        assert _mw(big, other)["p_method"] == P_METHOD_NORMAL_APPROXIMATION

    def test_only_mann_whitney_states_a_method(self):
        kw, _ = _run_test({"a": X, "b": Y, "c": [2, 4]}, ["a", "b", "c"], "kruskal_wallis",
                          False, nonparametric=True)
        assert "p_method" not in kw


class TestCrossLanguageContract:
    """The constants are hand-mirrored in `lib/p-method.ts` (no codegen)."""

    def _ts(self):
        return TS_MIRROR.read_text(encoding="utf-8")

    def test_every_python_value_is_the_mirrors(self):
        ts = self._ts()
        mirrored = dict(re.findall(r"export const (P_METHOD_\w+) = '([^']+)'", ts))
        python = {name: getattr(comparisons, name) for name in dir(comparisons)
                  if re.fullmatch(r"P_METHOD_[A-Z_]+", name)
                  and isinstance(getattr(comparisons, name), str)}
        assert mirrored == python
        assert len(mirrored) >= 2, "population: the scan must find the members"

    def test_a_new_variant_is_a_compile_error_on_the_client(self):
        assert "satisfies Record<PMethod, PMethodDescriptor>" in self._ts()

    def test_the_csv_names_every_method_in_words(self):
        assert set(P_METHOD_CSV_LABEL) == {P_METHOD_EXACT, P_METHOD_NORMAL_APPROXIMATION}
        assert all(label and "_" not in label for label in P_METHOD_CSV_LABEL.values())


PID = 13260
VAL, SIDE = 132601, 132602


def _seed(db):
    db.add(Project(id=PID, name="MW", user_id=1))
    db.flush()
    db.add(Dataset(id=PID, project_id=PID, name="d"))
    db.flush()
    db.add(DatasetColumn(id=VAL, dataset_id=PID, column_code="v", column_name="v",
                         column_text="v", column_type=ColumnType.NUMERIC,
                         sequence_order=0, display_order=0))
    db.add(DatasetColumn(id=SIDE, dataset_id=PID, column_code="side", column_name="side",
                         column_text="side", column_type=ColumnType.NOMINAL,
                         sequence_order=1, display_order=1))
    db.flush()
    vid = 0
    for r, (v, g) in enumerate([(v, "x") for v in X] + [(v, "y") for v in Y]):
        db.add(DatasetRow(id=PID * 100 + r, dataset_id=PID))
        db.flush()
        for cid, text, num in ((VAL, str(v), float(v)), (SIDE, g, None)):
            vid += 1
            db.add(DatasetValue(id=PID * 1000 + vid, row_id=PID * 100 + r, column_id=cid,
                                value_text=text, value_numeric=num))
    db.flush()


def test_the_csv_carries_the_method_beside_the_p(db_session):
    import asyncio

    from app.models.user import User
    from app.routers.comparisons import group_comparison_csv

    _seed(db_session)
    user = db_session.get(User, 1)
    resp = asyncio.run(group_comparison_csv(
        project_id=PID, column_ids=str(VAL), domain_ids=None, grouping_column_id=SIDE,
        grouping_column_id_2=None, test_type="auto", exclude_groups=None,
        nonparametric=True, user=user, db=db_session,
    ))

    async def body():
        return b"".join([c if isinstance(c, bytes) else c.encode()
                         async for c in resp.body_iterator])

    rows = list(csv.reader(io.StringIO(asyncio.run(body()).decode())))
    header = rows[1]
    assert "p method" in header
    assert header.index("p method") == header.index("p") + 1
    assert rows[2][header.index("p method")] == P_METHOD_CSV_LABEL[P_METHOD_EXACT]
