"""The statistics you are testing must be the statistics that ship.

**The incident this exists to prevent (2026-08-13).** `requirements.txt` declared
`scipy>=1.10.0,<2.0.0`. CI installs fresh and resolved **1.18.0**; the dev venv
had been sitting on **1.17.0** since before 1.18 was published. The two disagree
about `mannwhitneyu` on all-tied input — 1.17 returns `p=1.0`, 1.18 returns `nan`
— so one test failed on the clean machine and passed locally.

It stayed that way for **five consecutive pushes across four sessions**, every one
of which ended by running the full suite and reporting it green. A local suite is
evidence about the local environment and nothing else, and nobody looked at CI.

Two things follow, and this file pins the second:

1. the numbers stack is EXACT-pinned, for reproducibility rather than security —
   a range means the installer ships whatever the build machine resolved that day,
   so two builds from identical source can compute different statistics;
2. **a venv that has drifted from those pins must say so**, because otherwise the
   pin only protects the build and the suite keeps testing something else.

⚠️ Deliberately scoped to the three packages that PRODUCE NUMBERS. A general
"every pin matches" check would fail on any unrelated patch drift and get muted,
which is how a guard dies. If a fourth library starts computing statistics, add it
here — `PINNED` is what makes this test non-vacuous, so it is asserted too.
"""
from __future__ import annotations

import importlib
import re
from pathlib import Path

import pytest

REQUIREMENTS = Path(__file__).resolve().parents[1] / "requirements.txt"

#: The packages whose version changes the app's OUTPUT, not just its behaviour.
NUMBERS_STACK = ("numpy", "scipy", "statsmodels")


def _declared_pins() -> dict[str, str]:
    """Exact (`==`) pins for the numbers stack, read from the shipped file.

    Read rather than mirrored, for the reason every guard in this repo gives: a
    table of expected values keeps passing while the artifact moves underneath it.
    """
    text = REQUIREMENTS.read_text(encoding="utf-8")
    pins: dict[str, str] = {}
    for name in NUMBERS_STACK:
        match = re.search(rf"^{name}==([0-9][^\s#]*)", text, re.MULTILINE)
        if match:
            pins[name] = match.group(1)
    return pins


def test_the_numbers_stack_is_exact_pinned():
    """A RANGE here is the defect, not a looser style choice."""
    pins = _declared_pins()
    missing = [name for name in NUMBERS_STACK if name not in pins]
    assert not missing, (
        f"{', '.join(missing)} is not EXACT-pinned (`name==x.y.z`) in requirements.txt. "
        "A range means the shipped installer computes with whatever the build machine "
        "resolved that day — see this file's docstring for what that cost."
    )
    # Population (#730): the loop below is vacuous if NUMBERS_STACK is ever emptied,
    # and this test would then pass by checking nothing.
    assert len(pins) == len(NUMBERS_STACK) == 3


@pytest.mark.parametrize("name", NUMBERS_STACK)
def test_the_installed_version_matches_the_pin(name: str):
    """Your venv computes what the clean machine computes, or the suite says so.

    This is the half that was missing. The pin alone protects the build; without
    this, a stale venv keeps testing a different library and reporting green.
    """
    declared = _declared_pins().get(name)
    assert declared, f"{name} has no exact pin — see the test above"

    installed = importlib.import_module(name).__version__
    assert installed == declared, (
        f"{name} {installed} is installed but requirements.txt pins {declared}.\n"
        "Your results are not the shipped results. Run:\n"
        "    pip install -r requirements.txt\n"
        "If you meant to UPGRADE, change the pin deliberately, bump the three "
        "together, and re-run the R round-trip oracles (test_export_r_roundtrip.py) "
        "— they are what prove the numbers did not move."
    )
