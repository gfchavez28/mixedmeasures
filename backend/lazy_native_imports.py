"""THE list of modules the frozen bundle must be able to import — single-sourced.

**Why this file exists (#858, 2026-08-27).** `scipy/_lib/_array_api.py` reaches scipy's
vendored `_external` subtree through a dynamic `importlib.import_module`, which
modulegraph cannot follow and the official PyInstaller hook does not collect. The result
is the worst shape available: `import scipy.stats` resolves as a NAME and dies in its own
import body, so every statistical test 500s in the packaged app while 2,858 backend tests,
39 green CI steps and a signed build all agree the release is fine. It shipped in v1.3.2
and v1.4.0 before a hand-run smoke found it.

**The defect this file prevents is not scipy — it is the ENUMERATION.** "Which modules must
survive freezing" was written down THREE times: `mixedmeasures.spec`'s `hiddenimports`,
`run_server.py::_preflight`'s own list, and reality. Measured 2026-08-30: **neither written
list was a superset of the other** — the spec lacked `lxml.etree` / `defusedxml` /
`openpyxl`, and preflight lacked `sqlcipher3` / `pyreadstat` / `narwhals` /
`scipy.special`. Two enumerations of one set, silently disagreeing, is the project's named
*enumeration debt*; the remedy it also names is to derive the enumeration from the artifact
the next variant must touch. That artifact is this tuple: the spec bundles it and the
preflight probes it, so a module cannot be bundled-but-unprobed or probed-but-unbundled.

⚠️ **STDLIB ONLY, and no `app.*` import.** `mixedmeasures.spec` imports this at BUILD time,
before PyInstaller analyses anything; pulling the application in here would execute app code
inside the build. Keep it dependency-free.

⚠️ **A name in a list proves nothing — the probe must IMPORT it.** `"scipy.stats"` was in
`hiddenimports` throughout #858 and the app was still broken, because the name resolved and
its body raised. That is why `run_probes()` calls `importlib.import_module` and then
EXECUTES a statistic, rather than asserting membership.

Consumed by:
  - ``mixedmeasures.spec``            → ``hiddenimports`` (build time)
  - ``run_server.py::_preflight``     → ``MM_PREFLIGHT=1`` (runtime, inside the bundle)
  - ``tests/test_frozen_preflight_arity.py`` → the arity guard (source → this list)
"""
from __future__ import annotations

import importlib

#: Modules the packaged app imports LAZILY (inside a function) or DYNAMICALLY, so
#: PyInstaller's static analysis may miss them. Every entry is both bundled by the spec and
#: probed by the preflight.
#:
#: ⚠️ **This list is a deliberate SUPERSET of what a source scan can derive.**
#: `tests/test_frozen_preflight_arity.py` walks `app/` for function-local third-party
#: imports and requires each to appear here — that is the floor, not the ceiling. Entries
#: like `defusedxml`, `lxml.etree` and `bcrypt` are reached at module level or through a
#: dependency (lxml arrives via python-docx), and are probed because freezing can miss them
#: just as easily. Over-probing costs milliseconds; under-probing costs a release.
LAZY_NATIVE_IMPORTS: tuple[str, ...] = (
    # ── statistics ────────────────────────────────────────────────────────────────
    "scipy.stats",                    # #858 — the one that shipped broken twice
    "scipy.special",
    "numpy",
    "statsmodels.stats.multicomp",    # Tukey HSD
    # ── data / document parsing (all lazy-imported adapters) ──────────────────────
    "pyreadstat",                     # SPSS .sav (#28) — Cython extension
    "narwhals",                       # pyreadstat's backend layer, dynamic resolution
    "openpyxl",                       # .xlsx import (#523) + Excel export
    "docx",                           # python-docx
    "pdfminer.high_level",
    "pdfminer.layout",
    "pdfminer.pdfdocument",
    "tinytag",                        # audio duration / VBR
    "lxml.etree",                     # transitive via python-docx
    "defusedxml",                     # untrusted XML parsing
    # ── storage / platform ────────────────────────────────────────────────────────
    "sqlcipher3",                     # at-rest encryption in the packaged app ONLY
    "sqlite3",
    "alembic.config",
    "alembic.command",
    "bcrypt",
    "pydantic_core",
)

#: Top-level packages that appear as function-local imports in `app/` but are deliberately
#: NOT probed, with the reason. Read by the arity guard; an entry that stops being
#: reachable from a function-local import fails that test as stale.
#:
#: The framework three are proven by something stronger than a probe: if any of them failed
#: to freeze, the app would not boot and the smoke's `/health` check would never go green.
#: Probing them would add a check whose only failure mode is already covered.
PROBE_EXEMPT: dict[str, str] = {
    "fastapi": "proven by boot — the smoke's /health 200 cannot happen without it",
    "sqlalchemy": "proven by boot — startup runs Alembic against a real DB",
    "starlette": "proven by boot — FastAPI's own transitive base",
}


def run_probes() -> list[tuple[str, str]]:
    """Import every listed module, then EXECUTE a statistic. Returns [(probe, status)].

    A status of exactly ``"ok"`` is the only pass. Two arms, deliberately:

    1. **Import** every name — this is what catches #858's class, where a module's own
       import body raises because a dynamically-resolved subtree was not collected.
    2. **Execute** ``scipy.stats.ttest_ind`` on literals — this exercises the native
       (OpenBLAS) libraries rather than only the Python wrapper, and it CANNOT be
       degenerate. ⚠️ That last property is load-bearing: the committed `.sav` fixture is
       4 rows, so a group comparison over it has a group of n=1, and an undefined
       statistic returns ``None`` *before* reaching scipy — an HTTP smoke built on that
       fixture would pass against a bundle with scipy missing entirely.
    """
    results: list[tuple[str, str]] = []
    for name in LAZY_NATIVE_IMPORTS:
        try:
            importlib.import_module(name)
            results.append((name, "ok"))
        except BaseException as exc:  # noqa: BLE001 — a diagnostic reports, never raises
            results.append((name, f"FAIL: {type(exc).__name__}: {exc}"))

    try:
        from scipy.stats import ttest_ind

        r = ttest_ind([1.0, 2, 3, 4, 5], [2.0, 3, 4, 5, 7])
        t, p = float(r.statistic), float(r.pvalue)
        # A real computation, not just a call that returned: NaN is what a degenerate
        # input produces, and it must not read as success.
        if t != t or p != p:  # NaN
            results.append(("scipy.stats:ttest_ind", "FAIL: returned NaN"))
        else:
            results.append(("scipy.stats:ttest_ind", "ok"))
    except BaseException as exc:  # noqa: BLE001
        results.append(("scipy.stats:ttest_ind", f"FAIL: {type(exc).__name__}: {exc}"))

    return results
