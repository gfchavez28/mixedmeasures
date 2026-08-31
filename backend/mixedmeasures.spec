# PyInstaller spec — Mixed Measures backend (P0 toolchain spike: backend only).
# Build from backend/ with the venv active:  pyinstaller mixedmeasures.spec
# Produces an onedir bundle at backend/dist/mm-backend/ (exe: mm-backend).
# P1 will add the built SPA to `datas` (('../frontend/dist','frontend_dist')).
# See the internal design notes
import sys as _sys

from PyInstaller.utils.hooks import collect_submodules, collect_all

# The list of modules that must survive freezing is single-sourced in
# lazy_native_imports.py, which the frozen binary ALSO probes at runtime under
# MM_PREFLIGHT=1 (#858). Keeping the two in one file is the point: they were separate
# hand-maintained lists and neither was a superset of the other. SPECPATH is the spec's
# own directory (backend/), injected by PyInstaller.
_sys.path.insert(0, SPECPATH)  # noqa: F821 — SPECPATH is a PyInstaller spec global
from lazy_native_imports import LAZY_NATIVE_IMPORTS  # noqa: E402

# sqlcipher3 ships SQLCipher 4.12.0 as a compiled C extension plus bundled binaries.
# PyInstaller's static analysis can't find it (database.py imports it lazily and the
# native extension isn't a discoverable Python module), so collect_all() pulls the
# module, its submodules, and the bundled binaries. Without this the frozen backend
# raises ModuleNotFoundError the instant MM_ENCRYPTION_ENABLED=1 (packaging Phase 7).
sqlcipher_datas, sqlcipher_binaries, sqlcipher_hiddenimports = collect_all("sqlcipher3")

# pyreadstat (SPSS .sav import, #28) is a Cython extension imported lazily inside
# services/sav_import.py. collect_all() pulls its compiled submodules
# (_readstat_parser / _readstat_writer) which modulegraph won't reach on its own.
# narwhals is pyreadstat's dataframe-abstraction layer: it resolves backends by
# dynamic import, so its submodules are collected explicitly rather than inferred.
# Without both, the frozen backend raises ModuleNotFoundError on the first .sav upload.
pyreadstat_datas, pyreadstat_binaries, pyreadstat_hiddenimports = collect_all("pyreadstat")

# 🔴 scipy's VENDORED subtree (#858). `scipy/_lib/_array_api.py` reaches
# `scipy._external.array_api_compat` through a dynamic `importlib.import_module`, so
# modulegraph cannot see it and the OFFICIAL scipy hook does not collect it either.
# The result is the worst shape available: every gate passes against source, and the
# frozen app raises `ModuleNotFoundError: scipy._external.array_api_compat.numpy.fft`
# on the FIRST statistical test — i.e. `import scipy.stats` itself fails, so t-test,
# ANOVA, Mann-Whitney and Kruskal-Wallis all 500. Measured on the shipped v1.3.2 and
# v1.4.0 Linux builds; "scipy.stats" in hiddenimports below is NOT sufficient, because
# the name resolves and its own import is what dies.
# ⚠️ Collect the WHOLE `_external` subtree, not just array_api_compat: scipy vendors
# array_api_extra, cobyqa, pyprima and packaging_version there under the same dynamic
# resolution, so pinning the one module that happened to fail would leave the next one
# to be discovered by a user.
scipy_external_hiddenimports = collect_submodules("scipy._external")

hiddenimports = (
    # Lazy / function-local imports in services (belt-and-suspenders; scipy/numpy also
    # have official PyInstaller hooks — but see the scipy._external note above: the hook
    # does NOT reach the vendored subtree). ⚠️ Do NOT re-inline this list here: it is
    # shared with the runtime preflight so a module cannot be bundled-but-unprobed, which
    # is precisely how #858 shipped.
    list(LAZY_NATIVE_IMPORTS)
    # The shared list module itself: run_server.py imports it from INSIDE _preflight(), and
    # relying on modulegraph to follow a function-local import is the very gamble #858 lost.
    + ["lazy_native_imports"]
    + collect_submodules("app")       # ensure every app.* module (incl. models) is bundled
    + collect_submodules("uvicorn")   # uvicorn[standard] loads protocol/loop impls dynamically
    + sqlcipher_hiddenimports         # SQLCipher driver (collected above) — at-rest encryption
    + pyreadstat_hiddenimports        # SPSS .sav reader (compiled submodules)
    + collect_submodules("narwhals")  # pyreadstat's backend layer resolves by dynamic import
    + scipy_external_hiddenimports    # scipy's vendored subtree (#858) — see the note above
)

# Read-only resources the running app needs. Alembic loads versions/*.py via importlib at
# startup, so the whole tree must ship as data (PyInstaller won't collect them as code).
# The built SPA (frontend/dist) ships under "frontend_dist" — config.dist_dir() resolves it
# to <_MEIPASS>/frontend_dist when frozen, and main.py serves it same-origin (P1/P2, §2.4).
# Run `npm run build` in frontend/ before `pyinstaller mixedmeasures.spec` so dist/ is current.
datas = [
    ("alembic.ini", "."),
    ("alembic", "alembic"),
    ("../frontend/dist", "frontend_dist"),
] + sqlcipher_datas + pyreadstat_datas

a = Analysis(
    ["run_server.py"],
    pathex=["."],
    binaries=sqlcipher_binaries + pyreadstat_binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    excludes=["tkinter"],  # unused GUI toolkit; trims weight
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,   # onedir: binaries go in COLLECT, not the exe
    name="mm-backend",
    console=True,            # keep console while debugging the spike; flip to False later
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="mm-backend",
)
