"""The comparison row's Q–Q plot diagnoses the model its tests fit (#1549 (b)).

Since #1329 (D51) a group with one value is listed and left out of the F, Tukey,
the Welch t and Levene (`testable_groups.split_testable`). The Q–Q plot beside
them still pooled that group's residual — exactly 0 by construction — so it drew
a model nobody tested. Now it asks the same function at the parametric minimum and
names the groups it left out (`singleton_groups`).

Entered at the pipeline's MOUTH (`compute_group_comparison(include_qq=True)`, the
#747 rule), on #1329's own fixture: A(6), B(5), C(1).
"""

import pytest

from app.services.comparisons import compute_group_comparison
from app.services.qq_plot import qq_summary
from tests.test_one_value_groups_1329 import A, B, GRP, PID, Y, _seed


def _row(db, nonparametric=False):
    out = compute_group_comparison(
        db, project_id=PID, column_ids=[Y], domain_ids=[], grouping_column_id=GRP,
        grouping_column_id_2=None, test_type="auto", include_effect_size_ci=False,
        nonparametric=nonparametric, include_qq=True,
    )
    return out["rows"][0]


def test_the_plot_leaves_out_the_group_the_F_leaves_out(db_session):
    _seed(db_session)
    row = _row(db_session)
    assert row["untested_groups"] == ["C"]
    assert row["qq"]["singleton_groups"] == ["C"]
    assert row["qq"]["n"] == len(A) + len(B)  # 11 — C's structural zero is not drawn


def test_the_plot_is_the_plot_of_the_tested_groups_alone(db_session):
    """DISCRIMINATES: with C's zero residual pooled in, the straightness differs."""
    _seed(db_session)
    qq = _row(db_session)["qq"]
    alone = qq_summary({"A": A, "B": B})
    assert qq["ppcc"] == pytest.approx(alone["ppcc"])
    assert qq["line_slope"] == pytest.approx(alone["line_slope"])
    # …and the fixture could have told them apart: the old plot's straightness.
    from scipy.stats import norm

    from app.services.qq_plot import _ppcc, plotting_positions

    with_zero = sorted([v - sum(A) / len(A) for v in A] + [v - sum(B) / len(B) for v in B] + [0.0])
    old = _ppcc([float(norm.ppf(p)) for p in plotting_positions(len(with_zero))], with_zero)
    assert abs(old - qq["ppcc"]) > 1e-4


def test_under_the_rank_test_the_plot_still_names_it(db_session):
    """The rank test uses C (one value is ranked), so the row names nobody; the plot
    is about the PARAMETRIC model's assumption and must say on its own whom it left out."""
    _seed(db_session)
    row = _row(db_session, nonparametric=True)
    assert row["untested_groups"] == []
    assert row["qq"]["singleton_groups"] == ["C"]


def test_the_wire_schema_carries_the_names(db_session):
    from app.schemas.comparison import QQSummary

    _seed(db_session)
    qq = QQSummary.model_validate(_row(db_session)["qq"])
    assert qq.singleton_groups == ["C"]
