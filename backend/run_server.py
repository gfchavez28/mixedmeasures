"""PyInstaller entry point for the packaged Mixed Measures backend.

Dev still uses `uvicorn app.main:app`. This script is what the frozen binary runs:
it starts uvicorn programmatically (reload=False, loopback-only) on the port Electron
injects via MM_PORT. See the internal design notes

A gated preflight mode (MM_PREFLIGHT=1) imports the heavy/lazy dependencies the way the
app does at runtime and runs a trivial scipy call, then exits — used by the P0 toolchain
spike to prove those deps survived freezing without standing up the full API.
"""
import os
import sys


def _preflight() -> None:
    """Prove the lazy/native deps bundled correctly. Used by the P0 spike only."""
    import importlib
    import json

    mods = [
        "scipy.stats",
        "numpy",
        "statsmodels.stats.multicomp",
        "docx",                       # python-docx
        "pdfminer.high_level",
        "pdfminer.layout",
        "tinytag",
        "bcrypt",
        "lxml.etree",
        "defusedxml",
        "openpyxl",
        "alembic.command",
    ]
    results: dict[str, str] = {}
    for m in mods:
        try:
            importlib.import_module(m)
            results[m] = "ok"
        except Exception as e:  # noqa: BLE001 — spike diagnostic
            results[m] = f"FAIL: {type(e).__name__}: {e}"

    # Actually run scipy so the native (OpenBLAS) libs are exercised, not just imported.
    try:
        from scipy.stats import ttest_ind

        r = ttest_ind([1.0, 2, 3, 4, 5], [2.0, 3, 4, 5, 7])
        results["scipy_ttest_runs"] = f"t={float(r.statistic):.4f},p={float(r.pvalue):.4f}"
    except Exception as e:  # noqa: BLE001
        results["scipy_ttest_runs"] = f"FAIL: {e}"

    print("PREFLIGHT_RESULT " + json.dumps(results), flush=True)
    ok = all(v == "ok" or v.startswith("t=") for v in results.values())
    sys.exit(0 if ok else 2)


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
