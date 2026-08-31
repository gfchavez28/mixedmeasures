"""PyInstaller entry point for the packaged Mixed Measures backend.

Dev still uses `uvicorn app.main:app`. This script is what the frozen binary runs:
it starts uvicorn programmatically (reload=False, loopback-only) on the port Electron
injects via MM_PORT. See the internal design notes

A gated preflight mode (MM_PREFLIGHT=1) imports the heavy/lazy dependencies the way the
app does at runtime and runs a real scipy computation, then exits — proving those deps
survived freezing without standing up the full API.

🔴 **RUN IT IN CI AND BY HAND — this mode existed from packaging P0 and had ZERO callers
until 2026-08-30.** It imports `scipy.stats` and executes a t-test, so it would have failed
the v1.3.2 and v1.4.0 builds on the spot; instead #858 shipped twice and was found by a
hand-run smoke four days after release. A capability nothing invokes is not a guard. It now
runs as a step in `release.yml`'s frozen-bundle smoke, and `RELEASING` §4b names it as a
hand-runnable check against an extracted build:

    MM_PREFLIGHT=1 ./dist/mm-backend/mm-backend

The module list is single-sourced in `lazy_native_imports.py` — see that file for why the
list, not scipy, is the actual defect this guards.
"""
import os
import sys


def _preflight() -> None:
    """Prove the lazy/native deps bundled correctly, inside the frozen bundle."""
    import json

    from lazy_native_imports import run_probes

    results = run_probes()
    failures = [(name, status) for name, status in results if status != "ok"]

    # Human-readable first: this is run by hand at RELEASING §4b, against an extracted
    # build, by someone deciding whether to publish.
    for name, status in results:
        print(f"  {'ok  ' if status == 'ok' else 'FAIL'}  {name}"
              + ("" if status == "ok" else f"  — {status}"), flush=True)
    # Machine-readable second, on one line, so CI and scripts need no parsing of the above.
    print("PREFLIGHT_RESULT " + json.dumps(dict(results)), flush=True)

    if failures:
        print(f"\n❌ preflight: {len(failures)} of {len(results)} probes failed — the frozen "
              f"bundle is missing a dependency it needs at runtime (#858). Add it to "
              f"lazy_native_imports.LAZY_NATIVE_IMPORTS and/or collect it in "
              f"mixedmeasures.spec.", flush=True)
        sys.exit(2)
    print(f"\n✅ preflight: all {len(results)} probes passed (imports + a real scipy "
          f"computation).", flush=True)
    sys.exit(0)


def main() -> None:
    if os.environ.get("MM_PREFLIGHT") == "1":
        _preflight()
        return

    import uvicorn
    from app.main import app

    port = int(os.environ.get("MM_PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, reload=False, log_level="info")


if __name__ == "__main__":
    main()
