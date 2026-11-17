"""#1548 (c) — the exact Freeman–Halton test decides to count from the MARGINS.

The external v1.6.0 code review's N4: `_freeman_halton` compared one step's UNPRUNED
outer product with the 200,000-table cap before that step's prune, so 5 groups of
18–19 (N = 92) fell to the seeded Monte Carlo estimate although only tens of
thousands of tables have those margins. A Monte Carlo p cannot go below 1e-4 and
carries no support, so discrete Holm treats it as continuous and the code gets no
"can it reach significance" marker. Now `_freeman_halton_counts` counts the tables
and the work from the margins before anything is built.

Every oracle here is INDEPENDENT of the code under test: a pure-Python recursive
enumeration with `math.comb` (no numpy, no pruning order, no chunks), itertools for
the counts, and R's `fisher.test` where R is present.
"""
import itertools
import math
import random
import subprocess

import pytest

from app.services import comparison_basis as cb
from tests import r_support
from tests.test_comparison_unit_1323 import PID, X, _Builder, _cmp, _code

#: The review's shape: five groups of 18–19 participants.
SIZES = [18, 18, 18, 19, 19]
SUCC = [2, 5, 9, 12, 14]
#: R 4.3.3, `fisher.test(matrix(c(2,16,5,13,9,9,12,7,14,5), ncol=2, byrow=TRUE),
#: workspace=2e8)$p.value` — run 2026-11-12 (the R-gated test below re-runs it).
R_P = 0.000437269885331


def _oracle(successes, sizes):
    """``(p, support, tables)`` by plain recursion over every table with these margins,
    in EXACT integer arithmetic: a table's weight is ``prod C(n_i, x_i)`` (an int), so
    "no more probable" needs no float tolerance, and each attainable p is the sum of
    every weight at or below that table's, over ``C(N, X)``."""
    from collections import Counter

    x_total, n_total = sum(successes), sum(sizes)
    norm = math.comb(n_total, x_total)
    weights = Counter()

    def walk(i, left, acc):
        if i == len(sizes) - 1:
            if 0 <= left <= sizes[i]:
                weights[acc * math.comb(sizes[i], left)] += 1
            return
        for x in range(0, min(sizes[i], left) + 1):
            walk(i + 1, left - x, acc * math.comb(sizes[i], x))

    walk(0, x_total, 1)
    w_obs = math.prod(math.comb(n, x) for n, x in zip(sizes, successes))
    running, support, p = 0, [], None
    for w in sorted(weights):
        running += w * weights[w]
        support.append(min(1.0, running / norm))
        if w == w_obs:
            p = support[-1]
    return p, sorted(set(support)), sum(weights.values())


def _work_oracle(sizes, x_total):
    """The elements the build makes, counted by enumerating the viable PREFIXES."""
    total = sum(sizes)
    x = min(x_total, total - x_total)
    order = sorted(sizes)
    rem = [sum(order[i + 1:]) for i in range(len(order))]
    prefixes, work = [0], 0
    for i, n in enumerate(order[:-1]):
        work += len(prefixes) * (min(n, x) + 1)
        prefixes = [s + v for s in prefixes for v in range(min(n, x) + 1)
                    if s + v <= x and s + v + rem[i] >= x]
    return work + len(prefixes)


# ── The filed case ───────────────────────────────────────────────────────────

def test_five_groups_of_eighteen_are_counted_exactly():
    p, method = cb.freeman_halton_kx2(SUCC, SIZES)
    assert method == cb.TEST_FREEMAN_HALTON
    assert p == pytest.approx(R_P, rel=1e-9)


def test_and_it_carries_a_support_for_discrete_holm():
    p, method, support = cb._freeman_halton(SUCC, SIZES)
    want_p, want_support, _ = _oracle(SUCC, SIZES)
    assert p == pytest.approx(want_p, rel=1e-9)
    assert support == pytest.approx(want_support, rel=1e-9)


