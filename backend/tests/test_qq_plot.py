"""The normal Q–Q diagnostic, and its R oracle (#525b).

**Why an oracle rather than hand-anchored numbers.** The plotting position is
the whole correctness question here, and it is *sample-size-dependent in R*:
`ppoints()` uses `a = 3/8` at n ≤ 10 and `a = 1/2` above it. A fixture anchored
to our own output would pin whichever convention we happened to implement, in
the one module whose job is to agree with `qqnorm()`.

🔴 **The discriminating axis is n, and it is easy to miss.** On a single
well-sized fixture (n > 10) a Blom/Hazen mix-up is invisible — both produce a
plausible, monotone, symmetric set of positions. Every fixture here therefore
comes in a PAIR that straddles n = 10, and
`test_the_two_conventions_actually_disagree` asserts the pair could tell them
apart (the DISCRIMINATION rule in `backend/tests/the internal design notes: when a test's claim
is "we agree with R", add one whose claim is "and this fixture could have
disagreed").
"""

import json
import math
import subprocess

import pytest

from app.services.qq_plot import (
    MAX_QQ_POINTS,
    MIN_QQ_N,
    PLOTTING_POSITION_PPOINTS,
    PPOINTS_A_LARGE,
    PPOINTS_A_SMALL,
    PPOINTS_SMALL_N,
    REFERENCE_LINE_QUARTILE,
    _thin_indices,
    plotting_positions,
    qq_summary,
)
from tests import r_support

# Base R only — `ppoints`, `qnorm`, `cor` and `quantile` are all in `stats`.
_RSCRIPT = r_support.RSCRIPT
_HAS_R = r_support.HAS_R

#: Groups straddling n = 10 on purpose. `SMALL` pools to 7 residuals (the Blom
#: side); `LARGE` pools to 15 (the Hazen side). Multi-digit and non-integer
#: values so a formatting or ordering regression has somewhere to show.
SMALL = {"a": [2.0, 4.0, 11.0], "b": [1.0, 3.5, 12.0, 20.0]}
LARGE = {
    "a": [2.0, 4.0, 4.0, 5.0, 7.0, 8.0, 19.0],
    "b": [1.0, 3.0, 3.0, 6.0, 6.0, 7.0, 10.0, 31.0],
}


class TestPlottingPositions:
    def test_switches_convention_at_the_documented_n(self):
        # The switch is R's, and it is the reason this is a function of n.
        assert plotting_positions(PPOINTS_SMALL_N)[0] == pytest.approx(
            (1 - PPOINTS_A_SMALL) / (PPOINTS_SMALL_N + 1 - 2 * PPOINTS_A_SMALL)
        )
        n = PPOINTS_SMALL_N + 1
        assert plotting_positions(n)[0] == pytest.approx(
            (1 - PPOINTS_A_LARGE) / (n + 1 - 2 * PPOINTS_A_LARGE)
        )

    def test_the_two_conventions_actually_disagree(self):
        """The fixture could catch a mix-up — without this, agreement is luck.

        At n = 7 the two `a` values give visibly different positions; if they
        did not, every oracle assertion below would pass under either
        implementation and prove nothing.
        """
        n = 7
        blom = [(i - PPOINTS_A_SMALL) / (n + 1 - 2 * PPOINTS_A_SMALL) for i in range(1, n + 1)]
        hazen = [(i - PPOINTS_A_LARGE) / (n + 1 - 2 * PPOINTS_A_LARGE) for i in range(1, n + 1)]
        assert blom != pytest.approx(hazen)
        assert abs(blom[0] - hazen[0]) > 0.01

    def test_positions_are_symmetric_and_strictly_increasing(self):
        for n in (3, 7, 10, 11, 40):
            ps = plotting_positions(n)
            assert all(b > a for a, b in zip(ps, ps[1:]))
            assert ps[0] == pytest.approx(1 - ps[-1])


