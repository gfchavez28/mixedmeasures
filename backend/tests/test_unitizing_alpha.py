"""Track J · J3-3 — Krippendorff's unitizing alpha (α_U) compute core.

Three layers of ground truth, all independent of our code:
1. Published worked examples — Krippendorff, Content Analysis 2004 p. 254
   (overall α_U = 0.8591) and Krippendorff 1995 p. 57 (the four-category
   Bertha/John/Gerret/Heather study).
2. The DKPro Statistics reference implementation's asserted test vectors
   (org.dkpro.statistics.agreement.unitizing, Apache-2.0) — exact distance-metric
   values and D_o/D_e/α at multiple continuum resolutions.
3. Hand-derived properties (perfect agreement, scale invariance of D_o,
   uninformative-lone-unit, precondition errors).

NOTE: the 1995 paper's OWN expected-disagreement values are not reproduced —
the paper's D_E formula carries a sign error corrected in Content Analysis
(2004); this implementation (like DKPro) follows the corrected form.
"""
import pytest

from app.services.unitizing import UnitizingUnit, measure_distance, unitizing_alpha


def U(coder, offset, length, category="X"):
    return UnitizingUnit(coder=coder, offset=offset, length=length, category=category)


# ── 1. Distance metric — exact vectors from the reference tests ────────────────


@pytest.mark.parametrize("args,expected", [
    # Krippendorff2004Test.testDistanceMetric1 (None = gap)
    ((2, 3, None, 2, 2, "X"), 4), ((5, 6, "X", 4, 7, None), 36),   # sums to 40
    ((3, 2, None, 3, 2, "X"), 4), ((5, 6, "X", 5, 6, None), 36),   # sums to 40
    ((5, 6, "X", 4, 2, "X"), 26),
    ((5, 6, "X", 5, 2, "X"), 16),
    ((5, 6, "X", 6, 2, "X"), 10),
    ((5, 6, "X", 7, 2, "X"), 8),
    ((5, 6, "X", 6, 4, "X"), 2),
    ((5, 6, "X", 5, 6, "X"), 0),
    # Krippendorff2004Test.testDistanceMetric2
    ((225, 70, "c", 220, 80, "c"), 50),
    ((370, 30, "c", 355, 20, "c"), 850),
    ((400, 50, None, 400, 20, "c"), 400),
    # UnitizingAgreementTest.testDistanceMetric
    ((0, 1, None, 0, 2, None), 0),
    ((1, 8, "A", 0, 2, None), 0),      # unit only PARTLY inside the gap → 0
    ((1, 8, "A", 2, 1, "A"), 37),
    ((1, 8, "A", 3, 1, None), 0),
    ((1, 8, "A", 4, 1, "A"), 25),
    ((1, 8, "A", 5, 1, None), 0),
    ((1, 8, "A", 6, 1, "A"), 29),
    ((1, 8, "A", 7, 4, None), 0),
    ((9, 2, None, 7, 4, None), 0),
])
def test_distance_metric_reference_vectors(args, expected):
    assert measure_distance(*args) == expected


# ── 2. Krippendorff (2004: 254) — the canonical published example ──────────────
#
# Continuum [150, 450), 2 observers, categories c and k.


def _k2004():
    units = [
        U(0, 225, 70, "c"), U(0, 370, 30, "c"),
        U(1, 220, 80, "c"), U(1, 355, 20, "c"), U(1, 400, 20, "c"),
        U(0, 180, 60, "k"), U(0, 300, 50, "k"),
        U(1, 180, 60, "k"), U(1, 300, 50, "k"),
    ]
    return unitizing_alpha(300, 2, units, continuum_begin=150)


