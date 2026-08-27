"""Fail-closed guard: when a run DECLARES it needs R, silence is not success (#642).

The R-backed oracle tests skip when R is absent, and a skip is silent. Neither
CI workflow installed R, so 21 oracle tests — the whole #402 export round-trip
and the only external check on time-binned kappa — went dark on the machine
that hard-gates releases, while the run reported green for months.

Installing R fixes that instance. THIS fixes the class: a run that sets
`MM_REQUIRE_R=1` (both workflows do) fails loudly the moment R or any required
package goes missing, instead of quietly dropping 21 tests.

Sibling of the project's other fail-closed guards (`test_ownership_gate_sweep`,
`test_grouping_na_sweep`): the guard exists because the eye cannot see an
absence.
"""

import pytest

from tests import r_support


def test_r_oracles_are_present_when_the_run_requires_them():
    """Under MM_REQUIRE_R, a missing R/package set is a FAILURE, not 21 skips."""
    if not r_support.r_is_required():
        pytest.skip("MM_REQUIRE_R is not set — R is optional for this run")

    report = r_support.unavailability_report()
    if report is not None:
        pytest.fail(
            "MM_REQUIRE_R is set, but the R correctness oracles cannot run.\n\n"
            f"{report}\n\n"
            "The R-gated tests would SKIP silently and this run would report "
            "green without ever checking the tool's statistics against R.",
            pytrace=False,
        )


@pytest.mark.parametrize(
    "value,expected",
    [
        ("1", True), ("true", True), ("TRUE", True), ("yes", True), (" 1 ", True),
        ("0", False), ("false", False), ("no", False), ("", False),
        # A typo must DISABLE strictness loudly-by-absence rather than be
        # silently treated as truthy: an unrecognised value means the workflow
        # is misconfigured, and the CI-side pin below is what catches that.
        ("on", False), ("maybe", False),
    ],
)
def test_require_flag_parses_exactly_the_documented_values(monkeypatch, value, expected):
    monkeypatch.setenv("MM_REQUIRE_R", value)
    assert r_support.r_is_required() is expected


def test_require_flag_is_off_when_unset(monkeypatch):
    """Local default: no R needed, no behavior change from before #642."""
    monkeypatch.delenv("MM_REQUIRE_R", raising=False)
    assert r_support.r_is_required() is False


def test_ci_workflows_require_r_on_the_pytest_step():
    """Both workflows must SET the flag — otherwise the guard above never fires.

    This is the half that cannot be checked from inside a test run: the guard
    only works if CI turns it on, and a workflow edit that drops the env var
    would restore the exact silence #642 describes.

    ⚠️ **Know what this second assertion does NOT prove.** It is a name scan: it
    shows each required package is *provisioned somehow*, not that the name
    resolves on the runner. The first version of it hard-coded `r-cran-irr` — a
    package that does not exist in any Ubuntu component — so it passed happily
    while the step it was guarding exited 100 on "Unable to locate package"
    (2026-08-02). Only executing the install can prove that, which is why both
    workflows end the step with a `requireNamespace` verify line, asserted
    below. Same family as the ownership sweep being blind to a second id: a scan
    for a name confirms the name, never the behavior.
    """
    from pathlib import Path

    workflows = Path(__file__).resolve().parents[2] / ".github" / "workflows"
    for name in ("ci.yml", "release.yml"):
        raw = (workflows / name).read_text(encoding="utf-8")
        # Scan what RUNS, not what is written about. These steps carry long
        # explanatory comments that name the very packages under test — read
        # whole-file and a comment mentioning `r-cran-psych` satisfies the
        # provisioning check while nothing installs it (and the negative check
        # below trips on its own rationale). Both directions are false readings.
        text = "\n".join(
            line for line in raw.splitlines() if not line.strip().startswith("#")
        )
        assert "MM_REQUIRE_R: \"1\"" in text or "MM_REQUIRE_R: '1'" in text, (
            f"{name} does not set MM_REQUIRE_R on the backend test step — the "
            "R oracles would skip silently there (#642)."
        )
        # Single-sourced off REQUIRED_R_PACKAGES so adding an oracle package
        # cannot leave a workflow behind. Either provisioning route counts: the
        # Debian binary (four of them) or CRAN (irr, which Debian never
        # packaged).
        for pkg in r_support.REQUIRED_R_PACKAGES:
            provisioned = (
                f"r-cran-{pkg.lower()}" in text
                or f'install.packages("{pkg}"' in text
            )
            assert provisioned, (
                f"{name} never installs the R oracle package {pkg!r} (#642) — "
                "the exported script would try to build it from CRAN mid-test."
            )
        # The one fact a name scan CAN pin, now that it has been paid for:
        # `r-cran-irr` is not a package that exists. Reaching for the obvious
        # apt name is the natural edit here (it is what the other four look
        # like), so refuse it by name rather than waiting for the runner.
        assert "r-cran-irr" not in text, (
            f"{name} installs `r-cran-irr`, which does not exist in ANY Ubuntu "
            "component — apt exits 100 with 'Unable to locate package' before a "
            "single test runs (2026-08-02). Debian has never packaged `irr`; it "
            "comes from CRAN, and it is safe to build there because it is pure "
            "R with lpSolve as its only dependency."
        )
        assert "requireNamespace" in text, (
            f"{name} installs the oracle packages but never VERIFIES they "
            "loaded. Without that line an unresolvable package name fails two "
            "steps later, or not at all — the 2026-08-02 regression."
        )


