#!/usr/bin/env python3
"""READ-ONLY sweep: which dataset columns break the code-identity rule? (#793)

Value labels key every cell on its CODE, read from ``value_numeric``
(``services/value_labels.py::apply_value_labels``). That is only sound while the
column's stored number IS the response code. A primary recode whose OUTPUT is
something else — a REVERSE (#585), or a flipping / collapsing ``scale_map``
(#793) — puts a different number there, so relabelling reads each cell's WRONG
code and rewrites ``value_text`` to a different response, self-consistently.

This script answers the question that has to be asked BEFORE any guard ships:
**has that already happened to real data, and where is it about to?** A guard
repairs nothing, and the original ``value_text`` is overwritten by the damage,
so the check has to come first.

It is READ-ONLY three ways, deliberately:
  * the database is opened through a ``file:...?mode=ro`` URI — the connection
    cannot write even if this file were later edited to try;
  * ``MM_DATABASE_PATH`` is pointed at a throwaway path before the app package
    is imported, so importing the app's helpers can never bind an engine to a
    real database;
  * nothing here issues anything but SELECT.

It reuses the app's own predicates (``_strip_numeric``, ``is_missing``,
``build_code_to_label``) rather than re-deriving them, so the sweep and the
operation it is auditing cannot drift apart.

Usage:
    python scripts/sweep_code_identity.py [DB_PATH] [--all] [--json]

Exit status is 0 whether or not findings exist: this is a REVIEW LIST, not a
gate. Pass --exit-code to make unguarded findings exit 2 (for a CI-style check).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

# Bind any engine the app package builds at import time to a throwaway file.
# `app.database` calls `get_engine()` at module scope; `create_engine` is lazy so
# it never connects, but a scratch path means even a future eager connect cannot
# reach the database being audited.
os.environ.setdefault(
    "MM_DATABASE_PATH", str(Path(tempfile.mkdtemp(prefix="sweep-")) / "unused.db")
)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.dataset_import import _strip_numeric  # noqa: E402
from app.services.missing_values import is_missing, parse_missing_rules  # noqa: E402
from app.services.value_labels import (  # noqa: E402
    MAX_VALUE_LABELS,
    build_code_to_label,
)

# A column carrying more distinct (text, code) pairs than a declared dictionary
# may hold cannot BE a value-labelled scale, so the code-identity rule does not
# apply to it. Bounding the per-column scan here is what keeps this cheap on a
# 3.1M-value dataset — and skipped columns are REPORTED, never silently dropped.
DISTINCT_SCAN_CAP = MAX_VALUE_LABELS

# Two events counted as simultaneous when deciding whether the labels apply is
# what demoted a definition. The demote and the insert happen in one call, so
# the real gap is milliseconds; a whole second is slack for clock granularity
# (SQLite stores these to the second in some rows).
DEMOTE_WINDOW_SECONDS = 2.0

VERDICT_MISMATCH = "MISMATCH"
VERDICT_REVERSE = "REVERSE"
VERDICT_SUSPECT = "SUSPECT"
VERDICT_CLEAR = "CLEAR"
VERDICT_SKIPPED = "SKIPPED"


def open_readonly(path: Path) -> sqlite3.Connection:
    """Open the database read-only, or fail with an explanation."""
    if not path.exists():
        sys.exit(f"No database at {path}")
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.OperationalError as exc:  # pragma: no cover - environmental
        sys.exit(
            f"Could not open {path} read-only: {exc}\n"
            "If a -wal file is present, the -shm file must be readable too."
        )
    conn.row_factory = sqlite3.Row
    return conn


def parse_json_list(raw):
    try:
        out = json.loads(raw) if raw else None
    except (json.JSONDecodeError, TypeError):
        return None
    return out if isinstance(out, list) else None


def parse_mapping(raw) -> dict:
    try:
        out = json.loads(raw) if raw else {}
    except (json.JSONDecodeError, TypeError):
        return {}
    return out if isinstance(out, dict) else {}


def as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def mapping_is_non_identity(mapping: dict) -> bool:
    """Does this mapping send a NUMERIC key to something other than itself?

    The shape test from #793's filed entry. It is sound but INCOMPLETE on its
    own — a hand-flip keyed on LABELS ({"Never": 5, ...}) has no numeric keys at
    all and passes it vacuously — which is why the sweep's primary evidence is
    the stored data, not this. Kept because it names the culprit definition once
    the data has already said the column is unsafe.
    """
    for key, value in mapping.items():
        key_num, value_num = as_float(key), as_float(value)
        if key_num is not None and value_num is not None and key_num != value_num:
            return True
    return False


def mapping_is_invertible(mapping: dict) -> bool:
    """Can the original code be recovered from this mapping's output?

    A flip ({"1": 5 ... "5": 1}) is a bijection, so ``value_numeric`` still
    carries enough to undo it. A collapse ({"1": 1, "2": 1}) is not, and its
    inputs are genuinely gone. This is what decides whether a damaged column is
    repairable or only reportable.
    """
    outputs = [as_float(v) for v in mapping.values()]
    outputs = [v for v in outputs if v is not None]
    return bool(outputs) and len(set(outputs)) == len(outputs)


def column_label(row) -> str:
    """The canonical display fallback (mirrors lib/dataset-column-label.ts)."""
    return row["column_name"] or row["column_text"] or f"Column {row['id']}"


def implied_code_resolver(scale_labels, scale_values):
    """How this column says a cell's TEXT maps back to a code.

    Two sources, in the order ``apply_value_labels``' own identity rule would
    reach for them:

      1. the column's declared scale metadata (label -> code) — the labelled
         column's answer;
      2. the text parsed as a bare number — the un-labelled coded column's
         answer, and the one that catches #793's flagship case.

    Returns None when neither applies: the cell makes no claim about a code, so
    relabelling would not touch it and it is not evidence either way.
    """
    code_to_label = build_code_to_label(scale_labels, scale_values)
    label_to_code: dict[str, float] = {}
    for code, label in code_to_label.items():
        # A duplicated label makes the inversion ambiguous; the adapter dedupes
        # labels at import (#541a), so this is defensive rather than expected.
        label_to_code.setdefault(str(label), code)

    def resolve(value_text: str):
        if value_text in label_to_code:
            return label_to_code[value_text]
        stripped = value_text.strip()
        if stripped in label_to_code:
            return label_to_code[stripped]
        return _strip_numeric(value_text)

    return resolve


def scan(conn: sqlite3.Connection, show_all: bool) -> dict:
    columns = conn.execute(
        """
        SELECT dc.id, dc.dataset_id, dc.column_name, dc.column_text, dc.column_type,
               dc.scale_labels, dc.scale_values, dc.missing_values, dc.source,
               d.name AS dataset_name, d.project_id, p.name AS project_name
        FROM dataset_columns dc
        JOIN datasets d ON d.id = dc.dataset_id
        JOIN projects p ON p.id = d.project_id
        ORDER BY d.project_id, dc.dataset_id, dc.sequence_order
        """
    ).fetchall()

    stats = {
        r["column_id"]: r
        for r in conn.execute(
            """
            SELECT column_id,
                   COUNT(*)                     AS n_cells,
                   COUNT(value_numeric)         AS n_numeric,
                   COUNT(DISTINCT value_text)   AS n_distinct
            FROM dataset_values
            GROUP BY column_id
            """
        ).fetchall()
    }

    defs_by_column: dict[int, list] = {}
    for row in conn.execute(
        """
        SELECT id, column_id, name, recode_type, is_primary, is_auto_detected,
               mapping, created_at, updated_at
        FROM recode_definitions
        ORDER BY column_id, sequence_order, id
        """
    ).fetchall():
        defs_by_column.setdefault(row["column_id"], []).append(row)

    findings = []
    counts = {k: 0 for k in
              (VERDICT_MISMATCH, VERDICT_REVERSE, VERDICT_SUSPECT,
               VERDICT_CLEAR, VERDICT_SKIPPED)}

    for col in columns:
        stat = stats.get(col["id"])
        defs = defs_by_column.get(col["id"], [])
        primary = next((d for d in defs if d["is_primary"]), None)

        record = {
            "column_id": col["id"],
            "project": f'{col["project_name"]} (#{col["project_id"]})',
            "dataset": f'{col["dataset_name"]} (#{col["dataset_id"]})',
            "column": column_label(col),
            "column_type": col["column_type"],
            "primary": (f'{primary["name"]} [{primary["recode_type"]}]'
                        if primary else None),
            "cells": stat["n_cells"] if stat else 0,
        }

        if not stat or stat["n_numeric"] == 0:
            # No stored code anywhere on the column: the identity rule has
            # nothing to be wrong about.
            counts[VERDICT_CLEAR] += 1
            if show_all:
                findings.append({**record, "verdict": VERDICT_CLEAR,
                                 "reason": "no value_numeric on any cell"})
            continue

        # The cap bounds work on columns nothing has recoded. A column carrying
        # ANY definition is scanned however wide it is: a collapsing primary
        # over a continuous variable is precisely a high-cardinality column, and
        # capping it out would skip the case with the worst blast radius.
        if stat["n_distinct"] > DISTINCT_SCAN_CAP and not defs:
            counts[VERDICT_SKIPPED] += 1
            findings.append({
                **record,
                "verdict": VERDICT_SKIPPED,
                "reason": (f'{stat["n_distinct"]} distinct values exceeds the '
                           f"{DISTINCT_SCAN_CAP}-label ceiling a declared "
                           "dictionary may hold, so this column cannot be a "
                           "value-labelled scale"),
            })
            continue

        resolve = implied_code_resolver(
            parse_json_list(col["scale_labels"]), parse_json_list(col["scale_values"])
        )
        missing_rules = parse_missing_rules(col["missing_values"])

        mismatches, mismatch_cells, resolvable_cells = [], 0, 0
        for vt, vn, n in conn.execute(
            """
            SELECT value_text, value_numeric, COUNT(*) AS n
            FROM dataset_values
            WHERE column_id = ? AND value_numeric IS NOT NULL
              AND value_text IS NOT NULL AND TRIM(value_text) <> ''
            GROUP BY value_text, value_numeric
            """,
            (col["id"],),
        ):
            # `apply_value_labels` skips missing cells outright (#592 §I.3), so
            # they are neither at risk nor evidence.
            if is_missing(vt, missing_rules):
                continue
            code = resolve(vt)
            if code is None:
                continue
            resolvable_cells += n
            # Codes are exact in practice; the tolerance is defensive against a
            # float round-trip, and is far too tight to absorb a real off-by-one.
            if not math.isclose(code, vn, rel_tol=0.0, abs_tol=1e-9):
                mismatch_cells += n
                if len(mismatches) < 8:
                    mismatches.append(
                        {"value_text": vt, "stored_code": vn,
                         "text_implies": code, "cells": n}
                    )

        if mismatch_cells:
            reverse = primary is not None and primary["recode_type"] == "reverse"
            verdict = VERDICT_REVERSE if reverse else VERDICT_MISMATCH
            counts[verdict] += 1
            culprit = primary
            findings.append({
                **record,
                "verdict": verdict,
                "reason": (
                    f"{mismatch_cells} of {resolvable_cells} cells store a code "
                    "their own text does not imply"
                ),
                "guarded_by": ("blocking_reverse_primary (#585)" if reverse
                               else "code_identity_violation (#793)"),
                "repairable": (mapping_is_invertible(parse_mapping(culprit["mapping"]))
                               if culprit else None),
                "examples": mismatches,
            })
            continue

        # Consistent today — but consistency is exactly what the damage leaves
        # behind, so ask whether a labels apply is what produced it.
        suspect = detect_past_relabel(defs, primary, col)
        if suspect:
            counts[VERDICT_SUSPECT] += 1
            findings.append({**record, "verdict": VERDICT_SUSPECT, **suspect})
            continue

        counts[VERDICT_CLEAR] += 1
        if show_all:
            findings.append({**record, "verdict": VERDICT_CLEAR,
                             "reason": f"{resolvable_cells} cells agree"})

    return {"findings": findings, "counts": counts, "columns_scanned": len(columns)}


def detect_past_relabel(defs, primary, col) -> dict | None:
    """Did a value-labels apply already relabel this column through the hole?

    A column damaged by #793 is *internally consistent afterwards* — that is the
    defect's signature — so the cells cannot answer this. One trace survives:
    ``apply_value_labels`` DEMOTES the existing primary with a bulk UPDATE, and
    ``RecodeDefinition.updated_at`` carries ``onupdate=func.now()``, which
    SQLAlchemy applies to bulk updates (verified by execution). So a non-primary
    definition whose ``updated_at`` coincides with the current auto primary's
    ``created_at`` was demoted AT THE MOMENT that primary was minted.

    ⚠️ Strong evidence, NOT proof. A researcher who set a different primary by
    hand in the same second leaves the same trace, and a definition edited later
    loses it. Reported for human review; never acted on automatically.
    """
    if primary is None or not primary["is_auto_detected"]:
        return None
    if primary["recode_type"] != "scale_map":
        return None
    if not parse_json_list(col["scale_labels"]):
        return None

    minted = as_timestamp(primary["created_at"])
    if minted is None:
        return None

    for d in defs:
        if d["is_primary"] or d["id"] == primary["id"]:
            continue
        if d["recode_type"] not in ("scale_map", "reverse"):
            continue
        mapping = parse_mapping(d["mapping"])
        if d["recode_type"] == "scale_map" and not mapping_is_non_identity(mapping):
            continue
        demoted = as_timestamp(d["updated_at"])
        if demoted is None or abs(demoted - minted) > DEMOTE_WINDOW_SECONDS:
            continue
        return {
            "reason": (
                f'"{d["name"]}" [{d["recode_type"]}] was demoted at the moment '
                f'the primary "{primary["name"]}" was created — the signature of '
                "a value-labels apply over a non-identity primary"
            ),
            "repairable": mapping_is_invertible(mapping),
            "culprit_mapping": mapping,
        }
    return None


def as_timestamp(raw):
    from datetime import datetime

    if not raw:
        return None
    text = str(raw).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).timestamp()
        except ValueError:
            continue
    return None


def report(result: dict) -> None:
    counts = result["counts"]
    n = result["columns_scanned"]
    print(f'Scanned {n} column{"" if n == 1 else "s"}.\n')

    order = [VERDICT_MISMATCH, VERDICT_SUSPECT, VERDICT_REVERSE, VERDICT_SKIPPED,
             VERDICT_CLEAR]
    headline = {
        VERDICT_MISMATCH: "STORED CODES DISAGREE WITH THE RESPONSES — a "
                          "value-labels apply is REFUSED here (#793)",
        VERDICT_SUSPECT: "SUSPECTED ALREADY RELABELLED — needs a human decision",
        VERDICT_REVERSE: "REVERSE-SCORED — refused by the #585 definition guard",
        VERDICT_SKIPPED: "NOT APPLICABLE — too many distinct values to be a "
                         "labelled scale",
        VERDICT_CLEAR: "CLEAR",
    }

    for verdict in order:
        rows = [f for f in result["findings"] if f["verdict"] == verdict]
        if not rows:
            continue
        print(f"── {headline[verdict]} ({counts[verdict]}) " + "─" * 8)
        for f in rows:
            print(f'  {f["project"]} › {f["dataset"]} › {f["column"]} '
                  f'[{f["column_type"]}, {f["cells"]} cells]')
            if f.get("primary"):
                print(f'      primary recode: {f["primary"]}')
            print(f'      {f["reason"]}')
            if f.get("guarded_by"):
                print(f'      refused by: {f["guarded_by"]}')
            if f.get("repairable") is not None:
                print("      original codes recoverable from value_numeric: "
                      f'{"YES" if f["repairable"] else "NO — mapping is not invertible"}')
            for ex in f.get("examples", []):
                print(f'      · text {ex["value_text"]!r} stores {ex["stored_code"]}, '
                      f'its own text implies {ex["text_implies"]} '
                      f'({ex["cells"]} cells)')
        print()

    print("Summary: "
          + ", ".join(f"{counts[v]} {v.lower()}" for v in order))
    if counts[VERDICT_MISMATCH] or counts[VERDICT_SUSPECT]:
        print("\nNothing here has been changed. Re-run after any fix ships.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("db_path", nargs="?", default="dev.db",
                    help="SQLite database to audit (default: dev.db)")
    ap.add_argument("--all", action="store_true",
                    help="list clear columns too, not only findings")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--exit-code", action="store_true",
                    help="exit 2 when unguarded or suspected columns are found")
    args = ap.parse_args()

    conn = open_readonly(Path(args.db_path).resolve())
    try:
        result = scan(conn, args.all)
    finally:
        conn.close()

    if args.json:
        print(json.dumps(result, indent=2, default=str))
    else:
        report(result)

    if args.exit_code and (result["counts"][VERDICT_MISMATCH]
                           or result["counts"][VERDICT_SUSPECT]):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
