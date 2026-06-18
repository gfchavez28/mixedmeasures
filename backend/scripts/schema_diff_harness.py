#!/usr/bin/env python3
"""Schema-drift gate: ORM models vs. the Alembic migration chain.

Build one SQLite DB by running the full `alembic upgrade head` chain and another by
`Base.metadata.create_all()` from the ORM models, then diff their *structure* —
tables, columns, indexes (including UNIQUE + partial `WHERE`), and CHECK-constraint
text. The accepted gate is **zero structural diff**: the models and the migrations
must describe the same schema.

Why it exists: the test suite builds its schema via `create_all()` (tests/conftest.py),
so it never exercises the migration path — green tests are necessary but not
sufficient to prove that a fresh install (which runs the migrations) gets the right
schema. A model change landed without a matching migration passes every test and
breaks only fresh installs; this harness is the only thing that catches it. It runs
in CI and as a pre-build gate.

Usage (from backend/, venv active):
    python scripts/schema_diff_harness.py
    python scripts/schema_diff_harness.py --keep        # leave the temp DBs on disk
    python scripts/schema_diff_harness.py --json out.json

Exit code 0 = schemas identical, 1 = differences found, 2 = harness/build error.

PRAGMA does not surface CHECK constraints, so this harness parses them out of
sqlite_master.sql by text — exactly the autogenerate blind spot the gate guards
against.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
# Running `python scripts/foo.py` puts scripts/ on sys.path, not backend/ —
# make `import app.*` resolve when invoked from anywhere.
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# alembic_version is bookkeeping; sqlite_* are engine-internal.
IGNORE_TABLES = {"alembic_version"}


# ── DB builders ──────────────────────────────────────────────────────────────

def build_alembic_db(db_path: Path) -> None:
    """Run the full migration chain into a fresh SQLite file (subprocess for env
    isolation — env.py reads MM_DATABASE_PATH via the cached get_settings())."""
    env = dict(os.environ)
    env["MM_DATABASE_PATH"] = str(db_path)
    # Keep any accidental pre-migration backup out of the real backup dir.
    env["MM_BACKUP_DIR"] = str(db_path.parent / "backups")
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"`alembic upgrade head` failed (exit {proc.returncode}):\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        )


def build_models_db(db_path: Path) -> None:
    """Create the schema directly from the ORM models (what the squash baseline
    will encode)."""
    # Point app config at this file before importing app modules so the module
    # engine and our create_all target agree (and never touch the real dev.db).
    os.environ["MM_DATABASE_PATH"] = str(db_path)
    from sqlalchemy import create_engine, event

    from app.database import Base
    import app.models  # noqa: F401  (populate Base.metadata)

    engine = create_engine(f"sqlite:///{db_path}")

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _):  # pragma: no cover - trivial
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    engine.dispose()


# ── Introspection ──────────────────────────────────────────────────────────

def _norm(sql: str | None) -> str:
    """Collapse whitespace so cosmetic spacing/newlines don't read as a diff."""
    if not sql:
        return ""
    return re.sub(r"\s+", " ", sql).strip()


def _extract_checks(table_sql: str | None) -> list[str]:
    """Pull CHECK(...) clauses out of a CREATE TABLE statement, balancing parens.
    Returns normalized inner-expression text (named or anonymous), sorted."""
    if not table_sql:
        return []
    text = table_sql
    checks: list[str] = []
    for m in re.finditer(r"CHECK\s*\(", text, flags=re.IGNORECASE):
        i = m.end() - 1  # position of the opening paren
        depth = 0
        for j in range(i, len(text)):
            if text[j] == "(":
                depth += 1
            elif text[j] == ")":
                depth -= 1
                if depth == 0:
                    inner = text[i + 1 : j]
                    checks.append(_norm(inner))
                    break
    return sorted(checks)