def test_the_R_install_step_cannot_eat_the_whole_job_budget():
    """#781 — the R install must fail on its OWN clock, in both workflows.

    Twice (2026-08-14, 2026-08-19) `apt-get` consumed the job's entire
    `timeout-minutes`. A JOB-level timeout cancels the running step and SKIPS
    every step after it, so the run reads **`cancelled`** — indistinguishable
    from a human stopping it — while `Tests` and the HARD production-dependency
    gate never executed. Green by appearance, two gates dark.

    A STEP-level timeout makes the step FAIL instead: the run reads `failure`
    and names the cause. The suite still does not run, but that fact is loud,
    which is the whole requirement.

    ⚠️ Parsed as YAML, not grepped. The step carries a long comment that says
    "timeout" several times, so a text scan would pass on the rationale alone —
    the #772 phantom-parser lesson, and the sibling scan above already records
    being burned by exactly that.
    """
    from pathlib import Path

    import yaml

    workflows = Path(__file__).resolve().parents[2] / ".github" / "workflows"
    checked = 0
    for name in ("ci.yml", "release.yml"):
        spec = yaml.safe_load((workflows / name).read_text(encoding="utf-8"))
        for job_name, job in spec["jobs"].items():
            for step in job.get("steps") or []:
                if "Install R" not in (step.get("name") or ""):
                    continue
                checked += 1
                assert step.get("timeout-minutes"), (
                    f"{name}:{job_name} — the R install step has no "
                    "`timeout-minutes`, so a slow mirror consumes the job's "
                    "budget and the suite is SKIPPED under a `cancelled` run "
                    "(#781, twice observed)."
                )
                assert step["timeout-minutes"] < job["timeout-minutes"], (
                    f"{name}:{job_name} — the step timeout must be STRICTLY "
                    "less than the job's, or the job still dies first and the "
                    "step timeout buys nothing."
                )
    # Population self-check (#730): a scan whose expected result is empty passes
    # by finding nothing, including when the step is renamed out from under it.
    assert checked == 2, f"expected the R install step in both workflows, found {checked}"


def test_EVERY_ci_hard_dependency_gate_runs_even_when_an_earlier_step_failed():
    """#781's other half, asserted over the POPULATION rather than one job.

    The gates are placed LAST so a failing audit cannot cost the test signal. The
    cost of `last` is that every earlier failure skipped them too, so a push
    could land on `main` with its production dependencies never audited —
    failing OPEN. `!cancelled()` keeps the placement and removes the reverse
    coupling.

    ⚠️ **Written as a population assertion for a reason: the first version of
    this fix was PARTIAL.** It conditioned the backend gate and left the
    frontend and electron ones alone, which is the shape that has shipped
    partially three times in this codebase already. A test naming one job would
    have certified that. *Every* hard gate in ci.yml must carry the condition,
    and a job added later is covered without anyone remembering.

    ⛔ **The ADVISORY audit is deliberately excluded** — it is
    `continue-on-error` and non-blocking, so its skipping costs nothing. The rule
    is "hard gates always run, advisory ones are best-effort".

    ⛔ **release.yml is deliberately excluded too.** There a failed step means no
    artifacts and no release, which is already the outcome the gate exists to
    force: it fails CLOSED. The condition would only add a red line to a release
    that is dead regardless. Do not "harmonise" the two (#749).
    """
    from pathlib import Path

    import yaml

    spec = yaml.safe_load(
        (Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml")
        .read_text(encoding="utf-8")
    )
    unconditional = []
    found = 0
    for job_name, job in spec["jobs"].items():
        for step in job.get("steps") or []:
            name = step.get("name") or ""
            if "HARD gate" not in name:
                continue
            found += 1
            if "cancelled()" not in str(step.get("if") or ""):
                unconditional.append(f"{job_name}: {name}")

    # Population self-check (#730): an empty scan passes by finding nothing,
    # including when the steps are renamed out from under this matcher.
    assert found == 3, (
        f"expected three HARD production-dependency gates in ci.yml, found {found} "
        "— a job was added, removed, or its gate renamed."
    )
    assert not unconditional, (
        "these ci.yml hard dependency gates are unconditional, so any earlier "
        f"failure skips them and the push lands unaudited (#781): {unconditional}"
    )