@pytest.mark.skipif(not r_support.HAS_R, reason=r_support.SKIP_REASON_R)
@pytest.mark.parametrize("successes,sizes", [
    (SUCC, SIZES), ([3, 5, 7, 2, 8, 6], [10] * 6), ([1, 0, 4, 6, 2], [12, 12, 12, 12, 12]),
])
def test_matches_r_where_the_old_cap_fell_to_monte_carlo(successes, sizes):
    rows = ",".join(f"{x},{n - x}" for x, n in zip(successes, sizes))
    expr = (f"m <- matrix(c({rows}), ncol = 2, byrow = TRUE); "
            "cat(sprintf('%.12g', fisher.test(m, workspace = 2e8)$p.value))")
    out = subprocess.run([r_support.RSCRIPT, "--vanilla", "-e", expr],
                         capture_output=True, text=True, timeout=120, check=True)
    p, method = cb.freeman_halton_kx2(successes, sizes)
    assert method == cb.TEST_FREEMAN_HALTON
    assert p == pytest.approx(float(out.stdout.strip()), rel=1e-7)


# ── The counts the decision is made from ─────────────────────────────────────

@pytest.mark.parametrize("seed", range(6))
def test_the_table_count_is_the_number_of_tables(seed):
    rng = random.Random(seed)
    for _ in range(15):
        sizes = [rng.randint(1, 7) for _ in range(rng.randint(2, 5))]
        x_total = rng.randint(0, sum(sizes))
        brute = sum(1 for xs in itertools.product(*(range(n + 1) for n in sizes))
                    if sum(xs) == x_total)
        tables, _ = cb._freeman_halton_counts(sorted(sizes), x_total)
        assert tables == brute, (sizes, x_total)


@pytest.mark.parametrize("seed", range(6))
def test_the_work_is_what_the_build_makes(seed):
    rng = random.Random(100 + seed)
    for _ in range(15):
        sizes = [rng.randint(1, 9) for _ in range(rng.randint(2, 6))]
        x_total = rng.randint(0, sum(sizes))
        x = min(x_total, sum(sizes) - x_total)
        _, work = cb._freeman_halton_counts(sorted(sizes), x)
        assert work == _work_oracle(sizes, x_total), (sizes, x_total)


def test_the_cap_is_on_tables_at_the_boundary(monkeypatch):
    x_total = sum(SUCC)
    tables, work = cb._freeman_halton_counts(sorted(SIZES), min(x_total, sum(SIZES) - x_total))
    assert tables == _oracle(SUCC, SIZES)[2]
    monkeypatch.setattr(cb, "FREEMAN_HALTON_MAX_TABLES", int(tables))
    assert cb.freeman_halton_kx2(SUCC, SIZES)[1] == cb.TEST_FREEMAN_HALTON
    monkeypatch.setattr(cb, "FREEMAN_HALTON_MAX_TABLES", int(tables) - 1)
    assert cb.freeman_halton_kx2(SUCC, SIZES)[1] == cb.TEST_FREEMAN_HALTON_MC


def test_the_cap_is_on_work_at_the_boundary(monkeypatch):
    work = _work_oracle(SIZES, sum(SUCC))
    monkeypatch.setattr(cb, "FREEMAN_HALTON_MAX_WORK", work)
    assert cb.freeman_halton_kx2(SUCC, SIZES)[1] == cb.TEST_FREEMAN_HALTON
    # The groups arrive in the labels' order, not by size: the enumeration sorts them
    # itself, so the largest is the one never multiplied out.
    assert cb.freeman_halton_kx2(SUCC[::-1], SIZES[::-1])[1] == cb.TEST_FREEMAN_HALTON
    monkeypatch.setattr(cb, "FREEMAN_HALTON_MAX_WORK", work - 1)
    assert cb.freeman_halton_kx2(SUCC, SIZES)[1] == cb.TEST_FREEMAN_HALTON_MC


def test_a_code_most_people_used_counts_its_non_users():
    """X = 1,328 of N = 1,347: counted as users, the build would try 14.3M elements
    (past the work cap → Monte Carlo); counted as the 19 non-users it is small. The
    p is the same either way (`C(n, x) = C(n, n − x)`), so the oracle runs on the
    complement."""
    sizes = [390, 39, 181, 244, 307, 178, 8]
    succ = [390, 39, 181, 244, 307, 167, 0]
    assert sum(succ) == 1328
    _, work_as_users = cb._freeman_halton_counts(sorted(sizes), sum(succ))
    assert work_as_users > cb.FREEMAN_HALTON_MAX_WORK   # the fixture discriminates
    p, method = cb.freeman_halton_kx2(succ, sizes)
    assert method == cb.TEST_FREEMAN_HALTON
    want, _, _ = _oracle([n - x for x, n in zip(succ, sizes)], sizes)
    assert p == pytest.approx(want, rel=1e-9, abs=1e-15)


