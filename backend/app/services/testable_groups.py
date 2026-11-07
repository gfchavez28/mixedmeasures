"""Which groups a comparison's tests may use (#1329, 1.5.9, D51).

🔴 **A group holding fewer values than a test needs is LISTED and left out of
EVERY test of its row, and the row says so.** Listed: the table keeps its n,
mean and median (its SD and interval are undefined — one value has no spread,
and every reference answers NA, never 0). Left out of: the F, Tukey's post hoc,
the Welch t and Levene's check — all four read the groups this module returns,
so no two of them can use different models again.

Before this, three rules ran side by side: the comparison's F dropped a
one-value group while its OWN Tukey table kept it (measured on A(6) B(5) C(1):
the app printed F(1, 9) = 104.43 beside a post hoc that compared C), Levene kept
it as a structural zero, and the saved-test ANOVA refused the whole test. And
the R script halted on it (`t.test` raises on a one-person group).

**Why leave it out rather than include it as R's `aov` does.** Including a
single value is exact only under equal variances, and with one value its
variance cannot be checked; the review's simulation put the Type I error at .21
when that group's SD was twice the others'. Leaving it out is the app's own F
rule made universal, so the F the app shows does not move. The review record:
the internal design notes (git-ignored).

⚠️ **Rank tests need one value per group, not two.** Mann–Whitney and
Kruskal–Wallis rank every value, so a one-value group is a real participant in
them: their minimum is `MIN_VALUES_PER_GROUP_RANK`. A caller states which test
family it is asking for — there is no default.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

#: A t-test, an ANOVA, Tukey's HSD and Levene's check all estimate each group's
#: variance, which one value does not have.
MIN_VALUES_PER_GROUP_PARAMETRIC = 2

#: Mann–Whitney and Kruskal–Wallis rank the values; one value is ranked.
MIN_VALUES_PER_GROUP_RANK = 1


def split_testable(
    grouped: Mapping[str, Sequence],
    names: Sequence[str],
    min_values: int,
) -> tuple[list[str], list[str]]:
    """``(testable, untested)`` — both in ``names``' order.

    ``testable`` are the groups with at least ``min_values`` values: the ones a
    test may use. ``untested`` are the groups that HAVE values but too few — the
    ones a row must name. An EMPTY group is in neither list: it has nothing to
    leave out, and its own cell already says it is empty (`EMPTY_GROUP`).
    """
    testable: list[str] = []
    untested: list[str] = []
    for name in names:
        n = len(grouped.get(name, ()))
        if n >= min_values:
            testable.append(name)
        elif n > 0:
            untested.append(name)
    return testable, untested