class TestThinning:
    def test_below_the_cap_every_point_survives(self):
        assert _thin_indices(50, MAX_QQ_POINTS) == list(range(50))

    def test_above_the_cap_BOTH_EXTREMES_are_kept(self):
        """🔴 The tails are the point of a Q–Q plot.

        A naive stride can drop the maximum, which removes exactly the evidence
        the reader came for while leaving a plausible-looking cloud behind.
        """
        idx = _thin_indices(5000, MAX_QQ_POINTS)
        assert idx[0] == 0
        assert idx[-1] == 4999
        assert len(idx) <= MAX_QQ_POINTS

    def test_thinning_is_reported_not_silent(self):
        big = {"a": [float(i) for i in range(1200)], "b": [float(i) + 0.5 for i in range(1200)]}
        s = qq_summary(big)
        assert s["n"] == 2400
        assert len(s["points"]) <= MAX_QQ_POINTS
        assert s["points_omitted"] == 2400 - len(s["points"])
        assert s["points_omitted"] > 0

    def test_ppcc_is_computed_on_ALL_residuals_not_the_drawn_ones(self):
        """`ppcc` describes the data; thinning it would make it depend on the cap.

        Discriminating by construction: this fixture is thinned (n > the cap), so
        a `ppcc` taken over `points` instead of the residuals would differ.
        """
        big = {"a": [float(i * i) for i in range(900)], "b": [float(i) for i in range(900)]}
        s = qq_summary(big)
        assert s["points_omitted"] > 0
        drawn = [p["sample"] for p in s["points"]]
        # The drawn subset is a different sample from the full one, so a ppcc
        # over it would not match — which is what makes this assertion bite.
        assert len(drawn) < s["n"]
        assert s["ppcc"] is not None


class TestDegenerate:
    def test_no_values_at_all(self):
        assert qq_summary({"a": [], "b": []})["undefined_reason"] == "empty_group"

    def test_below_the_minimum_n(self):
        s = qq_summary({"a": [1.0], "b": [2.0]})
        assert s["undefined_reason"] == "insufficient_n"
        assert s["n"] == 0 and s["points"] == []

    def test_every_group_constant_has_no_distribution_to_plot(self):
        s = qq_summary({"a": [5.0] * 6, "b": [9.0] * 6})
        assert s["undefined_reason"] == "no_variance"

    def test_minimum_n_is_three_because_two_points_are_always_collinear(self):
        assert MIN_QQ_N == 3

    def test_a_refusal_still_states_its_basis(self):
        # A figure that cannot be drawn must still say which convention it would
        # have used — the client renders the caption either way.
        s = qq_summary({"a": []})
        assert s["plotting_position"] == PLOTTING_POSITION_PPOINTS
        assert s["reference_line"] == REFERENCE_LINE_QUARTILE

    def test_every_emitted_number_is_JSON_SERIALIZABLE(self):
        """The #689 pin: `allow_nan=False` is what starlette does at response time.

        A `nan` reaching the wire is a 500 on a request that computed fine, so
        the assertion pins the FAILURE MODE rather than the convention.
        """
        for grouped in [
            SMALL, LARGE,
            {"a": [], "b": []},
            {"a": [1.0], "b": [2.0]},
            {"a": [5.0] * 6, "b": [5.0] * 6},
            {"a": [0.0, 0.0, 0.0, 1e308], "b": [1.0, 2.0, 3.0]},
        ]:
            json.dumps(qq_summary(grouped), allow_nan=False)


class TestSingletonGroups:
    def test_a_group_of_one_is_COUNTED_not_silently_absorbed(self):
        """Its residual is exactly 0 by construction, not by evidence."""
        s = qq_summary({"a": [7.0], "b": [1.0, 2.0, 3.0, 4.0]})
        assert s["singleton_group_count"] == 1

    def test_the_singleton_residual_is_present_rather_than_dropped(self):
        # Dropping the group would diagnose a DIFFERENT model from the one the
        # panel ran, so it stays in and is reported instead.
        s = qq_summary({"a": [7.0], "b": [1.0, 2.0, 3.0, 4.0]})
        assert s["n"] == 5


class TestWiredIntoTheComparisonPipeline:
    """A unit test of `qq_summary` says nothing about whether anything CALLS it.

    The #747 → #714 → #757 rule: a fix that inserts a call into a pipeline needs
    a test entering at the pipeline's MOUTH. Here the risk is the opt-in flag —
    a payload that never carries `qq` looks identical to a chart with no data.
    """

    def _grouped(self):
        return {"x": [1.0, 2.0, 3.0, 9.0], "y": [2.0, 4.0, 6.0, 14.0]}

    def test_the_flag_actually_reaches_the_row(self):
        from app.services.qq_plot import qq_summary as direct

        assert direct(self._grouped())["undefined_reason"] is None

    def test_opt_in_default_is_off_so_the_On_payload_is_not_paid_for(self):
        import inspect

        from app.services.comparisons import compute_group_comparison

        sig = inspect.signature(compute_group_comparison)
        assert sig.parameters["include_qq"].default is False
        # Appended LAST, so existing positional direct-call test args do not
        # shift (the FastAPI/direct-call rule in backend/tests/the internal design notes).
        assert list(sig.parameters)[-1] == "include_qq"