def introspect(db_path: Path) -> dict:
    """Return a structural snapshot: per-table columns + check constraints, and a
    name-agnostic index signature set."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    tables: dict[str, dict] = {}
    rows = cur.execute(
        "SELECT name, sql FROM sqlite_master "
        "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    for r in rows:
        name = r["name"]
        if name in IGNORE_TABLES:
            continue
        columns = {}
        for c in cur.execute(f'PRAGMA table_info("{name}")').fetchall():
            columns[c["name"]] = {
                "type": (c["type"] or "").upper(),
                "notnull": bool(c["notnull"]),
                "default": c["dflt_value"],
                "pk": bool(c["pk"]),
            }
        tables[name] = {
            "columns": columns,
            "checks": _extract_checks(r["sql"]),
        }

    # Index signatures — name-agnostic, so a dropped partial WHERE or a lost
    # UNIQUE shows up even if the index keeps its name. We capture every index
    # SQLite knows about (explicit CREATE INDEX, UNIQUE constraints, auto), and
    # pull the partial WHERE text from sqlite_master for explicit ones.
    explicit_sql = {
        r["name"]: r["sql"]
        for r in cur.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='index'"
        ).fetchall()
        if r["sql"]
    }

    def _where_of(idx_name: str) -> str:
        sql = explicit_sql.get(idx_name)
        if not sql:
            return ""
        m = re.search(r"\bWHERE\b(.*)$", sql, flags=re.IGNORECASE | re.DOTALL)
        return _norm(m.group(1)) if m else ""

    index_sigs: set[tuple] = set()
    index_by_name: dict[str, dict] = {}
    for tname in tables:
        for il in cur.execute(f'PRAGMA index_list("{tname}")').fetchall():
            idx_name = il["name"]
            cols = tuple(
                ii["name"]
                for ii in cur.execute(
                    f'PRAGMA index_info("{idx_name}")'
                ).fetchall()
            )
            sig = {
                "table": tname,
                "columns": cols,
                "unique": bool(il["unique"]),
                "partial": bool(il["partial"]),
                "where": _where_of(idx_name),
                "origin": il["origin"],  # c / u / pk
            }
            index_by_name[idx_name] = sig
            index_sigs.add(
                (tname, cols, sig["unique"], sig["partial"], sig["where"])
            )

    conn.close()
    return {
        "tables": tables,
        "index_sigs": index_sigs,
        "index_by_name": index_by_name,
    }


# ── Diffing ──────────────────────────────────────────────────────────────────

def diff_schemas(alembic: dict, models: dict) -> list[str]:
    """Return a list of human-readable difference lines (empty == identical).
    'A' = alembic-chain DB, 'B' = create_all/models DB."""
    out: list[str] = []
    a_tables, b_tables = alembic["tables"], models["tables"]

    for t in sorted(set(a_tables) - set(b_tables)):
        out.append(f"TABLE only in alembic-chain (will be DROPPED by baseline): {t}")
    for t in sorted(set(b_tables) - set(a_tables)):
        out.append(f"TABLE only in models (will be ADDED by baseline): {t}")

    for t in sorted(set(a_tables) & set(b_tables)):
        ac, bc = a_tables[t]["columns"], b_tables[t]["columns"]
        for col in sorted(set(ac) - set(bc)):
            out.append(f"[{t}] column only in alembic-chain: {col}")
        for col in sorted(set(bc) - set(ac)):
            out.append(f"[{t}] column only in models: {col}")
        for col in sorted(set(ac) & set(bc)):
            for attr in ("type", "notnull", "default", "pk"):
                av, bv = ac[col][attr], bc[col][attr]
                if av != bv:
                    out.append(
                        f"[{t}.{col}] {attr}: alembic={av!r} models={bv!r}"
                    )
        a_checks, b_checks = a_tables[t]["checks"], b_tables[t]["checks"]
        for ck in sorted(set(a_checks) - set(b_checks)):
            out.append(f"[{t}] CHECK only in alembic-chain: {ck}")
        for ck in sorted(set(b_checks) - set(a_checks)):
            out.append(f"[{t}] CHECK only in models: {ck}")

    # Name-agnostic index signatures (catches lost WHERE / lost UNIQUE).
    only_a = alembic["index_sigs"] - models["index_sigs"]
    only_b = models["index_sigs"] - alembic["index_sigs"]
    for sig in sorted(str(s) for s in only_a):
        out.append(f"INDEX signature only in alembic-chain: {sig}")
    for sig in sorted(str(s) for s in only_b):
        out.append(f"INDEX signature only in models: {sig}")

    # Name-level report (cosmetic-only when signatures match): the squash names
    # indexes from the models, so a name that exists in one but not the other is
    # a rename to be aware of even when the structure is identical.
    a_names, b_names = set(alembic["index_by_name"]), set(models["index_by_name"])
    for n in sorted(a_names - b_names):
        out.append(f"INDEX name only in alembic-chain (rename/drop by baseline): {n}")
    for n in sorted(b_names - a_names):
        out.append(f"INDEX name only in models (renamed/added by baseline): {n}")

    return out


# ── Main ───────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--keep", action="store_true", help="keep the temp DB files")
    ap.add_argument("--json", type=Path, help="write the diff list to this JSON file")
    args = ap.parse_args()

    tmpdir = Path(tempfile.mkdtemp(prefix="mm_schema_diff_"))
    alembic_db = tmpdir / "alembic_head.db"
    models_db = tmpdir / "models_create_all.db"

    try:
        # alembic build first (subprocess) — it must run before we import app
        # modules in-process and pin MM_DATABASE_PATH for the models build.
        print("Building alembic-chain DB (`alembic upgrade head`)...", file=sys.stderr)
        build_alembic_db(alembic_db)
        print("Building models DB (`create_all`)...", file=sys.stderr)
        build_models_db(models_db)
    except Exception as exc:  # noqa: BLE001
        print(f"HARNESS ERROR: {exc}", file=sys.stderr)
        return 2

    diffs = diff_schemas(introspect(alembic_db), introspect(models_db))

    if args.json:
        args.json.write_text(json.dumps(diffs, indent=2))

    if not diffs:
        print("\n✅ ZERO structural diff between alembic-chain and models.")
        result = 0
    else:
        print(f"\n❌ {len(diffs)} structural difference(s) found:\n")
        for line in diffs:
            print(f"  • {line}")
        print(
            "\nInterpret against the internal design notes:\n"
            "  • Pre-squash run: expect ONLY the deliberate Group 2/3 changes\n"
            "    (source_tab 40, +2 excerpt indexes, −2 dead canvas tables, legacy\n"
            "    duplicate-index drops). Anything else is unreconciled drift.\n"
            "  • Post-squash run (baseline vs models): expect ZERO."
        )
        result = 1

    if args.keep:
        print(f"\nTemp DBs kept in: {tmpdir}", file=sys.stderr)
    else:
        for p in (alembic_db, models_db):
            p.unlink(missing_ok=True)
        try:
            (tmpdir / "backups").exists() and __import__("shutil").rmtree(
                tmpdir / "backups", ignore_errors=True
            )
            tmpdir.rmdir()
        except OSError:
            pass

    return result


if __name__ == "__main__":
    raise SystemExit(main())