def test_krippendorff_2004_published_example():
    res = _k2004()
    assert res["overall"]["alpha"] == pytest.approx(0.8591, abs=0.0005)
    c = res["per_category"]["c"]
    assert c["d_o"] == pytest.approx(0.0144, abs=1e-4)
    assert c["d_e"] == pytest.approx(0.0532, abs=1e-4)
    assert c["alpha"] == pytest.approx(0.7286, abs=1e-4)
    k = res["per_category"]["k"]
    assert k["d_o"] == pytest.approx(0.0, abs=1e-4)
    assert k["d_e"] == pytest.approx(0.0490, abs=1e-4)
    assert k["alpha"] == pytest.approx(1.0, abs=1e-4)
    assert c["n_units"] == 5 and k["n_units"] == 4


# ── 3. Krippendorff (1995: 57) — four categories, continuum-resolution series ──
#
# Offsets/lengths scale with `stretch` exactly as the reference test does
# (truncating int cast). D_o is resolution-invariant; D_e converges as the
# continuum is refined.

_K1995 = {
    "A": {0: [(2, 8), (14, 6)], 1: [(4, 4), (15, 2)]},
    "B": {0: [(0, 18)], 1: [(0, 2), (2, 1), (3, 1), (4, 1), (5, 1), (6, 3), (9, 1)]},
    "C": {0: [(2, 6), (10, 2), (14, 4), (20, 2)],
          1: [(0, 2), (4, 4), (10, 4), (16, 2), (20, 2)]},
    "D": {0: [(0, 2), (2, 8), (10, 4), (14, 6), (20, 4)],
          1: [(0, 4), (4, 4), (8, 7), (15, 2), (17, 7)]},
}


def _k1995(stretch: float):
    units = [
        U(coder, int(o * stretch), int(l * stretch), cat)
        for cat, coders in _K1995.items()
        for coder, spans in coders.items()
        for o, l in spans
    ]
    return unitizing_alpha(int(24 * stretch), 2, units)


def test_krippendorff_1995_observed_disagreement():
    per = _k1995(1)["per_category"]
    assert per["A"]["d_o"] == pytest.approx(0.03125, abs=1e-5)
    assert per["B"]["d_o"] == pytest.approx(2.26736, abs=1e-5)
    assert per["C"]["d_o"] == pytest.approx(0.02777, abs=1e-5)
    assert per["D"]["d_o"] == pytest.approx(0.38715, abs=1e-5)


def test_krippendorff_1995_expected_and_alpha_at_fine_resolution():
    per = _k1995(1200000 / 24)["per_category"]
    for cat, d_e, alpha in [
        ("A", 0.06990, 0.553), ("B", 1.17731, -0.926),
        ("C", 0.08642, 0.679), ("D", 0.41445, 0.066),
    ]:
        assert per[cat]["d_e"] == pytest.approx(d_e, abs=0.005), cat
        assert per[cat]["alpha"] == pytest.approx(alpha, abs=0.02), cat


@pytest.mark.parametrize("stretch,d_e,alpha", [
    (12 / 24.0, 0.05494, 0.494),
    (120 / 24.0, 0.08234, 0.663),
    (1200 / 24.0, 0.08600, 0.677),
    (12000 / 24.0, 0.08638, 0.678),
    (120000 / 24.0, 0.08642, 0.679),
])
def test_krippendorff_1995_resolution_series_category_c(stretch, d_e, alpha):
    # Category C only: at stretch 0.5 the OTHER categories' length-1 units
    # truncate to length 0, which the reference accepts silently but our
    # stricter validation rejects; C's spans stay ≥1 at every stretch and other
    # categories cannot affect C's per-category math anyway.
    units = [
        U(coder, int(o * stretch), int(l * stretch), "C")
        for coder, spans in _K1995["C"].items()
        for o, l in spans
    ]
    c = unitizing_alpha(int(24 * stretch), 2, units)["per_category"]["C"]
    assert c["d_o"] == pytest.approx(0.02777, abs=1e-5)
    assert c["d_e"] == pytest.approx(d_e, abs=0.005)
    assert c["alpha"] == pytest.approx(alpha, abs=0.02)


# ── 4. Small-study vectors + edge semantics (UnitizingAgreementTest) ───────────