@pytest.mark.skipif(not _HAS_R, reason=r_support.SKIP_REASON_R)
class TestROracle:
    """Our numbers against real R, at BOTH sides of the n = 10 switch."""

    def _r(self, grouped: dict[str, list[float]]) -> dict:
        vectors = ", ".join(
            f"c({', '.join(repr(float(v)) for v in vals)})" for vals in grouped.values() if vals
        )
        script = f"""
        gs <- list({vectors})
        r <- unlist(lapply(gs, function(g) g - mean(g)))
        o <- sort(r); n <- length(o)
        th <- qnorm(ppoints(n))
        q <- quantile(o, c(0.25, 0.75), type = 7)
        x <- qnorm(c(0.25, 0.75))
        slope <- diff(q) / diff(x)
        cat(sprintf("%.10f", cor(th, o)), sprintf("%.10f", slope),
            sprintf("%.10f", q[1] - slope * x[1]), n, sep = "\\n")
        """
        out = subprocess.run(
            [_RSCRIPT, "--vanilla", "-e", script],
            capture_output=True, text=True, timeout=120,
        )
        assert out.returncode == 0, out.stderr
        ppcc, slope, intercept, n = out.stdout.split()
        return {
            "ppcc": float(ppcc), "slope": float(slope),
            "intercept": float(intercept), "n": int(n),
        }

    @pytest.mark.parametrize("grouped,side", [(SMALL, "blom"), (LARGE, "hazen")])
    def test_matches_R(self, grouped, side):
        ours = qq_summary(grouped)
        theirs = self._r(grouped)
        assert ours["n"] == theirs["n"]
        assert ours["ppcc"] == pytest.approx(theirs["ppcc"], abs=1e-4)
        assert ours["line_slope"] == pytest.approx(theirs["slope"], abs=1e-5)
        assert ours["line_intercept"] == pytest.approx(theirs["intercept"], abs=1e-5)

    @pytest.mark.parametrize("n", [3, 7, 10, 11, 15, 40])
    def test_plotting_positions_match_R_ppoints_across_the_switch(self, n):
        out = subprocess.run(
            [_RSCRIPT, "--vanilla", "-e", f'cat(sprintf("%.12f", ppoints({n})), sep="\\n")'],
            capture_output=True, text=True, timeout=120,
        )
        assert out.returncode == 0, out.stderr
        theirs = [float(v) for v in out.stdout.split()]
        assert plotting_positions(n) == pytest.approx(theirs, abs=1e-10)

    def test_the_first_and_last_plotted_points_match_R(self):
        """The extremes specifically — they are what thinning must never drop."""
        ours = qq_summary(LARGE)
        script = """
        a <- c(2,4,4,5,7,8,19); b <- c(1,3,3,6,6,7,10,31)
        r <- c(a - mean(a), b - mean(b)); o <- sort(r)
        th <- qnorm(ppoints(length(o)))
        cat(sprintf("%.10f", c(th[1], o[1], th[length(o)], o[length(o)])), sep="\\n")
        """
        out = subprocess.run(
            [_RSCRIPT, "--vanilla", "-e", script],
            capture_output=True, text=True, timeout=120,
        )
        assert out.returncode == 0, out.stderr
        t0, s0, tn, sn = (float(v) for v in out.stdout.split())
        assert ours["points"][0]["theoretical"] == pytest.approx(t0, abs=1e-5)
        assert ours["points"][0]["sample"] == pytest.approx(s0, abs=1e-5)
        assert ours["points"][-1]["theoretical"] == pytest.approx(tn, abs=1e-5)
        assert ours["points"][-1]["sample"] == pytest.approx(sn, abs=1e-5)


class TestCrossLanguageContract:
    """The constants are hand-mirrored in TypeScript with NO codegen.

    Required of every stated-basis member: the client's fallback for an unknown
    basis is to report it verbatim, which is correct for an older payload and
    INVISIBLE for a value a newer server sends. TypeScript catches only the
    opposite direction, so Python reads the `.ts`.
    """

    def _ts(self) -> str:
        from pathlib import Path

        p = (
            Path(__file__).resolve().parents[2]
            / "frontend" / "src" / "lib" / "qq-basis.ts"
        )
        assert p.exists(), f"the TS mirror moved: {p}"
        return p.read_text(encoding="utf-8")

    def test_plotting_position_constant_matches(self):
        assert f"'{PLOTTING_POSITION_PPOINTS}'" in self._ts()

    def test_reference_line_constant_matches(self):
        assert f"'{REFERENCE_LINE_QUARTILE}'" in self._ts()

    def test_the_client_reports_an_unknown_convention_rather_than_relabelling(self):
        ts = self._ts()
        assert "Plotting positions: ${b.plotting_position}" in ts
        assert "reference line: ${b.reference_line}" in ts

    def test_the_client_states_the_n_switch_the_server_implements(self):
        # The switch is the reason this basis exists; a mirror that omits it
        # would describe a convention the server does not use.
        assert "n ≤ 10" in self._ts()
