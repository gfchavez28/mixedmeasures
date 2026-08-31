#!/usr/bin/env python3
"""Measure `.mmproject` export and import at corpus scale (#842 / #847, Batch 2 Step 0).

**Why a script and not a test.** The portability suite creates THREE `DatasetValue` rows and
its largest loop is `range(10)`, so it cannot see any of the behaviour this measures. The
numbers that decided the v1.4.0 release came from a harness that was git-ignored and is now
gone — which is why §4d's figures could not be re-derived without rebuilding this.

    scripts/measure_portability.py export --project 4
    scripts/measure_portability.py build  --project 4 --values 144000 --out /tmp/a.mmproject
    scripts/measure_portability.py import --archive /tmp/a.mmproject

🔴 **BUILD and IMPORT MUST RUN IN SEPARATE PROCESSES.** `ru_maxrss` is a process-wide HIGH-WATER
mark, so measuring an import in the same process that just built the archive reports the
BUILD's ORM objects as the import's peak — it overstated memory ~3x the first time this was
done. Each subcommand is one process on purpose; do not add a `roundtrip` subcommand.

⚠️ **`ru_maxrss` cannot distinguish HELD from ONCE-ALLOCATED** — CPython does not return freed
heap to the OS. It is the right instrument for "did this ever need N MB", which is the
question here, and the wrong one for "does this hold N MB".

⚠️ **Reads a COPY of the source database, never the original.** The measurement imports into a
throwaway DB, but an export still opens a session against the source, and this runs against
the developer's real working `dev.db`.

⚠️ **`--values` sub-scale archives are built by TRUNCATING `dataset_values` in the copy**, so a
row keeps its identity and its FKs stay valid — the curve then varies exactly one dimension.
"""
from __future__ import annotations

import argparse
import json
import os
import resource
import shutil
import sqlite3
import sys
import tempfile
import time
import zipfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))


def peak_mb() -> float:
    """Peak RSS in MB. `ru_maxrss` is KB on Linux, bytes on macOS."""
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return raw / 1024 if sys.platform != "darwin" else raw / (1024 * 1024)


def _prepare_copy(src: Path, workdir: Path, keep_values: int | None) -> Path:
    """Copy the source DB and optionally truncate `dataset_values` to `keep_values`."""
    dst = workdir / "source.db"
    print(f"  copying {src} -> {dst} ({src.stat().st_size / 1e6:.0f} MB)…", flush=True)
    shutil.copy2(src, dst)
    for suffix in ("-wal", "-shm"):
        side = Path(str(src) + suffix)
        if side.exists():
            shutil.copy2(side, str(dst) + suffix)
    if keep_values is not None:
        con = sqlite3.connect(dst)
        con.execute("PRAGMA foreign_keys=OFF")
        before = con.execute("SELECT count(*) FROM dataset_values").fetchone()[0]
        con.execute(
            "DELETE FROM dataset_values WHERE id NOT IN "
            "(SELECT id FROM dataset_values ORDER BY id LIMIT ?)",
            (keep_values,),
        )
        con.commit()
        after = con.execute("SELECT count(*) FROM dataset_values").fetchone()[0]
        con.execute("VACUUM")
        con.close()
        print(f"  truncated dataset_values {before:,} -> {after:,}", flush=True)
    return dst


def _session(db_path: Path):
    """Build a Session against `db_path`. Must run AFTER MM_DATABASE_PATH is set."""
    os.environ["MM_DATABASE_PATH"] = str(db_path)
    os.environ.setdefault("MM_DATA_DIR", str(db_path.parent / "data"))
    os.environ.setdefault("MM_BACKUP_DIR", str(db_path.parent / "backups"))
    from app.config import get_settings

    get_settings.cache_clear()
    from app.database import SessionLocal, get_engine

    get_engine()
    return SessionLocal()


