"""Single-sourced R-availability detection for the correctness-oracle tests.

Five test files run **real R** as an EXTERNAL ORACLE — the only check that the
tool's statistics agree with an independent implementation:

    test_export_r_roundtrip.py   the #402 round-trip (does the exported .R
                                 reproduce the tool's own numbers?)
    test_export_r_irr.py         the exported IRR block vs `compute_irr`
    test_irr.py                  Krippendorff alpha / Cohen kappa vs `irr::`
    test_open_cut_reliability.py time-binned kappa vs `irr::kappa2`
    test_export_r_runnable.py    parse-only (the .R is syntactically valid)

Before #642 each file made this decision for itself, in three different shapes
(`_r_has_irr()` copy-pasted three times, a bare `shutil.which("Rscript")` in
three decorators, and one INLINE `pytest.skip()` that no decorator scan could
see). This module is the one place that decision lives.

**Why the strict mode below is load-bearing.** These tests SKIP when R is
absent, and a skip is silent — that is #642: neither CI workflow installed R,
so 21 oracle tests went dark on the machine that hard-gates releases while the
run reported green. Installing R fixes today's instance; it does not fix the
class, because `_probe_missing_packages()` deliberately swallows every failure
(a half-broken R must not crash collection on a developer laptop). So CI sets
`MM_REQUIRE_R=1` and `test_r_oracle_availability.py` turns "the oracles are
missing" into a LOUD failure. Unset — the local default — behavior is exactly
as before: the tests skip and the developer needs no R at all.
"""

from __future__ import annotations

import os
import shutil
import subprocess

# `irr` is called directly by the reliability oracles; the other four are what
# the exported .R itself loads (`export_r.py::required_packages`). All five must
# be present in CI: the exported script bootstraps missing packages with
# `install.packages()`, so a package absent at test time triggers a CRAN source
# build INSIDE the test — slow, network-dependent, and a job-timeout risk.
REQUIRED_R_PACKAGES: tuple[str, ...] = ("readr", "dplyr", "psych", "ggplot2", "irr")

#: Absolute path to Rscript, or None when R is not installed.
RSCRIPT: str | None = shutil.which("Rscript")

# Set when the probe itself failed (R present but broken/timing out) so the
# strict guard can report the cause instead of a bare "packages missing".
_PROBE_ERROR: str | None = None


def _probe_missing_packages() -> tuple[str, ...]:
    """Return the REQUIRED_R_PACKAGES that R cannot load.

    Returns all of them when R is absent or the probe fails. One Rscript call,
    made once at import — five separate calls cost ~1s of suite time each.
    """
    global _PROBE_ERROR

    if not RSCRIPT:
        return REQUIRED_R_PACKAGES

    pkg_vector = ", ".join(f'"{p}"' for p in REQUIRED_R_PACKAGES)
    expr = (
        f"cat(paste(Filter(function(p) !requireNamespace(p, quietly = TRUE), "
        f"c({pkg_vector})), collapse = \" \"))"
    )
    try:
        out = subprocess.run(
            [RSCRIPT, "--vanilla", "-e", expr],
            capture_output=True, text=True, timeout=120,
        )
    except Exception as exc:                      # noqa: BLE001 — see module docstring
        _PROBE_ERROR = f"{type(exc).__name__}: {exc}"
        return REQUIRED_R_PACKAGES

    if out.returncode != 0:
        _PROBE_ERROR = f"Rscript exited {out.returncode}: {out.stderr.strip()[:400]}"
        return REQUIRED_R_PACKAGES

    missing = tuple(p for p in out.stdout.split() if p in REQUIRED_R_PACKAGES)
    return missing


MISSING_R_PACKAGES: tuple[str, ...] = _probe_missing_packages()

#: Rscript is on PATH (enough for the parse-only and round-trip tests, which
#: load only what the exported script itself declares).
HAS_R: bool = RSCRIPT is not None

#: Rscript AND the `irr` package — required by the reliability oracles.
HAS_IRR: bool = HAS_R and "irr" not in MISSING_R_PACKAGES

# Reason strings for `pytest.mark.skipif`. Kept verbatim from the pre-#642
# decorators so skip output is unchanged for anyone reading old logs.
SKIP_REASON_R = "Rscript not available"
SKIP_REASON_IRR = "Rscript + irr package not available"


def r_is_required() -> bool:
    """True when this run must FAIL rather than skip if R is missing.

    Read at call time, not import time, so a test can monkeypatch the env.
    """
    return os.environ.get("MM_REQUIRE_R", "").strip().lower() in {"1", "true", "yes"}


def unavailability_report() -> str | None:
    """A developer-facing explanation of what is missing, or None if all present.

    Names the exact remedy — this string is what a red release gate shows, and
    the fix is not guessable from "irr not available".
    """
    if HAS_R and not MISSING_R_PACKAGES:
        return None

    lines: list[str] = []
    if not HAS_R:
        lines.append("Rscript is not on PATH — R is not installed.")
    else:
        lines.append(f"Rscript found at {RSCRIPT}, but packages are missing.")
    if MISSING_R_PACKAGES:
        lines.append(f"Missing R packages: {', '.join(MISSING_R_PACKAGES)}")
    if _PROBE_ERROR:
        lines.append(f"Package probe failed — {_PROBE_ERROR}")
    lines.append(
        "Install on Debian/Ubuntu (binaries, plus one pure-R package from CRAN\n"
        "— Debian has never packaged `irr`, so there is no r-cran-irr):\n"
        "    sudo apt-get install -y --no-install-recommends \\\n"
        "        r-base-core r-cran-readr r-cran-dplyr r-cran-psych \\\n"
        "        r-cran-ggplot2 r-cran-lpsolve\n"
        "    Rscript -e 'install.packages(\"irr\", repos = \"https://cloud.r-project.org\")'"
    )
    return "\n".join(lines)
