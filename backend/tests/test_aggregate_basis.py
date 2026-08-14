"""#693 — a domain aggregate declares what it is, and what its `n` pools.

The arithmetic is an unweighted mean of per-column means with no
standardisation of any kind, and the `valid_n` beside it is the SUM of the
items' respondent counts. Both facts were true and invisible: the R export
emitted an honest comment block, and the app said nothing on the screen where
the score is created or the one where it is read.

Nothing here changes a computed VALUE. What is pinned is that the result
carries enough to describe itself, and that the description cannot silently
drift from what the client says.
"""
import re
from pathlib import Path

from app.services.metrics import (
    AGGREGATION_BASIS_UNWEIGHTED_ITEM_MEANS,
    ResolvedRow,
    compute_domain_aggregate,
)

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "aggregate-basis.ts"


def _rows(values):
    return [ResolvedRow(row_id=i, value_numeric=float(v), value_text=str(v))
            for i, v in enumerate(values)]


def _groups(*value_lists):
    """One ungrouped bucket per column — the shape a domain aggregate reads."""
    return {i + 1: {None: _rows(vals)} for i, vals in enumerate(value_lists)}


class TestTheAggregateDescribesItself:

    def test_result_names_its_aggregation_basis(self):
        rd, _valid, _total = compute_domain_aggregate(_groups([1, 2, 3], [4, 5, 6]), {})
        assert rd["aggregation_basis"] == AGGREGATION_BASIS_UNWEIGHTED_ITEM_MEANS

    def test_the_dangerous_case_is_reproduced_and_now_describable(self):
        """A big item and a tiny one, which is the whole argument.

        1000 responses averaging 2.0 and 10 averaging 8.0 aggregate to 5.0 —
        equidistant from both — while a respondent-weighted estimate is ≈2.06.
        The value is unchanged by this issue; what changes is that the payload
        now carries the item count and the per-item spread, so the screen can
        stop presenting 1010 as a respondent count.
        """
        rd, valid_n, _total = compute_domain_aggregate(
            _groups([2.0] * 1000, [8.0] * 10), {},
        )
        assert rd["aggregate_value"] == 5.0
        assert valid_n == 1010                    # the misleading number, unchanged
        assert rd["member_count"] == 2
        assert rd["member_n_min"] == 10
        assert rd["member_n_max"] == 1000

    def test_member_n_counts_only_columns_that_reached_the_average(self):
        """A column contributing no scalar must not widen the range.

        `member_n_*` describes the items the aggregate is a mean OF. An
        all-missing column has a `valid_n` of 0 and no mean, so counting it
        would report `n 0–1000` for an average taken over one item.
        """
        empty = ResolvedRow(row_id=99, value_numeric=None, value_text=None, missing=True)
        groups = _groups([4.0] * 5)
        groups[2] = {None: [empty]}
        rd, _valid, _total = compute_domain_aggregate(groups, {})
        assert rd["member_count"] == 1
        assert rd["member_n_min"] == 5
        assert rd["member_n_max"] == 5

    def test_an_empty_aggregate_reports_no_range_rather_than_zero(self):
        """None, not 0 — so no consumer can render "n 0–0" for an empty scale."""
        empty = ResolvedRow(row_id=1, value_numeric=None, value_text=None, missing=True)
        rd, _valid, _total = compute_domain_aggregate({1: {None: [empty]}}, {})
        assert rd["aggregate_value"] is None
        assert rd["member_count"] == 0
        assert rd["member_n_min"] is None
        assert rd["member_n_max"] is None


class TestCrossLanguageContract:
    """The constant is hand-mirrored in TypeScript, so drift has to fail here.

    `lib/aggregate-basis.ts` compares against a literal of its own. There is no
    codegen between them: without this, each suite would validate only its own
    half and a renamed basis would silently stop matching — the client would go
    quiet exactly where it is supposed to speak, and every test would stay
    green. Same shape as `test_startup_fatal.py::TestCrossLanguageContract`.
    """

    def test_the_typescript_mirror_uses_the_same_value(self):
        src = FRONTEND.read_text(encoding="utf-8")
        m = re.search(r"UNWEIGHTED_ITEM_MEANS\s*=\s*'([^']+)'", src)
        assert m, f"could not find the mirrored constant in {FRONTEND}"
        assert m.group(1) == AGGREGATION_BASIS_UNWEIGHTED_ITEM_MEANS, (
            "services/metrics.py and lib/aggregate-basis.ts disagree about the "
            "aggregation basis — the client will stop labelling the score."
        )