def test_fragmented_vs_long_unit_example():
    # r0: -11111111-  /  r1: --1-1-1---  → worse than chance
    res = unitizing_alpha(10, 2, [
        U(0, 1, 8, "A"), U(1, 2, 1, "A"), U(1, 4, 1, "A"), U(1, 6, 1, "A"),
    ])
    a = res["per_category"]["A"]
    assert a["d_o"] == pytest.approx(0.9100, abs=1e-4)
    assert a["d_e"] == pytest.approx(0.5351, abs=1e-4)
    assert a["alpha"] == pytest.approx(-0.7003, abs=1e-4)


def test_lone_unit_is_uninformative_alpha_zero():
    # One coder marks a single tiny unit, nobody else marks anything:
    # D_o == D_e EXACTLY (both 1/600 here) → α = 0.0, not 1 − 1 = 0 by luck but
    # by the equality guard — the reference pins this semantics.
    res = unitizing_alpha(20, 3, [U(0, 0, 1, "X")])
    assert res["overall"]["alpha"] == 0.0
    assert res["per_category"]["X"]["d_o"] == pytest.approx(1 / 600, abs=1e-12)
    assert res["per_category"]["X"]["d_e"] == pytest.approx(1 / 600, abs=1e-12)


def test_no_units_is_undefined():
    res = unitizing_alpha(20, 3, [])
    assert res["overall"]["alpha"] is None
    assert res["per_category"] == {}


# ── 5. Properties + preconditions ──────────────────────────────────────────────


def test_perfect_agreement_is_one():
    units = [U(r, o, l, c) for r in (0, 1, 2)
             for o, l, c in [(3, 4, "A"), (10, 2, "A"), (20, 5, "B")]]
    res = unitizing_alpha(30, 3, units)
    assert res["overall"]["alpha"] == pytest.approx(1.0)
    for cat in ("A", "B"):
        assert res["per_category"][cat]["alpha"] == pytest.approx(1.0)
        assert res["per_category"][cat]["d_o"] == 0.0


def test_observed_disagreement_is_resolution_invariant():
    base = unitizing_alpha(24, 2, [U(0, 2, 6), U(1, 4, 4)])
    fine = unitizing_alpha(240, 2, [U(0, 20, 60), U(1, 40, 40)])
    assert base["per_category"]["X"]["d_o"] == pytest.approx(
        fine["per_category"]["X"]["d_o"], abs=1e-12
    )


def test_multi_coder_study_runs():
    # 3 coders, overlapping-but-offset marks — α must land strictly between the
    # perfect (1.0) and the fragmented (-0.7) anchors and be finite.
    res = unitizing_alpha(100, 3, [
        U(0, 10, 20), U(1, 12, 18), U(2, 8, 25),
        U(0, 60, 10), U(1, 58, 14),
    ])
    a = res["per_category"]["X"]["alpha"]
    assert a is not None and -1.0 < a < 1.0


def test_preconditions():
    with pytest.raises(ValueError, match="at least 2 coders"):
        unitizing_alpha(10, 1, [U(0, 0, 2)])
    with pytest.raises(ValueError, match="positive"):
        unitizing_alpha(0, 2, [])
    with pytest.raises(ValueError, match="overlapping"):
        unitizing_alpha(10, 2, [U(0, 0, 4), U(0, 2, 4)])
    with pytest.raises(ValueError, match="outside continuum"):
        unitizing_alpha(10, 2, [U(0, 8, 4)])
    with pytest.raises(ValueError, match="out of range"):
        unitizing_alpha(10, 2, [U(5, 0, 2)])
    with pytest.raises(ValueError, match="category"):
        unitizing_alpha(10, 2, [UnitizingUnit(0, 0, 2, None)])
    # abutting same-coder units are LEGAL (kept distinct, per the reference)
    res = unitizing_alpha(10, 2, [U(0, 0, 2), U(0, 2, 2), U(1, 0, 4)])
    assert res["per_category"]["X"]["alpha"] is not None