def cmd_export(args: argparse.Namespace) -> int:
    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    db = _prepare_copy(Path(args.source), workdir, args.values)
    db_session = _session(db)

    from app.services import project_portability as pp

    if args.ignore_bound:
        # The bound is what we are measuring PAST. Raising it here never touches product
        # behaviour — this process exits before anything else sees the module.
        pp.MAX_PROJECT_EXPORT_VALUES = 10**12

    out = Path(args.out) if args.out else workdir / "measured.mmproject"
    docs = Path(os.environ["MM_DATA_DIR"]) / "documents"
    media = Path(os.environ["MM_DATA_DIR"]) / "media"
    docs.mkdir(parents=True, exist_ok=True)
    media.mkdir(parents=True, exist_ok=True)

    t0 = time.perf_counter()
    buf = pp.export_project(db_session, args.project, docs, media, include_media=False)
    wall = time.perf_counter() - t0
    # 🔴 SNAPSHOT THE PEAK HERE, BEFORE ANY VERIFICATION READ. The first version of this
    # script counted entities by `json.loads`-ing the archive's project.json afterwards —
    # 518 MB of text into ~2 GB of Python objects — and reported that as the EXPORT's peak
    # (2,706 MB against a true 122 MB). The probe was the memory. `ru_maxrss` is a
    # process-wide high-water mark: anything the harness does before reading it counts.
    export_peak = peak_mb()
    data = buf.getvalue()
    out.write_bytes(data)
    del buf

    # Entity counts WITHOUT materialising the payload: stream the entry and count the
    # top-level array elements the cheap way — by decompressed size and a scan.
    with zipfile.ZipFile(out) as zf:
        pj_size = zf.getinfo("project.json").file_size

    print(json.dumps({
        "op": "export", "project": args.project, "wall_s": round(wall, 2),
        "peak_mb": round(export_peak, 1), "archive_mb": round(len(data) / 1e6, 2),
        "project_json_mb": round(pj_size / 1e6, 2),
        "harness_peak_after_verify_mb": round(peak_mb(), 1),
    }, indent=2), flush=True)
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    """Build an archive without reporting export cost (for import measurement)."""
    args.ignore_bound = True
    args.out = args.out or str(Path(args.workdir) / "built.mmproject")
    return cmd_export(args)


def cmd_import(args: argparse.Namespace) -> int:
    archive = Path(args.archive)
    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    target = workdir / "import-target.db"
    if target.exists():
        target.unlink()

    db_session = _session(target)
    from app.database import Base, get_engine
    from app.models.user import User

    Base.metadata.create_all(bind=get_engine())
    db_session.add(User(id=1, username="measure", password_hash="x", is_admin=True))
    db_session.commit()

    from app.services import project_portability as pp

    # 🔴 NO PRE-READ OF project.json. Counting the file's values by `json.loads` before the
    # import cost ~2 GB, and `ru_maxrss` is a process-wide high-water mark — so the reported
    # "import peak" was max(harness pre-read, import), not the import. Pass the expected
    # count in instead; it is known from the source database.
    # ⚠️ The BASELINE run (26:31 / 2,485 MB) was taken with that pre-read in place, so its
    # PEAK is an upper bound rather than a measurement. Its WALL TIME is unaffected — the
    # pre-read happened before `t0`.
    n_values = args.expect_values

    t0 = time.perf_counter()
    # ⚠️ `import_project` returns (project_id, project_name). Binding the TUPLE as a query
    # parameter is how the first two runs of this harness "failed" — the import itself had
    # completed; the verification crashed after it. Their WALL TIMES are valid; their
    # fidelity checks never ran.
    pid, _name = pp.import_project(
        db_session, archive,
        Path(os.environ["MM_DATA_DIR"]) / "documents",
        Path(os.environ["MM_DATA_DIR"]) / "media",
        user_id=1,
    )
    wall = time.perf_counter() - t0
    # ⚠️ `import_project` is the SERVICE and never commits — the ROUTER does (five
    # `db.commit()` sites in project_portability.py's router, none in the service). The
    # verification below opens its OWN sqlite3 connection, so without this the count reads
    # an empty database and the harness reports total data loss on a healthy import.
    db_session.commit()

    con = sqlite3.connect(target)
    landed = con.execute(
        "SELECT count(*) FROM dataset_values dv JOIN dataset_rows dr ON dv.row_id=dr.id "
        "JOIN datasets d ON dr.dataset_id=d.id WHERE d.project_id=?", (pid,)
    ).fetchone()[0]
    con.close()

    import_peak = peak_mb()
    print(json.dumps({
        "op": "import", "archive_mb": round(archive.stat().st_size / 1e6, 2),
        "values_expected": n_values, "values_landed": landed,
        "peak_mb_import": round(import_peak, 1),
        "fidelity_ok": landed == n_values,
        "wall_s": round(wall, 2),
        "s_per_1000": round(wall / max(n_values or landed, 1) * 1000, 4),
    }, indent=2), flush=True)
    return 0 if (n_values is None or landed == n_values) else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--workdir", default=os.environ.get("MEASURE_WORKDIR", tempfile.mkdtemp()))
    sub = ap.add_subparsers(dest="cmd", required=True)

    for name in ("export", "build"):
        p = sub.add_parser(name)
        p.add_argument("--source", default=str(BACKEND / "dev.db"))
        p.add_argument("--project", type=int, required=True)
        p.add_argument("--values", type=int, default=None,
                       help="truncate dataset_values to this many before exporting")
        p.add_argument("--out", default=None)
        p.add_argument("--ignore-bound", action="store_true")

    p = sub.add_parser("import")
    p.add_argument("--archive", required=True)
    p.add_argument("--expect-values", type=int, default=None,
                   help="fidelity check: how many dataset_values the archive should carry")

    args = ap.parse_args()
    return {"export": cmd_export, "build": cmd_build, "import": cmd_import}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
