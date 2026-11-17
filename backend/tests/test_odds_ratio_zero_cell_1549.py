"""#1549 (a) — the comparison's effect size: a real 0 is a value, an odds ratio of 0
or infinity is not, and either way the payload says which.

The filing: `[1,1,1]` of `[2,2,2]` gives Cramér's V = 0.0 and the table showed "–";
`[0,3]` of `[4,4]` gave OR = 0.0 (shown "–"); `[3,0]` of `[3,4]` gave `None` with no
reason. The two odds-ratio cases are ONE fact — a zero count in the 2×2 table —
read in two directions: swapping the groups turns the first into an infinity.
So both are `None` with `zero_cell`, and V's 0 is shown (the client half).

The reason is read as a STRING, so on the unfixed code these FAIL rather than
erroring at import (the house rule `test_comparison_unit_1323.py` states).
"""
import pytest

from app.schemas import code_analysis as schemas
from app.services import comparison_basis as cb
from app.services import undefined_stats as us
from tests.test_comparison_unit_1323 import X, _Builder, _cmp, _code


def test_cramers_v_of_zero_is_a_value():
    t = cb.presence_test([1, 1, 1], [2, 2, 2])
    assert t["effect_size_label"] == "cramers_v"
    assert t["effect_size"] == 0.0   # the server was right; the table hid it
    assert t.get("effect_size_undefined_reason") is None


@pytest.mark.parametrize("successes,sizes", [
    ([0, 3], [4, 4]),   # nobody in the first group used it: OR would be 0
    ([3, 0], [3, 4]),   # everybody in the first group, nobody in the second: infinity
    ([4, 1], [4, 4]),   # everybody in the first group: infinity
    ([2, 4], [4, 4]),   # everybody in the second group: 0
])
def test_a_zero_cell_has_no_odds_ratio_and_says_why(successes, sizes):
    t = cb.presence_test(successes, sizes)
    assert t["p_value"] is not None, "Fisher's p needs no odds ratio: the test stands"
    assert t["effect_size"] is None
    assert t["effect_size_label"] == "odds_ratio"
    assert t["effect_size_undefined_reason"] == "zero_cell"


def test_the_two_directions_are_the_same_answer():
    one_way = cb.presence_test([0, 3], [4, 4])
    other_way = cb.presence_test([3, 0], [4, 4])
    assert one_way["p_value"] == other_way["p_value"]
    for key in ("effect_size", "effect_size_label", "effect_size_undefined_reason"):
        assert one_way[key] == other_way[key]


def test_an_ordinary_table_keeps_its_odds_ratio():
    """The positive control: no zero cell, the sample odds ratio ad/bc."""
    t = cb.presence_test([3, 1], [4, 5])   # a=3 b=1 c=1 d=4
    assert t["effect_size"] == pytest.approx(12.0)
    assert t.get("effect_size_undefined_reason") is None


def test_the_reason_is_in_the_vocabulary_and_on_the_wire():
    assert getattr(us, "ZERO_CELL", None) == "zero_cell"
    assert "zero_cell" in us.UNDEFINED_REASONS
    assert "effect_size_undefined_reason" in schemas.StatTestResult.model_fields


def test_the_comparison_carries_the_reason(db_session):
    """Through `get_demographic_comparison` (the pipeline's mouth)."""
    b = _Builder(db_session)
    for pid in range(1, 5):
        b.person(pid, "Board", 1)                                # nobody used X
    for pid in range(5, 9):
        b.person(pid, "Staff", 1, {X: 1 if pid <= 7 else 0})     # three of four did
    t = _code(_cmp(b), "X")["test"]
    assert t["effect_size"] is None
    assert t["effect_size_label"] == "odds_ratio"
    assert t["effect_size_undefined_reason"] == "zero_cell"
    schemas.StatTestResult.model_validate(t)
