"""Krippendorff's unitizing alpha (α_U) — continuum-based agreement (Track J · J3-3).

Measures how well coders agree on WHERE the coded material is — the position and
extent of marked stretches on a shared continuum — not merely whether a fixed unit
carries a code. This is the coefficient family NO mainstream QDA tool computes
(verified 2026-06-25; ATLAS.ti's ICA is binary presence/absence per unit —
boundary-SENSITIVE, not unitizing). Positioning claim must stay honesty-caveated:
"first QDA tool to compute TRUE unitizing agreement", never "first to do
Krippendorff's alpha".

**Sources.** Krippendorff (1995) "On the reliability of unitizing continuous
data", *Sociological Methodology* 25:47–76, with the expected-disagreement
correction from Krippendorff, *Content Analysis* (2nd ed. 2004, §12, worked
example p. 254). Cross-validated against the DKPro Statistics reference
implementation (org.dkpro.statistics.agreement.unitizing, Apache-2.0, Meyer et
al. 2014), which implements the same corrected form — every published test
vector it carries is reproduced in ``tests/test_unitizing_alpha.py``.

**Setup.** A continuum of integer length L (chars of a concatenated transcript;
discretized time ticks for media). Each of R coders marks, per category c (a
code), non-overlapping integer sections ("units"); everything unmarked is gap.
Computation is per category, binary (c vs not-c): while scoring category c, a
coder's stretches carrying only OTHER categories count as gap.

**Distance** between two intersecting sections (one from each coder) — δ of
Krippendorff (1995:61):

- unit vs unit, intersecting: (begin₁−begin₂)² + (end₁−end₂)²
- unit fully inside the other coder's gap: (unit length)²
- otherwise (gap–gap; unit partially outside a gap; disjoint units): 0

**Observed disagreement** for category c:
    uD_o(c) = 2/(R(R−1)L²) · Σ_{coder pairs} Σ_{intersecting section pairs} δ

**Expected disagreement** for category c (2004 corrected closed form; all-integer
in Python — no BigDecimal needed, unlike the Java reference):
    uD_e(c) = (2/L) · Σ_{units u} [ (N_c−1)·l_u(l_u−1)(2l_u−1)/3
                                    + l_u² · Σ_{gaps g ≥ l_u} (g−l_u+1) ]
              / ( R·L·(R·L−1) − Σ_{units u} l_u(l_u−1) )
where N_c = number of c-units across ALL coders and the gap lengths are collected
from every coder's section walk (a coder with no c-units contributes one gap of
length L).

    α_U(c) = 1 − uD_o(c)/uD_e(c)

**Overall α_U** = 1 − mean_c(uD_o)/mean_c(uD_e), unweighted over the categories
that appear on ≥1 unit (the DKPro combination rule).

**Edge semantics** (match the reference): no units at all → α undefined (None
here, NaN in DKPro); a lone unit anywhere → uD_o == uD_e exactly → α = 0.0
(uninformative, no better than chance — the equality guard, not the ratio).

The math is pure and DB-free: callers construct the continuum (see the J3-3
scoping doc the internal design notes — segment
concatenation is derivable today with zero schema change; per-coder divergent
segmentation stays the deferred overlay arc).
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from fractions import Fraction

__all__ = ["UnitizingUnit", "unitizing_alpha", "measure_distance"]


@dataclass(frozen=True)
class UnitizingUnit:
    """One marked stretch: ``coder`` is a 0-based index, ``category`` any hashable
    non-None label (a code id), ``offset``/``length`` integers on the continuum."""
    coder: int
    offset: int
    length: int
    category: object


def measure_distance(
    o1: int, l1: int, cat1: object, o2: int, l2: int, cat2: object,
) -> int:
    """δ between two sections (category ``None`` = gap). Krippendorff (1995:61)."""
    begin_diff = o1 - o2
    length_diff = l1 - l2
    if cat1 is not None and cat2 is not None and -l1 < begin_diff < l2:
        # both units, intersecting: squared begin-difference + squared end-difference
        return begin_diff * begin_diff + (begin_diff + length_diff) ** 2
    if cat1 is not None and cat2 is None and 0 <= begin_diff <= -length_diff:
        return l1 * l1  # unit 1 lies fully inside gap 2
    if cat1 is None and cat2 is not None and -length_diff <= begin_diff <= 0:
        return l2 * l2  # unit 2 lies fully inside gap 1
    return 0


def _sections(
    units: list[UnitizingUnit], begin: int, length: int,
) -> list[tuple[int, int, object]]:
    """One coder's category-c section walk: alternating (offset, length, category)
    covering [begin, begin+length) — units as given (NOT merged when abutting; the
    reference keeps abutting units distinct), gaps derived, zero-length gaps
    skipped. Validates the non-overlap precondition."""
    out: list[tuple[int, int, object]] = []
    pos = begin
    end = begin + length
    for u in sorted(units, key=lambda u: u.offset):
        if u.length <= 0 or u.offset < begin or u.offset + u.length > end:
            raise ValueError(f"unit outside continuum or non-positive length: {u}")
        if u.offset < pos:
            raise ValueError(f"overlapping same-category units for one coder: {u}")
        if u.offset > pos:
            out.append((pos, u.offset - pos, None))
        out.append((u.offset, u.length, u.category))
        pos = u.offset + u.length
    if pos < end:
        out.append((pos, end - pos, None))
    return out


def _observed_pair_sum(
    a: list[tuple[int, int, object]], b: list[tuple[int, int, object]],
) -> int:
    """Σ δ over every intersecting section pair of two coders' walks (two-pointer;
    each intersecting pair contributes exactly once)."""
    total = 0
    i = j = 0
    while i < len(a) and j < len(b):
        o1, l1, c1 = a[i]
        o2, l2, c2 = b[j]
        total += measure_distance(o1, l1, c1, o2, l2, c2)
        end1, end2 = o1 + l1, o2 + l2
        if end1 <= end2:
            i += 1
        if end2 <= end1:
            j += 1
    return total


def unitizing_alpha(
    continuum_length: int,
    n_coders: int,
    units: list[UnitizingUnit],
    continuum_begin: int = 0,
) -> dict:
    """Compute α_U overall + per category.

    ``n_coders`` counts every coder in the study, including coders who marked
    nothing (their whole continuum is gap) — the CALLER decides the roster
    (Option-B engagement semantics for MM surfaces).

    Returns ``{"overall": {...}, "per_category": {cat: {...}}}`` where each block
    carries ``d_o``, ``d_e``, ``alpha`` (floats; ``alpha`` None only when
    undefined — no units at all) and per-category ``n_units``.
    """
    if continuum_length <= 0:
        raise ValueError("continuum_length must be positive")
    if n_coders < 2:
        raise ValueError("unitizing alpha needs at least 2 coders")

    by_cat: dict[object, dict[int, list[UnitizingUnit]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for u in units:
        if u.category is None:
            raise ValueError("units must carry a category (gaps are derived)")
        if not 0 <= u.coder < n_coders:
            raise ValueError(f"coder index out of range: {u}")
        by_cat[u.category][u.coder].append(u)

    if not by_cat:
        return {
            "overall": {"d_o": None, "d_e": None, "alpha": None},
            "per_category": {},
        }

    R, L, B = n_coders, continuum_length, continuum_begin
    per_category: dict[object, dict] = {}
    do_sum = Fraction(0)
    de_sum = Fraction(0)

    for cat, coder_units in by_cat.items():
        walks = [_sections(coder_units.get(r, []), B, L) for r in range(R)]

        # Observed: exact integer δ sum over coder pairs, then normalize.
        obs = 0
        for r1 in range(R):
            for r2 in range(r1 + 1, R):
                obs += _observed_pair_sum(walks[r1], walks[r2])
        d_o = Fraction(2 * obs, R * (R - 1) * L * L)

        # Expected: 2004 corrected closed form, exact integer numerator.
        cat_units = [u for us in coder_units.values() for u in us]
        n_c = len(cat_units)
        sq_lengths = sum(u.length * (u.length - 1) for u in cat_units)
        gaps = sorted(
            (l for walk in walks for (_o, l, c) in walk if c is None),
            reverse=True,
        )
        numer = 0
        for u in cat_units:
            l = u.length
            # l(l−1)(2l−1) is divisible by 6, so // 3 is exact
            term = (n_c - 1) * (l * (l - 1) * (2 * l - 1) // 3)
            for g in gaps:
                if g < l:
                    break  # descending sort → no later gap fits either
                term += l * l * (g - l + 1)
            numer += term
        denom = R * L * (R * L - 1) - sq_lengths
        d_e = Fraction(2 * numer, L * denom) if denom else Fraction(0)

        if d_o == d_e:
            alpha = 0.0  # includes the lone-uninformative-unit case
        else:
            alpha = float(1 - d_o / d_e) if d_e else None
        per_category[cat] = {
            "n_units": n_c,
            "d_o": float(d_o),
            "d_e": float(d_e),
            "alpha": alpha,
        }
        do_sum += d_o
        de_sum += d_e

    k = len(by_cat)
    mean_do, mean_de = do_sum / k, de_sum / k
    if mean_do == mean_de:
        overall_alpha = 0.0
    else:
        overall_alpha = float(1 - mean_do / mean_de) if mean_de else None
    return {
        "overall": {
            "d_o": float(mean_do),
            "d_e": float(mean_de),
            "alpha": overall_alpha,
        },
        "per_category": per_category,
    }
