# PyInstaller spec — Mixed Measures backend (P0 toolchain spike: backend only).
# Build from backend/ with the venv active:  pyinstaller mixedmeasures.spec
# Produces an onedir bundle at backend/dist/mm-backend/ (exe: mm-backend).
# P1 will add the built SPA to `datas` (('../frontend/dist','frontend_dist')).
# See the internal design notes
from PyInstaller.utils.hooks import collect_submodules, collect_all

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

hiddenimports = (
    [
        # Lazy / function-local imports in services (belt-and-suspenders; scipy/numpy
        # also have official PyInstaller hooks).
        "scipy.stats",
        "scipy.special",
        "numpy",
        "statsmodels.stats.multicomp",
        "docx",
        "pdfminer.high_level",
        "pdfminer.layout",
        "pdfminer.pdfdocument",
        "tinytag",
        "sqlite3",
        "alembic.config",
        "alembic.command",
        "bcrypt",
        "pydantic_core",
    ]
    + collect_submodules("app")       # ensure every app.* module (incl. models) is bundled
    + collect_submodules("uvicorn")   # uvicorn[standard] loads protocol/loop impls dynamically
    + sqlcipher_hiddenimports         # SQLCipher driver (collected above) — at-rest encryption
    + pyreadstat_hiddenimports        # SPSS .sav reader (compiled submodules)
    + collect_submodules("narwhals")  # pyreadstat's backend layer resolves by dynamic import
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