def test_the_counts_stop_at_the_cap(monkeypatch):
    """Counted, not timed: past the table cap the count stops (a few steps), where
    running on over 400 groups would be 400 steps and, for counts this large, a float
    overflow — `inf − inf` is NaN, and the decision then fails closed."""
    import numpy as np

    calls = []
    real = np.cumsum
    monkeypatch.setattr(np, "cumsum", lambda a, *k, **kw: calls.append(1) or real(a, *k, **kw))
    tables, _ = cb._freeman_halton_counts([1000] * 400, 200_000)
    assert tables > cb.FREEMAN_HALTON_MAX_TABLES
    assert len(calls) <= 3


def test_a_count_that_is_not_a_number_is_too_many(monkeypatch):
    monkeypatch.setattr(cb, "_freeman_halton_counts", lambda sizes, x: (float("nan"), 0.0))
    assert cb.freeman_halton_kx2(SUCC, SIZES)[1] == cb.TEST_FREEMAN_HALTON_MC


def test_large_tables_still_take_monte_carlo():
    """A positive control: past the cap the estimate stands, seeded, without support."""
    sizes = [300] * 10
    succ = [150] * 9 + [140]
    p, method, support = cb._freeman_halton(succ, sizes)
    assert method == cb.TEST_FREEMAN_HALTON_MC and support is None
    assert p == cb._freeman_halton(succ, sizes)[0]


# ── What the enumeration may reorder, flip and chunk ─────────────────────────

def _small_cases(seed):
    rng = random.Random(200 + seed)
    for _ in range(8):
        sizes = [rng.randint(1, 9) for _ in range(rng.randint(3, 6))]
        succ = [rng.randint(0, n) for n in sizes]
        if sum(succ) not in (0, sum(sizes)):
            yield succ, sizes


@pytest.mark.parametrize("seed", range(4))
def test_neither_the_groups_order_nor_the_column_counted_moves_a_p(seed):
    """Groups are enumerated smallest first and the smaller margin is counted — a
    property of the statistic, so this holds on the old code too (a control)."""
    for succ, sizes in _small_cases(seed):
        want_p, want_support, _ = _oracle(succ, sizes)
        for s, n in (
            (succ, sizes),
            (succ[::-1], sizes[::-1]),                                   # another order
            ([n - x for x, n in zip(succ, sizes)], sizes),               # the other column
        ):
            p, method, support = cb._freeman_halton(s, n)
            assert method == cb.TEST_FREEMAN_HALTON
            assert p == pytest.approx(want_p, rel=1e-9, abs=1e-15)
            assert support == pytest.approx(want_support, rel=1e-9, abs=1e-15)


@pytest.mark.parametrize("seed", range(4))
def test_building_in_chunks_moves_nothing(seed, monkeypatch):
    """The memory guard: a step built in many tiny chunks gives the same tables."""
    monkeypatch.setattr(cb, "FREEMAN_HALTON_CHUNK", 7)
    for succ, sizes in _small_cases(seed):
        want_p, want_support, _ = _oracle(succ, sizes)
        p, method, support = cb._freeman_halton(succ, sizes)
        assert method == cb.TEST_FREEMAN_HALTON
        assert p == pytest.approx(want_p, rel=1e-9, abs=1e-15)
        assert support == pytest.approx(want_support, rel=1e-9, abs=1e-15)


# ── Through the comparison (the pipeline's mouth) ───────────────────────────

def test_the_comparison_tests_five_groups_of_eighteen_exactly(db_session):
    """92 participants in five groups: the code's test is exact, so discrete Holm has
    its support and the marker is known (it was `None` under Monte Carlo)."""
    b = _Builder(db_session)
    pid = 1
    for g, (n, users) in enumerate(zip(SIZES, SUCC)):
        for i in range(n):
            b.person(pid, f"Group {g + 1}", 1, {X: 1 if i < users else 0})
            pid += 1
    t = _code(_cmp(b), "X")["test"]
    assert t["method"] == cb.TEST_FREEMAN_HALTON
    assert t["p_value"] == pytest.approx(R_P, abs=1e-6)
    assert t["min_attainable_p"] is not None
    assert t["can_reach_significance"] is True
