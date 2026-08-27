#!/usr/bin/env python3
"""READ-ONLY sweep: can every stored recode mapping be CONVERTED? (Decision D, slab 0)

Decision D stops recodes matching on display text and matches on the CODE
instead. Converting a mapping means rewriting its KEYS from text to codes, and
what a key means today depends on the column it sits on:

    labelled column   — the key is a LABEL      → resolve via scale metadata
    bare-code column  — the key is a code STRING → parse it
    code-less column  — the key IS the identity  → NOT CONVERTED, by design
    stale against its column                     → matches nothing, CANNOT convert

This answers the question the migration cannot be written without: **how many
mappings are in each of those states, per project?** If nothing is dead and
nothing half-resolves, the migration can assume a clean set; otherwise it needs
a manual-repair path, and that is a decision to take before the code exists.

⚠️ **This is NOT the #793 sweep, and the two are easy to confuse.**
`sweep_code_identity.py` asks whether data has ALREADY been scrambled — does
each primary's OUTPUT equal the response's code. That question is closed (the
corpus was clean). This one asks whether the stored mappings can be MIGRATED.
Different question, different answer, both read-only.

It is READ-ONLY three ways, deliberately — the same construction as its sibling:
  * the database is opened through a ``file:...?mode=ro`` URI;
  * ``MM_DATABASE_PATH`` is pointed at a throwaway path before the app package
    is imported, so importing the app's helpers cannot bind an engine to a real
    database;
  * nothing here issues anything but SELECT.

It reuses the app's own predicates (``_strip_numeric``, ``build_code_to_label``,
and `compute_value`'s case-folding join rule) rather than re-deriving them, so
the sweep and the operation it audits cannot drift apart.

Usage:
    python scripts/sweep_recode_convertibility.py [DB_PATH] [--all] [--json]

Exit status is 0 whether or not findings exist: this is a REVIEW LIST that
informs a design decision, not a gate.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections import Counter
from pathlib import Path

# Bind any engine the app package builds at import time to a throwaway file.
os.environ.setdefault(
    "MM_DATABASE_PATH", str(Path(tempfile.mkdtemp(prefix="dsweep-")) / "unused.db")
)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.dataset_import import _strip_numeric  # noqa: E402
from app.services.value_labels import build_code_to_label  # noqa: E402

# ── Vocabulary ───────────────────────────────────────────────────────────────

COL_LABELLED = "labelled"
COL_BARE_CODES = "bare-codes"
COL_CODE_LESS = "code-less"
COL_EMPTY = "empty"

# A definition's fate under D's migration.
V_CONVERTIBLE = "CONVERTIBLE"        # every key resolves to a code
V_PARTIAL = "PARTIAL"                # some keys resolve, some do not
V_DEAD = "DEAD"                      # matches no stored cell — cannot convert
V_NOT_APPLICABLE = "NOT-APPLICABLE"  # code-less column: keeps the text join, by design
V_UNJUDGEABLE = "UNJUDGEABLE"        # empty column: nothing to judge against

# Verdicts that need a human decision before the migration is written.
NEEDS_ATTENTION = {V_PARTIAL, V_DEAD}


def open_readonly(path: Path):
    import sqlite3
    if not path.exists():
        sys.exit(f"No database at {path}")
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.OperationalError as exc:  # pragma: no cover - environmental
        sys.exit(f"Could not open {path} read-only: {exc}")
    conn.row_factory = sqlite3.Row
    return conn


def _json_or(raw, fallback):
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return fallback


def classify_column(scale_labels, scale_values, live_texts: set[str]) -> str:
    """Which of D's three column states this column is in.

    ⚠️ Order matters. A column can carry scale metadata AND numeric-looking
    cells; the metadata wins, because that is what `apply_value_labels` wrote
    and what the mapping keys were authored against.
    """
    if not live_texts:
        return COL_EMPTY
    if build_code_to_label(scale_labels, scale_values):
        return COL_LABELLED
    if all(_strip_numeric(t) is not None for t in live_texts):
        return COL_BARE_CODES
    return COL_CODE_LESS


def resolve_key(key: str, col_class: str, label_to_code: dict[str, float]) -> bool:
    """Would D's migration find a code for this mapping key?

    Case-folded because `compute_value` looks its mapping up case-insensitively
    (`lower_map.get(value_text.strip().lower())`) — judging case-sensitively
    would report a working key as unconvertible.
    """
    k = str(key).strip().lower()
    if col_class == COL_LABELLED:
        return k in label_to_code
    if col_class == COL_BARE_CODES:
        return _strip_numeric(k) is not None
    return False


def sweep(conn) -> dict:
    projects = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM projects")}

    rows = conn.execute(
        """
        SELECT rd.id            AS def_id,
               rd.name          AS def_name,
               rd.recode_type   AS recode_type,
               rd.is_primary    AS is_primary,
               rd.mapping       AS mapping,
               rd.exclude_values AS exclude_values,
               dc.id            AS column_id,
               dc.column_name   AS column_name,
               dc.column_text   AS column_text,
               dc.scale_labels  AS scale_labels,
               dc.scale_values  AS scale_values,
               ds.id            AS dataset_id,
               ds.name          AS dataset_name,
               ds.project_id    AS project_id
          FROM recode_definitions rd
          JOIN dataset_columns dc ON dc.id = rd.column_id
          JOIN datasets ds        ON ds.id = dc.dataset_id
         ORDER BY ds.project_id, ds.id, dc.id, rd.sequence_order
        """
    ).fetchall()

    # One pass per column for its distinct cell texts, cached — a definition's
    # deadness and its column's class both need the same set.
    live_cache: dict[int, set[str]] = {}

    def live_texts(column_id: int) -> set[str]:
        if column_id not in live_cache:
            live_cache[column_id] = {
                r[0].strip().lower()
                for r in conn.execute(
                    "SELECT DISTINCT value_text FROM dataset_values "
                    "WHERE column_id = ? AND value_text IS NOT NULL AND value_text != ''",
                    (column_id,),
                )
                if r[0] and r[0].strip()
            }
        return live_cache[column_id]

    findings: list[dict] = []
    per_project: dict[int, Counter] = {}
    col_classes: dict[int, str] = {}

    for r in rows:
        live = live_texts(r["column_id"])
        col_class = classify_column(
            _json_or(r["scale_labels"], None), _json_or(r["scale_values"], None), live
        )
        col_classes[r["column_id"]] = col_class

        mapping = _json_or(r["mapping"], {})
        keys = [str(k) for k in mapping] if isinstance(mapping, dict) else []
        excludes = _json_or(r["exclude_values"], []) or []

        label_to_code: dict[str, float] = {}
        if col_class == COL_LABELLED:
            for code, label in build_code_to_label(
                _json_or(r["scale_labels"], None), _json_or(r["scale_values"], None)
            ).items():
                label_to_code[str(label).strip().lower()] = code

        # Deadness mirrors `recode_dependents._live_keys` + the empty guard:
        # a column with no stored values makes every definition look dead, which
        # is an artefact of having no data rather than a finding.
        folded = {k.strip().lower() for k in keys}
        is_dead = bool(folded) and bool(live) and not (folded & live)

        if col_class == COL_EMPTY:
            verdict = V_UNJUDGEABLE
        elif col_class == COL_CODE_LESS:
            verdict = V_NOT_APPLICABLE
        elif is_dead:
            verdict = V_DEAD
        else:
            unresolved = [k for k in keys if not resolve_key(k, col_class, label_to_code)]
            verdict = V_CONVERTIBLE if not unresolved else V_PARTIAL

        # `exclude_values` is a PARALLEL list of texts needing the same
        # conversion; forgetting it converts the mapping and leaves the null set
        # keyed on the old spelling. Counted separately so it cannot hide.
        unresolved_excludes = [
            e for e in excludes
            if col_class in (COL_LABELLED, COL_BARE_CODES)
            and not resolve_key(str(e), col_class, label_to_code)
        ]

        pid = r["project_id"]
        per_project.setdefault(pid, Counter())
        per_project[pid][verdict] += 1
        if unresolved_excludes:
            per_project[pid]["exclude-unresolved"] += 1

        if verdict in NEEDS_ATTENTION or unresolved_excludes:
            unresolved = [k for k in keys if not resolve_key(k, col_class, label_to_code)]
            findings.append({
                "project": projects.get(pid, f"#{pid}"),
                "dataset": r["dataset_name"],
                "column": r["column_name"] or r["column_text"],
                "column_class": col_class,
                "definition": r["def_name"],
                "recode_type": r["recode_type"],
                "is_primary": bool(r["is_primary"]),
                "verdict": verdict,
                "keys": len(keys),
                "unresolved_keys": unresolved[:8],
                "unresolved_excludes": unresolved_excludes[:8],
            })

    return {
        "definitions": len(rows),
        "columns_with_definitions": len(col_classes),
        "column_classes": Counter(col_classes.values()),
        "per_project": {projects.get(p, f"#{p}"): dict(c) for p, c in per_project.items()},
        "totals": Counter(v for c in per_project.values() for v, n in c.items() for _ in range(n)),
        "findings": findings,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("db", nargs="?", default="dev.db", type=Path)
    ap.add_argument("--all", action="store_true", help="print every finding, not the first 20")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    conn = open_readonly(args.db)
    try:
        result = sweep(conn)
    finally:
        conn.close()

    if args.json:
        print(json.dumps(result, indent=2, default=str))
        return 0

    print(f"Decision D · slab 0 — recode convertibility sweep of {args.db}")
    print(f"  {result['definitions']} recode definitions on "
          f"{result['columns_with_definitions']} columns\n")

    print("  Column states (what a mapping KEY means today):")
    for cls, n in sorted(result["column_classes"].items()):
        note = {
            COL_CODE_LESS: "  ← D does NOT convert these, by design",
            COL_EMPTY: "  ← no stored values; nothing to judge against",
        }.get(cls, "")
        print(f"    {cls:<12} {n:>4}{note}")

    print("\n  Definition verdicts, per project:")
    for proj, counts in sorted(result["per_project"].items()):
        parts = ", ".join(f"{v}={n}" for v, n in sorted(counts.items()))
        print(f"    {proj}: {parts}")

    if result["findings"]:
        shown = result["findings"] if args.all else result["findings"][:20]
        print(f"\n  {len(result['findings'])} definition(s) need a decision "
              f"before the migration is written:")
        for f in shown:
            print(f"    [{f['verdict']}] {f['project']} · {f['dataset']} · {f['column']} "
                  f"({f['column_class']}) · \"{f['definition']}\" [{f['recode_type']}"
                  f"{', PRIMARY' if f['is_primary'] else ''}]")
            if f["unresolved_keys"]:
                print(f"        keys that resolve to no code: {f['unresolved_keys']}")
            if f["unresolved_excludes"]:
                print(f"        exclude_values that resolve to no code: {f['unresolved_excludes']}")
        if not args.all and len(result["findings"]) > 20:
            print(f"    … {len(result['findings']) - 20} more (pass --all)")
    else:
        print("\n  No definition needs a repair path: every mapping on a coded "
              "column resolves\n  completely, and nothing is dead.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
