#!/usr/bin/env python3
"""Upgrade gate: run a release's migrations against an ENCRYPTED, populated DB.

Build a database at the PREVIOUS release's Alembic revision, fill it with the
rows this release's migrations put at risk, encrypt it with SQLCipher, run
`alembic upgrade head`, and assert that every row and every parent link survived.

Why it exists (the gap it closes, found at the v1.3.0 cut, 2026-08-02):

  * `dev.db` and the whole test suite run **plaintext SQLite**. The packaged
    desktop app runs **SQLCipher**. So the combination "these migrations, on an
    encrypted file, with data in it" is exercised by *nothing* — not the suite,
    not `schema_diff_harness.py` (which compares structure on fresh DBs), not CI.
  * The dangerous migrations are the ones SQLite implements as a **table
    rebuild** (`batch_alter_table(recreate='always')` = DROP + RENAME). v1.3.0
    rebuilt `segments` (every coded unit) and `excerpt` (every quote). If
    `PRAGMA foreign_keys` were ever left ON during that, SQLite's implicit
    DELETE would CASCADE into `code_applications` and `notes` and the coding
    would vanish — silently, with the app still opening fine afterwards.
  * Row COUNTS cannot see the other failure mode: a rebuild that preserves every
    row while scrambling which child points at which parent. Every assertion
    below is therefore on **identity** (id -> parent id), not volume.

This is a RELEASE-TIME gate, not a CI test: the "from" revision moves every
release, and a realistic corpus is the point. Run it whenever a release carries
migrations (RELEASING §4c).

Usage (from backend/, venv active, sqlcipher3 installed):

    python scripts/migration_rehearsal.py --from-revision f5b2d8c47e13   # v1.5.7

`--from-revision` is the Alembic head of the PREVIOUS release. Find it with:

    git show <previous-release-tag>:backend/alembic/versions/ ...   # or
    alembic history            # and take the last revision before this cut

Exits 0 on success, 1 on any failure. Writes only to a temp dir; never touches
`dev.db`, the real backup dir, or the developer's data.
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 1, 1, 12, 0, 0).isoformat(sep=" ")
KEY_HEX = "ab" * 32  # throwaway; this DB is discarded


def _connect(db_path: Path):
    import sqlcipher3
    conn = sqlcipher3.connect(str(db_path))
    conn.execute(f"PRAGMA key=\"x'{KEY_HEX}'\"")
    return conn


def _alembic(env: dict, *args: str) -> None:
    r = subprocess.run(
        ["alembic", *args], cwd=str(BACKEND), env=env,
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise SystemExit(f"alembic {' '.join(args)} failed")


def _tables(conn) -> set[str]:
    return {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}


def _cols(conn, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def _indexes(conn, table: str) -> dict[str, str]:
    """Every non-implicit index on `table`, name -> its CREATE statement.

    The SQL is kept, not just the name: a partial index that comes back without
    its `WHERE` is a different constraint wearing the same name, and only the
    statement shows it.
    """
    return {r[0]: (r[1] or "") for r in conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name", (table,))}


def _fks(conn, table: str) -> list[tuple]:
    """Every FK on `table` as (referenced table, from, to, on_update, on_delete, match).

    The pragma's `id`/`seq` are dropped: a rebuild may re-declare the FKs in another
    order, and the order is not what a delete depends on.
    """
    return sorted((r[2], r[3], r[4], r[5], r[6], r[7])
                  for r in conn.execute(f"PRAGMA foreign_key_list({table})"))


def _full_rows(conn, table: str, cols: list[str]) -> list[list[str]]:
    """Every row of `table`, over exactly `cols`, stringified (so 0.0 ≠ None ≠ 0)."""
    sel = ", ".join(f'"{c}"' for c in cols)
    return [list(map(repr, r))
            for r in conn.execute(f"SELECT {sel} FROM {table} ORDER BY id")]


def _expected_after(table: str, cols: list[str], rows: list[list[str]]) -> list[list[str]]:
    """`rows` (as `_full_rows` read them before the upgrade) as they must read after it:
    unchanged, except the values this cut's repair must move (`EXPECTED_REWRITES`)."""
    out = [list(r) for r in rows]
    for (t, col), by_id in EXPECTED_REWRITES.items():
        if t != table or col not in cols:
            continue
        id_at, col_at = cols.index("id"), cols.index(col)
        for r in out:
            want = by_id.get(int(r[id_at]))
            if want is not None:
                r[col_at] = repr(want)
    return out


# ── What THIS release's migration must do ────────────────────────────────────
#
# ⚠️ **Review this block at every cut, exactly like `--from-revision`.** It is the
# half the script was missing at v1.3.1: v1.3.0 carried only STRUCTURAL migrations
# (table rebuilds), where "every row and every link is unchanged" is the whole of
# correctness. A DATA-REPAIR migration inverts that — the rows it is supposed to
# rewrite MUST move, and a corpus on which it no-ops proves nothing while exiting 0.
#
# ── 1.5.8 (rehearsed 2026-10-25) — NO REBUILD: a backfill, a new table, a REPAIR ──
#
# `--from-revision f5b2d8c47e13` — v1.5.7's head (`d1ddca8b`). THREE migrations, and
# none rebuilds a table (each is ADD COLUMN, CREATE TABLE / INDEX, or UPDATE):
#
#   c6e2a8d41f97  users.uuid — every row BACKFILLED, then a UNIQUE index     (#1352)
#   a7c3e9f1d2b4  removal_tombstones (a new table) + a plain index          (#1190)
#   b5d1f7a3c9e2  dataset_columns.stale := 1 on a quoted-answer formula     (#1368 D4)
#
# 🔴 **TWO OF THE THREE MUST CHANGE ROWS, so "nothing changed" is the wrong assertion
# for this cut twice over** (RELEASING §4c: a gate whose only assertion is invariance
# is inert against a migration whose job is to change something):
#
#   * `users.uuid` MUST arrive SET on every pre-existing coder — the person, the
#     MACHINE coder and an ARCHIVED colleague — each DISTINCT, and each a value the
#     `.mmproject` import reads as an identity (`_file_coder_uuid`: a non-empty string
#     of at most 36 characters; anything else is NO identity). A coder left without
#     one is matched by NAME at the next merge, which is #1352: every install's first
#     coder is "Researcher", so two people became one coder. A SHARED value is the
#     same defect the other way round (the unique index refuses the upgrade outright).
#     NULL stays LEGAL afterwards — a row written around the ORM default has no
#     identity, and the import then falls back to the name rules — so two coders
#     without one must still both be accepted.
#   * the repair marks EXACTLY the computed columns whose formula compares a column
#     with a quoted text, on either side. `REPAIR_STALE` names every computed column
#     the seed writes with the `stale` it must arrive holding: the two shapes marked, a
#     numeric comparison left alone, and an arithmetic formula that was ALREADY stale
#     still stale. Its stored CELLS must not move — recomputing is the evaluator's job,
#     on the researcher's click — so each keeps the old evaluator's values.
#   * `removal_tombstones` MUST arrive EMPTY. A tombstone says "a withdrawal removed
#     this", so a fabricated one makes the next merge or import leave out data nobody
#     withdrew. Its index must NOT be unique: one project withdraws many participants.
#
# ── v1.5.3's fixtures CHANGE SIDES ────────────────────────────────────────────
#
# 🔴 `f5b2d8c47e13` IS `--from-revision`, so `code_sets`, `codes.code_set_id` and
# `users.machine_provenance` exist BEFORE these migrations start, and the v1.5.3 cut's
# "they arrive NULL / EMPTY" would pass VACUOUSLY. **MEASURED: the block as the v1.5.3
# cut left it exited 0 against this cut's repair made a no-op, its backfill skipped,
# and a tombstone fabricated for every project.** They are seeded with REAL values instead — a set with `exhaustive` RAISED
# and two member codes, a machine coder with a recorded provenance — and asserted
# invariant by the full-row comparison. Its behavioural checks (`exhaustive` defaults
# to 0, a set's uuid is unique, deleting a set leaves its codes and their coding) stay,
# as coverage of the BUILT database rather than as claims about this cut.
#
# ⚠️ **Not covered here: #1362's change to two OLD revisions** (`d7a2f3b8c1e9`,
# `e8b3c1d65a04`, each backfill now one statement per table). They sit below
# `--from-revision`, so this run executes them only while BUILDING the empty database,
# where they backfill nothing. Only a v1.0.x install runs them on data: Batch 2's D12
# proves them on a seeded 1.0-schema project, and `tests/test_migration_scaling.py`
# counts their statements.
#
# ⚠️ **1.5.8 is the first release whose chain is ONE transaction (#1312)**, so this is
# also the first rehearsal of that `env.py` on SQLCipher with data in the file. A
# failure partway is `tests/test_migration_atomicity.py`'s, on both drivers.
#
# The older fixtures — the coded spine and its cascade canaries, the v1.3.1 repairs
# (`a1b2c3d4e5f7` astral offsets, `b8e4c2a70d19` note numbering), v1.4.0's provenance
# columns, v1.5.1's #35 ratings (a 0.0 on a −2…+2 scale, an application left UNRATED,
# a `magnitude_conflict`), v1.5.2's participant table and v1.5.3's `codes` rebuild —
# stay seeded at real values and asserted invariant. With no rebuild this cut they
# guard against a migration touching what it must not, rather than against a recopy.

# The v1.3.1 fixtures, now seeded post-repair and asserted INVARIANT.
#
#   text          "🙂 alpha"
#   code points   [🙂][ ][a][l][p][h][a]        → "alpha" is 2..7   ← stored today
#   UTF-16 units  [🙂 = 2 units][ ][a]…         → "alpha" is 3..8   ← the old bug
ASTRAL_SEGMENT_TEXT = "\U0001F642 alpha"
ASTRAL_EXCERPT_ID = 3
ASTRAL_OFFSETS = (2, 7)

# #747 numbering as a repaired database already holds it: 1..N per parent, in id
# order, restarting for each parent. Nothing in this release may renumber these.
NOTE_SEQ_INVARIANT = [
    (1, 1),   # conversation note
    (2, 1),   # document 1, first by id
    (3, 2),   # document 1, second by id
    (4, 1),   # observation clip — its own parent, so numbering restarts
]

# `dataset_columns` ids are deliberately NON-CONTIGUOUS: a rebuild that renumbers
# instead of preserving ids breaks every child FK, and contiguous ids would let
# that pass. ⚠️ No table is rebuilt this cut; this is the one its REPAIR writes.
# `DC_SCORE` is the participant table's score column (below).
DC_SOURCE, DC_TARGET, DC_EQUIV, DC_PLAIN = 41, 47, 53, 61
DC_SCORE = 67

# #1368 D4's repair (`b5d1f7a3c9e2`): every computed column the seed writes — its
# formula, the `stale` it is seeded at, and the `stale` it must arrive holding. A repair
# that marked every computed column, or none, or only one side of the comparison, or
# WROTE the flag instead of raising it (un-marking a column already out of date), gets
# at least one of these wrong.
DC_QUOTED, DC_QUOTED_MIRRORED, DC_NUMERIC_CMP, DC_ALREADY_STALE = 71, 73, 79, 83
REPAIR_STALE = {
    DC_QUOTED:          ('[Trust] == "Agree"',                0, 1),
    DC_QUOTED_MIRRORED: ('IF("Agree" != ( [Trust] ), 1, 0)',  0, 1),
    DC_NUMERIC_CMP:     ('[Trust] == 4',                      0, 0),
    DC_ALREADY_STALE:   ('[Trust] * 2',                       1, 1),
}
# What each stores on both seeded rows (`Trust` is "4" on both) — the old evaluator's
# values, compared the old way. The repair marks; it never recomputes.
COMPUTED_STORED = {DC_QUOTED: "0", DC_QUOTED_MIRRORED: "1", DC_NUMERIC_CMP: "1",
                   DC_ALREADY_STALE: "8"}

# v1.4.0's additions. At `--from-revision a9c3e7b1d5f2` they are ALREADY PRESENT,
# so they are asserted UNCHANGED, never as evidence that anything ran.
V140_COLUMNS = ("derived_from_column_id", "derived_via")
V140_INDEX = "ix_dataset_columns_derived_from_column_id"

# v1.5.1's #35 fixture, now BELOW --from-revision: seeded with real values and
# asserted invariant. `RATED_ZERO` is the interior neutral on a −2…+2 scale and
# `UNRATED` is deliberately NULL — the distinction `magnitude-coding.md` §2 exists
# to protect, and the one a careless recopy would erase in either direction.
SCALE_CODE_ID = 1
MAGNITUDE_SCALE = (-2.0, 2.0, 1.0, '{"-2": "Strongly negative", "2": "Strongly positive"}')
# All four sit on the SCALED code: a rating on a code with no declared scale is
# not a state the app can produce, and a fixture that cannot occur proves nothing.
APP_CONFLICTED, APP_RATED_POSITIVE, APP_RATED_ZERO, APP_UNRATED = 1, 2, 5, 6

# Row 46 / row 45's fixtures (v1.5.2's, now below --from-revision). Non-contiguous.
# `DS_SECOND` is the project's PARTICIPANT TABLE, seeded as a refresh leaves one —
# synced, then marked stale by a later rating — with a score column whose spec
# names `SCALE_CODE_ID`: an id inside a JSON blob, pointing INTO `codes`.
PARTICIPANT_LINKED, PARTICIPANT_SPARE = 7, 11
PROJECT_OTHER = 2
DS_MAIN, DS_SECOND, DS_OTHER_PROJECT = 1, 5, 9
PARTICIPANT_TABLE = DS_SECOND
MANAGED_SPEC = json.dumps({"kind": "magnitude_score", "code_id": SCALE_CODE_ID})

# The v1.5.3 cut's `codes` fixtures (it rebuilt `codes`), beside SCALE_CODE_ID (1) and
# code 2. Non-contiguous, and each carries a different dependant of `codes`:
# `CODE_GROUPED` sits in a category (FK + legacy membership row) AND an equivalence
# group, with a uuid, a colour and a description; `CODE_RETIRED` is inactive.
CODE_GROUPED, CODE_RETIRED = 7, 12
CATEGORY_ID, CODE_GROUP_ID = 3, 5
APP_MACHINE, APP_RETIRED = 7, 8
# v1.5.3's code set, BELOW --from-revision now: seeded with `exhaustive` RAISED and two
# member codes, so its arrival is a claim about real values. `CODE_SET_FRESH` and
# `CODE_SET_DUPLICATE` are written AFTER the upgrade by the behavioural checks.
CODE_SET_ID, CODE_SET_DUPLICATE, CODE_SET_FRESH = 4, 6, 8
CODE_SET_UUID = "5c0de5e7-0000-4000-8000-000000000048"
CODE_SET_MEMBERS = (2, CODE_GROUPED)

# The coders `c6e2a8d41f97` must give an identity: a person, a MACHINE coder (carrying
# the provenance v1.5.3 added, now below --from-revision and seeded at a real value)
# and an ARCHIVED colleague, at non-contiguous ids. An archived coder's codings still
# cross a merge, so a backfill that skipped archived coders would leave exactly the
# people #1352 is about to be matched by name.
LEAD_CODER, MACHINE_CODER, ARCHIVED_CODER = 1, 4, 9
MACHINE_PROVENANCE = json.dumps(
    {"model": "rehearsal-model-2026-01", "access": "api", "parameters": {"temperature": 0}})
# Written AFTER the upgrade: two coders with no identity, which must both be accepted.
NULL_IDENTITY_CODERS = (21, 22)
# Written AFTER the upgrade: two withdrawals in ONE project — one remembered by the
# participant's uuid, one by a hash of the identifier (`tombstones.identifier_hash`).
TOMBSTONE_PROJECT_UUID = "7b0a7b0a-0000-4000-8000-000000001190"

# This cut rebuilds NO table. The tables below are compared before and after anyway:
# it costs nothing, and they are the parents of data.
#
# Every index on these is compared with its CREATE statement — a dropped UNIQUE index
# leaves a constraint unenforced and nothing else looks wrong.
INDEXED_TABLES = (
    "codes", "code_applications", "code_category_memberships", "code_sets", "users",
    "documents", "datasets", "dataset_columns",
)
# `PRAGMA foreign_key_list` before and after.
FK_TABLES = ("codes", "code_applications", "code_category_memberships", "code_sets")
# Every PRE-EXISTING column of every seeded row, compared whole — against what it must
# hold AFTER, which is what it held before except `EXPECTED_REWRITES`. Listing columns
# by hand is how a column added later goes unchecked, so the column list is read from
# the database at seed time.
FULL_ROW_TABLES = (
    "codes", "users", "code_applications", "code_category_memberships",
    "code_categories", "code_equivalence_groups", "code_sets",
    "documents", "datasets", "dataset_columns", "dataset_rows",
)
# (table, column) -> {row id: the value the repair must leave there}. The full-row
# comparison expects these too, so a repair that moved nothing — or moved a row it
# must not — fails there as well as in its own check below.
EXPECTED_REWRITES = {
    ("dataset_columns", "stale"): {cid: after for cid, (_, _, after) in REPAIR_STALE.items()},
}

# ── What this cut must ADD, per column: the value it must arrive HOLDING, and why ──
#
# `IDENTITY`: set on every row, distinct, and readable by the `.mmproject` import as an
# identity — `project_portability._file_coder_uuid` takes a non-empty string of at most
# 36 characters and treats anything else as NO identity.
IDENTITY = object()
NEW_COLUMNS = {
    "users": {"uuid": (
        IDENTITY,
        "a coder without one is matched by NAME at the next merge, which is #1352: every "
        "install's first coder is \"Researcher\", so two people would become one")},
}
# New tables that must arrive EMPTY, and why.
NEW_TABLES_EMPTY = {
    "removal_tombstones": "a tombstone says a withdrawal removed something, so a "
                          "fabricated one makes the next merge or import leave out data "
                          "nobody withdrew",
}
# New FKs: (table, column) -> (referenced table, ON DELETE). This cut adds none.
NEW_FKS: dict = {}
# Indexes this cut must CREATE: name -> (table, columns, must it be UNIQUE?, why).
NEW_INDEXES = {
    "ix_users_uuid": (
        "users", ("uuid",), True,
        "two coders could hold one identity, and a merge would land one person's codings "
        "on the other"),
    "ix_removal_tombstones_project": (
        "removal_tombstones", ("project_uuid", "entity_type"), False,
        "one project withdraws many participants, so the second withdrawal's tombstone "
        "would be refused"),
}


def seed(db_path: Path) -> dict:
    """Fill the old-revision DB with the shapes a table rebuild can damage.

    Deliberately includes: segments under BOTH parents, the self-referencing
    merge/split links, children hanging off segments and off CODES (the cascade
    canaries), every kind of row that depends on `codes` (applications by a human
    and a machine coder, a category membership, a category and an equivalence
    group it points at), excerpts in both pre-time-range shapes, and
    non-contiguous ids (a rebuild that renumbers instead of preserving ids breaks
    every child FK). For this cut: three kinds of coder for the identity backfill to
    reach, a code set at real values, and the computed columns the repair must
    mark — and must leave alone.

    Tables absent at the given revision are skipped with a note rather than
    crashing — the seed has to survive a moving "from" revision.
    """
    conn = _connect(db_path)
    conn.execute("PRAGMA foreign_keys=ON")
    x, have = conn.execute, _tables(conn)
    skipped = []

    x("INSERT INTO users (id, username, is_admin, created_at) "
      "VALUES (?,'Researcher',1,?)", (LEAD_CODER, NOW))
    # Three kinds of coder for `users.uuid` to reach: the person above, a MACHINE coder
    # (`coder_type='ai'` arrives through a merged project file, #989) holding the
    # provenance v1.5.3 added, and an ARCHIVED colleague.
    user_cols = _cols(conn, "users")
    machine = "coder_type" in user_cols
    if machine:
        x("INSERT INTO users (id, username, is_admin, created_at, coder_type) "
          "VALUES (?,'Model A',0,?,'ai')", (MACHINE_CODER, NOW))
        if "machine_provenance" in user_cols:
            x("UPDATE users SET machine_provenance=? WHERE id=?",
              (MACHINE_PROVENANCE, MACHINE_CODER))
        else:
            skipped.append("machine provenance")
    else:
        skipped.append("machine coder")
    if "archived" in user_cols:
        x("INSERT INTO users (id, username, is_admin, created_at, archived) "
          "VALUES (?,'Dana',0,?,1)", (ARCHIVED_CODER, NOW))
    else:
        skipped.append("archived coder")
    x("INSERT INTO projects (id, user_id, name, status, created_at, updated_at) "
      "VALUES (1,1,'Rehearsal project','active',?,?), (?,1,'Second study','active',?,?)",
      (NOW, NOW, PROJECT_OTHER, NOW, NOW))
    x("INSERT INTO conversations (id, project_id, name, status, created_at, updated_at, "
      "media_offset_seconds) VALUES (1,1,'Interview 01','ready',?,?,0.0)", (NOW, NOW))

    # Row 46 needs somebody for a document to be ABOUT, and the `datasets` rebuild
    # needs a participant-linked row to carry across it. The SECOND project exists
    # so the new partial unique index gets a chance to be wrongly scoped: "one
    # participant dataset per PROJECT" must still permit one in each of two.
    if "participants" in have:
        x("INSERT INTO participants (id, project_id, identifier, display_name, "
          "created_at, updated_at) VALUES (?,1,'P-001','Alex Iyer',?,?), "
          "(?,1,'P-002','Sam Okafor',?,?)",
          (PARTICIPANT_LINKED, NOW, NOW, PARTICIPANT_SPARE, NOW, NOW))
    else:
        skipped.append("participants")
    if "documents" in have:
        x("INSERT INTO documents (id, project_id, name, source_filename, source_format, "
          "segmentation_mode, created_at, updated_at) "
          "VALUES (1,1,'Brief','brief.pdf','pdf','paragraph',?,?)", (NOW, NOW))
        # v1.5.2's row-46 link, below --from-revision now: seeded LINKED, so the
        # full-row comparison proves it is carried, not that it arrives empty.
        if "participant_id" in _cols(conn, "documents") and "participants" in have:
            x("UPDATE documents SET participant_id=? WHERE id=1", (PARTICIPANT_LINKED,))
        else:
            skipped.append("document participant link")
    else:
        skipped.append("documents")

    seg = [(10, 1, None), (11, 1, None), (12, 1, None),
           (13, 1, None), (14, 1, None), (15, 1, None),
           (16, 1, None), (17, 1, None), (18, 1, None)]
    if "documents" in have:
        seg += [(20, None, 1), (21, None, 1)]
    for i, (sid, cid, did) in enumerate(seg, start=1):
        x("INSERT INTO segments (id, conversation_id, document_id, sequence_order, text, "
          "created_at, is_starred, is_merge_result, is_split_result) VALUES (?,?,?,?,?,?,0,0,0)",
          (sid, cid, did, i, f"segment text {sid}", NOW))
    x("UPDATE segments SET merged_into_id=15 WHERE id IN (13,14)")
    x("UPDATE segments SET is_merge_result=1 WHERE id=15")
    x("UPDATE segments SET split_into_id=17 WHERE id=16")
    x("UPDATE segments SET is_split_result=1 WHERE id IN (17,18)")

    x("INSERT INTO codes (id, project_id, numeric_id, name, is_universal, is_active, "
      "created_at, updated_at) VALUES (1,1,1,'Barriers',0,1,?,?), (2,1,2,'Turning point',0,1,?,?)",
      (NOW, NOW, NOW, NOW))
    for aid, sid, code in [(1, 10, 1), (2, 11, 1), (3, 12, 2), (4, 15, 2)]:
        x("INSERT INTO code_applications (id, segment_id, code_id, user_id, created_at) "
          "VALUES (?,?,?,1,?)", (aid, sid, code, NOW))

    # ── codes: rebuilt at the v1.5.3 cut, now an invariance fixture ──────────
    #
    # Two more codes at non-contiguous ids, each carrying what a DROP + RENAME can
    # lose: `CODE_GROUPED` points OUT of the table twice (a category and an
    # equivalence group — both ON DELETE SET NULL, both re-declared by the batch)
    # and has a row pointing IN from the legacy membership table, plus the plain
    # columns a partial copy would drop; `CODE_RETIRED` is inactive, a state no
    # count distinguishes from active.
    code_cols = _cols(conn, "codes")
    x("INSERT INTO codes (id, project_id, numeric_id, name, description, color, "
      "is_universal, is_active, created_at, updated_at) VALUES "
      "(?,1,3,'Resilience','Recovering after a setback','#3b82f6',0,1,?,?), "
      "(?,1,4,'Retired theme',NULL,NULL,0,0,?,?)",
      (CODE_GROUPED, NOW, NOW, CODE_RETIRED, NOW, NOW))
    if "uuid" in code_cols:
        x("UPDATE codes SET uuid=? WHERE id=?",
          ("c0de0007-0000-4000-8000-000000000007", CODE_GROUPED))
        x("UPDATE codes SET uuid=? WHERE id=?",
          ("c0de0012-0000-4000-8000-000000000012", CODE_RETIRED))
    else:
        skipped.append("code uuids")
    if "code_categories" in have and {"category_id", "category_order"} <= code_cols:
        x("INSERT INTO code_categories (id, project_id, name, display_order, created_at) "
          "VALUES (?,1,'Context',0,?)", (CATEGORY_ID, NOW))
        x("UPDATE codes SET category_id=?, category_order=1 WHERE id=?",
          (CATEGORY_ID, CODE_GROUPED))
        if "code_category_memberships" in have:
            x("INSERT INTO code_category_memberships (id, code_id, category_id, created_at) "
              "VALUES (1,?,?,?)", (CODE_GROUPED, CATEGORY_ID, NOW))
        else:
            skipped.append("code category membership")
    else:
        skipped.append("code category")
    if "code_equivalence_groups" in have and "code_equivalence_group_id" in code_cols:
        x("INSERT INTO code_equivalence_groups (id, project_id, label, canonical_code_id, "
          "created_at, updated_at) VALUES (?,1,'Coping',?,?,?)",
          (CODE_GROUP_ID, CODE_GROUPED, NOW, NOW))
        x("UPDATE codes SET code_equivalence_group_id=? WHERE id=?",
          (CODE_GROUP_ID, CODE_GROUPED))
    else:
        skipped.append("code equivalence group")
    # v1.5.3's code set as a researcher leaves one: `exhaustive` raised, and two member
    # codes — one coded by a person, one by the machine coder (below).
    if "code_sets" in have and "code_set_id" in code_cols:
        x("INSERT INTO code_sets (id, project_id, uuid, label, exhaustive, sequence_order, "
          "created_at, updated_at) VALUES (?,1,?,'Stance',1,1,?,?)",
          (CODE_SET_ID, CODE_SET_UUID, NOW, NOW))
        x(f"UPDATE codes SET code_set_id=? WHERE id IN "
          f"({','.join('?' * len(CODE_SET_MEMBERS))})", (CODE_SET_ID, *CODE_SET_MEMBERS))
    else:
        skipped.append("code set")
    # One application on each new code: the machine coder's on the grouped code, and
    # one on the inactive code, whose coding is kept when the code is retired.
    x("INSERT INTO code_applications (id, segment_id, code_id, user_id, created_at) "
      "VALUES (?,17,?,?,?), (?,18,?,1,?)",
      (APP_MACHINE, CODE_GROUPED, MACHINE_CODER if machine else 1, NOW,
       APP_RETIRED, CODE_RETIRED, NOW))

    # 🔴 The cascade canary for the `documents` rebuild, one level BELOW the rebuilt
    # table: documents → segments (ON DELETE CASCADE) → code_applications (CASCADE).
    # Counting documents cannot tell a correct rebuild from one that took the coding
    # with it; these two can.
    if "documents" in have:
        for aid, sid in ((APP_RATED_ZERO, 20), (APP_UNRATED, 21)):
            x("INSERT INTO code_applications (id, segment_id, code_id, user_id, "
              "created_at) VALUES (?,?,?,1,?)", (aid, sid, SCALE_CODE_ID, NOW))
    else:
        skipped.append("document code applications")

    # v1.5.1's #35 fixture at REAL values. It sits below --from-revision now, so its
    # arrival cannot be asserted without being vacuous; what it can do is be carried
    # across two rebuilds unchanged. The declared scale is what makes 0.0 an interior
    # neutral rather than an edge, which is the entire distinction being protected.
    code_cols, app_cols = _cols(conn, "codes"), _cols(conn, "code_applications")
    if {"magnitude_min", "magnitude_max", "magnitude_step", "magnitude_labels"} <= code_cols:
        x("UPDATE codes SET magnitude_min=?, magnitude_max=?, magnitude_step=?, "
          "magnitude_labels=? WHERE id=?", (*MAGNITUDE_SCALE, SCALE_CODE_ID))
    else:
        skipped.append("declared magnitude scale")
    if "magnitude" in app_cols:
        x("UPDATE code_applications SET magnitude=1.0 WHERE id=?", (APP_CONFLICTED,))
        x("UPDATE code_applications SET magnitude=2.0 WHERE id=?", (APP_RATED_POSITIVE,))
        if "documents" in have:
            x("UPDATE code_applications SET magnitude=0.0 WHERE id=?", (APP_RATED_ZERO,))
        # APP_UNRATED and every application of the unscaled code stay NULL —
        # UNRATED, which has to survive AS NULL and not become a rating of zero.
    else:
        skipped.append("magnitude ratings")
    if "magnitude_conflict" in app_cols:
        # We rated 1.0; the copy we merged said -1.0. Both numbers are kept.
        x("UPDATE code_applications SET magnitude_conflict=-1.0 WHERE id=?", (APP_CONFLICTED,))
    else:
        skipped.append("magnitude conflict")

    x("INSERT INTO excerpt (id, project_id, segment_id, start_offset, end_offset, "
      "created_at, updated_at) VALUES (1,1,10,NULL,NULL,?,?), (2,1,11,4,18,?,?)",
      (NOW, NOW, NOW, NOW))

    # An astral segment + a char-range quote at REPAIRED (code-point) offsets, as a
    # v1.3.2 database already holds them. Its ASCII sibling above (excerpt 2,
    # segment 11) is the other half of the pair. Both must come through untouched:
    # astral text is where a careless rebuild-and-recopy would mangle encoding.
    x("INSERT INTO segments (id, conversation_id, sequence_order, text, created_at, "
      "is_starred, is_merge_result, is_split_result) VALUES (19,1,19,?,?,0,0,0)",
      (ASTRAL_SEGMENT_TEXT, NOW))
    x("INSERT INTO excerpt (id, project_id, segment_id, start_offset, end_offset, "
      "created_at, updated_at) VALUES (?,1,19,?,?,?,?)",
      (ASTRAL_EXCERPT_ID, *ASTRAL_OFFSETS, NOW, NOW))

    x("INSERT INTO notes (id, conversation_id, segment_id, content, sequence_number, "
      "is_archived, created_at, updated_at) VALUES (1,1,10,'a note',1,0,?,?)", (NOW, NOW))

    # Notes at their REPAIRED numbering (#747 already ran below --from-revision):
    # two on one document (1 then 2) and one on an observation clip (restarts at 1).
    # Nothing in this release may renumber them.
    note_cols = _cols(conn, "notes")
    if "documents" in have and "document_id" in note_cols:
        x("INSERT INTO notes (id, document_id, segment_id, content, sequence_number, "
          "is_archived, created_at, updated_at) VALUES (2,1,20,'doc note a',1,0,?,?), "
          "(3,1,21,'doc note b',2,0,?,?)", (NOW, NOW, NOW, NOW))
    else:
        skipped.append("document notes")
    if "observations" in have and "observation_id" in note_cols:
        x("INSERT INTO observations (id, project_id, name, created_at, updated_at, "
          "media_offset_seconds) VALUES (1,1,'Site visit',?,?,0.0)", (NOW, NOW))
        x("INSERT INTO segments (id, observation_id, sequence_order, text, created_at, "
          "is_starred, is_merge_result, is_split_result) VALUES (30,1,1,'clip',?,0,0,0)", (NOW,))
        x("INSERT INTO notes (id, observation_id, segment_id, content, sequence_number, "
          "is_archived, created_at, updated_at) VALUES (4,1,30,'clip note',1,0,?,?)", (NOW, NOW))
    else:
        skipped.append("observation notes")

    # ── datasets: rebuilt at the v1.5.2 cut, now an invariance fixture ─────────
    #
    # Three datasets: two in project 1, so "at most one participant dataset per
    # project" has something to refuse, and one in a SECOND project, so an index
    # wrongly scoped to `managed_kind` alone is caught by refusing there too.
    # `PARTICIPANT_TABLE` carries v1.5.2's three columns at REAL values — a kind, a
    # sync time and a RAISED stale flag — because "they arrive NULL/0" is what v1.5.2
    # asserted and it would pass vacuously now.
    managed = False
    if "datasets" in have:
        x("INSERT INTO datasets (id, project_id, name, created_at) "
          "VALUES (?,1,'Survey',?), (?,1,'Participants',?), (?,?,'Other study',?)",
          (DS_MAIN, NOW, DS_SECOND, NOW, DS_OTHER_PROJECT, PROJECT_OTHER, NOW))
        managed = {"managed_kind", "managed_synced_at", "managed_stale"} <= _cols(conn, "datasets")
        if managed:
            x("UPDATE datasets SET managed_kind='participants', managed_synced_at=?, "
              "managed_stale=1 WHERE id=?", (NOW, PARTICIPANT_TABLE))
        else:
            skipped.append("participant table")
    else:
        skipped.append("datasets")

    # ── dataset_columns: a CHILD of v1.5.2's rebuilt `datasets` ───────────────
    #
    # Four columns on deliberately NON-CONTIGUOUS ids, each carrying a different
    # kind of dependant, because a DROP+RENAME can fail in four different ways:
    #   * dataset_values     — the FK children, and the cascade canary
    #   * recode_definitions — a second child table, on a different FK
    #   * equivalence_group  — exercises the PARTIAL unique index the migration's
    #                          own docstring flags as the reflection risk
    #   * an untouched plain column — the sibling that proves the rebuild did not
    #                          simply rewrite everything
    if "dataset_columns" in have and "datasets" in have:
        dc_cols = _cols(conn, "dataset_columns")
        extra = ", show_in_participant_profile" if "show_in_participant_profile" in dc_cols else ""
        val = ", 0" if extra else ""

        grp = "equivalence_groups" in have and "equivalence_group_id" in dc_cols
        if grp:
            x("INSERT INTO equivalence_groups (id, project_id, label, sequence_order, "
              "origin, created_at, updated_at) VALUES (1,1,'Trust items',1,'human',?,?)", (NOW, NOW))
        else:
            skipped.append("equivalence group")

        for cid, name, ctype, seq in (
            (DC_SOURCE, "Trust",           "ordinal",   1),
            (DC_TARGET, "Trust (recoded)", "numeric",   2),
            (DC_EQUIV,  "Fair",            "ordinal",   3),
            (DC_PLAIN,  "Comments",        "open_text", 4),
        ):
            src = "manual" if cid == DC_TARGET else "imported"
            x(f"INSERT INTO dataset_columns (id, dataset_id, column_text, column_type, "
              f"sequence_order, source{extra}) VALUES (?,1,?,?,?,?{val})",
              (cid, name, ctype, seq, src))
        # Exactly one column in the group: the partial index is UNIQUE on
        # (equivalence_group_id, dataset_id), so a second would be a constraint
        # violation rather than extra coverage.
        if grp:
            x("UPDATE dataset_columns SET equivalence_group_id=1 WHERE id=?", (DC_EQUIV,))

        # Row 1 carries a participant link. `dataset_rows` is a child of the REBUILT
        # `datasets` table, so this FK — and the partial unique index behind it —
        # has to come through the rebuild intact.
        x("INSERT INTO dataset_rows (id, dataset_id, participant_id, created_at) "
          "VALUES (1,?,?,?), (2,?,NULL,?)",
          (DS_MAIN, PARTICIPANT_LINKED if "participants" in have else None, NOW,
           DS_MAIN, NOW))
        vid = 1
        for rid in (1, 2):
            for cid, text in ((DC_SOURCE, "4"), (DC_TARGET, "2"),
                              (DC_EQUIV, "3"), (DC_PLAIN, "a free-text answer")):
                x("INSERT INTO dataset_values (id, row_id, column_id, value_text) "
                  "VALUES (?,?,?,?)", (vid, rid, cid, text))
                vid += 1

        if "recode_definitions" in have:
            x("INSERT INTO recode_definitions (id, column_id, name, recode_type, output_type, "
              "mapping, is_primary, is_auto_detected, sequence_order, created_at, updated_at) "
              "VALUES (1,?,'Trust 2-point','scale_map','numeric','{\"4\": 2.0}',0,0,1,?,?)",
              (DC_SOURCE, NOW, NOW))
        else:
            skipped.append("recode_definitions")

        # #1368 D4's repair finds a computed column by its FORMULA's text, so each is
        # seeded as `computed_columns` stores one: `source='computed'`, the expression,
        # the columns it reads, a `stale` flag, and a value per row (`COMPUTED_STORED`).
        if {"expression", "depends_on_column_ids", "stale"} <= dc_cols:
            for seq, (cid, (formula, stale, _)) in enumerate(REPAIR_STALE.items(), start=5):
                x(f"INSERT INTO dataset_columns (id, dataset_id, column_text, column_type, "
                  f"sequence_order, source, expression, depends_on_column_ids, stale{extra}) "
                  f"VALUES (?,1,?,'numeric',?,'computed',?,?,?{val})",
                  (cid, f"Computed {cid}", seq, formula, json.dumps([DC_SOURCE]), stale))
                for rid in (1, 2):
                    x("INSERT INTO dataset_values (id, row_id, column_id, value_text) "
                      "VALUES (?,?,?,?)", (vid, rid, cid, COMPUTED_STORED[cid]))
                    vid += 1
        else:
            skipped.append("computed columns")

        # The participant table's score column, as `participant_scores.py` writes it:
        # `source='managed'` and a `managed_spec` naming the code it scores. That
        # code id points INTO `codes`, from inside a JSON blob no FK can see — so ids
        # preserved across any rebuild of `codes` are what keep it true. One
        # participant row carries a score, which is what a refresh leaves.
        if managed and "managed_spec" in dc_cols:
            x(f"INSERT INTO dataset_columns (id, dataset_id, column_text, column_type, "
              f"sequence_order, source, managed_spec{extra}) "
              f"VALUES (?,?,'Barriers (score)','numeric',1,'managed',?{val})",
              (DC_SCORE, PARTICIPANT_TABLE, MANAGED_SPEC))
            x("INSERT INTO dataset_rows (id, dataset_id, participant_id, created_at) "
              "VALUES (3,?,?,?)", (PARTICIPANT_TABLE, PARTICIPANT_SPARE, NOW))
            x("INSERT INTO dataset_values (id, row_id, column_id, value_text) "
              "VALUES (?,3,?,'1.5')", (vid, DC_SCORE))
        else:
            skipped.append("participant score column")
    else:
        skipped.append("dataset_columns")

    # The fixture has to be what NOTE_SEQ_INVARIANT SAYS it is. Without this the
    # constant is prose: the before/after comparison below would still pass by
    # comparing a drifted seed against itself, and the documented numbering
    # (1..N per parent, restarting for each) would be asserted by nothing.
    expected_seq = dict(NOTE_SEQ_INVARIANT)
    drift = [(nid, seq) for nid, seq in
             conn.execute("SELECT id, sequence_number FROM notes ORDER BY id")
             if expected_seq.get(nid) != seq]
    if drift:
        raise SystemExit(
            f"seed drift: notes {drift} contradict NOTE_SEQ_INVARIANT "
            f"({NOTE_SEQ_INVARIANT}) — fix the seed or the constant, not this check")
    # The same for the repair's fixture, which must also give the repair something to
    # DO: a fixture in which no flag has to move is inert against a no-op repair.
    if "computed columns" not in skipped:
        seeded = dict(conn.execute(
            f"SELECT id, stale FROM dataset_columns WHERE id IN "
            f"({','.join('?' * len(REPAIR_STALE))})", tuple(REPAIR_STALE)).fetchall())
        drift = {cid: seeded.get(cid) for cid, (_, was, _) in REPAIR_STALE.items()
                 if seeded.get(cid) != was}
        if drift:
            raise SystemExit(f"seed drift: computed columns {drift} contradict REPAIR_STALE "
                             "— fix the seed or the constant, not this check")
        if not any(was != after for _, was, after in REPAIR_STALE.values()):
            raise SystemExit("REPAIR_STALE moves no flag, so the repair's checks are inert")

    conn.commit()
    snap = {
        "counts": {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                   for t in sorted(have & {
                       "users", "projects", "participants", "conversations",
                       "documents", "segments",
                       "codes", "code_applications", "excerpt", "notes",
                       "code_categories", "code_equivalence_groups",
                       "code_category_memberships", "code_sets",
                       "datasets", "dataset_columns", "dataset_rows", "dataset_values",
                       "recode_definitions", "equivalence_groups"})},
        # Every PRE-EXISTING column of every row, read from the database rather than
        # listed, so a column nobody named here is still compared.
        "full_rows": {t: (cols, _full_rows(conn, t, cols))
                      for t in FULL_ROW_TABLES if t in have
                      for cols in [sorted(_cols(conn, t))]},
        "fks": {t: _fks(conn, t) for t in FK_TABLES if t in have},
        "apps": conn.execute(
            "SELECT id, segment_id, code_id FROM code_applications ORDER BY id").fetchall(),
        "segment_links": conn.execute(
            "SELECT id, conversation_id, document_id, merged_into_id, split_into_id "
            "FROM segments ORDER BY id").fetchall(),
        "segment_text": conn.execute("SELECT id, text FROM segments ORDER BY id").fetchall(),
        # ⚠️ v1.4.0: the astral excerpt is now INCLUDED. Its repair ran below
        # --from-revision, so this release must leave it exactly where it is.
        "excerpts": conn.execute(
            "SELECT id, segment_id, start_offset, end_offset FROM excerpt "
            "ORDER BY id").fetchall(),
        # ⚠️ v1.4.0: `sequence_number` is now INCLUDED, for the same reason.
        "notes": conn.execute(
            "SELECT id, conversation_id, segment_id, sequence_number "
            "FROM notes ORDER BY id").fetchall(),
        # A table rebuilt at v1.5.2 and both of its child tables, by identity.
        "dataset_columns": conn.execute(
            "SELECT id, dataset_id, column_text, column_type, sequence_order, source, "
            "equivalence_group_id FROM dataset_columns ORDER BY id").fetchall()
            if "dataset_columns" in have else [],
        "dataset_values": conn.execute(
            "SELECT id, row_id, column_id, value_text FROM dataset_values ORDER BY id"
        ).fetchall() if "dataset_values" in have else [],
        "recode_defs": conn.execute(
            "SELECT id, column_id, name, is_primary FROM recode_definitions ORDER BY id"
        ).fetchall() if "recode_definitions" in have else [],
        # v1.5.2's two REBUILT tables, by identity. A rebuild that renumbers instead of
        # preserving ids breaks every child FK, and both of these are parents.
        "documents": conn.execute(
            "SELECT id, project_id, name, source_filename FROM documents ORDER BY id"
        ).fetchall() if "documents" in have else [],
        "datasets": conn.execute(
            "SELECT id, project_id, name FROM datasets ORDER BY id"
        ).fetchall() if "datasets" in have else [],
        "participants": conn.execute(
            "SELECT id, project_id, identifier, display_name FROM participants ORDER BY id"
        ).fetchall() if "participants" in have else [],
        # A child of the rebuilt `datasets`, carrying the participant FK across it.
        "dataset_rows": conn.execute(
            "SELECT id, dataset_id, participant_id FROM dataset_rows ORDER BY id"
        ).fetchall() if "dataset_rows" in have else [],
        # v1.5.1's fixture, which must come through UNTOUCHED — 0.0 still 0.0 and
        # NULL still NULL. `same()` stringifies, so "0.0" and "None" cannot collide.
        "magnitudes": conn.execute(
            "SELECT id, magnitude, magnitude_conflict FROM code_applications ORDER BY id"
        ).fetchall() if "magnitude" in _cols(conn, "code_applications") else [],
        "code_scales": conn.execute(
            "SELECT id, magnitude_min, magnitude_max, magnitude_step, magnitude_labels "
            "FROM codes ORDER BY id"
        ).fetchall() if "magnitude_min" in _cols(conn, "codes") else [],
        # Every index on `INDEXED_TABLES`, so a
        # silently-dropped one is caught. A dropped UNIQUE index leaves a constraint
        # unenforced and nothing else looks wrong.
        "indexes": {t: _indexes(conn, t) for t in INDEXED_TABLES if t in have},
    }
    conn.close()
    if skipped:
        print(f"  (skipped, absent at this revision: {', '.join(skipped)})")
    return snap


def verify(db_path: Path, before: dict) -> list[str]:
    fails = []
    header = db_path.read_bytes()[:15]
    if header == b"SQLite format 3":
        fails.append("DB is PLAINTEXT after the upgrade — encryption was lost")

    conn = _connect(db_path)
    x = conn.execute

    if fk := x("PRAGMA foreign_key_check").fetchall():
        fails.append(f"foreign_key_check violations: {fk[:5]}")
    if (integ := x("PRAGMA integrity_check").fetchone()[0]) != "ok":
        fails.append(f"integrity_check: {integ}")

    for t, want in before["counts"].items():
        got = x(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        if got != want:
            fails.append(f"count:{t} {want} -> {got}")

    def same(label, sql, key):
        got = [list(map(str, r)) for r in x(sql).fetchall()]
        want = [list(map(str, r)) for r in before[key]]
        if got != want:
            fails.append(f"{label}\n     before={want}\n     after ={got}")

    same("code_applications parentage",
         "SELECT id, segment_id, code_id FROM code_applications ORDER BY id", "apps")
    same("segment links (parent + merge/split)",
         "SELECT id, conversation_id, document_id, merged_into_id, split_into_id "
         "FROM segments ORDER BY id", "segment_links")
    same("segment text", "SELECT id, text FROM segments ORDER BY id", "segment_text")
    same("excerpt shape, astral offsets INCLUDED (this release must not touch them)",
         "SELECT id, segment_id, start_offset, end_offset FROM excerpt ORDER BY id",
         "excerpts")
    same("notes parentage AND numbering (this release must not renumber)",
         "SELECT id, conversation_id, segment_id, sequence_number FROM notes ORDER BY id",
         "notes")
    same("dataset_columns rows (rebuilt at v1.5.2 — ids must stay preserved)",
         "SELECT id, dataset_id, column_text, column_type, sequence_order, source, "
         "equivalence_group_id FROM dataset_columns ORDER BY id", "dataset_columns")
    same("dataset_values (every cell kept, and the repair recomputes none of them)",
         "SELECT id, row_id, column_id, value_text FROM dataset_values ORDER BY id",
         "dataset_values")
    same("recode_definitions parentage (a v1.5.2-rebuilt table's second child)",
         "SELECT id, column_id, name, is_primary FROM recode_definitions ORDER BY id",
         "recode_defs")
    same("documents rows (rebuilt at v1.5.2 — they are segment parents)",
         "SELECT id, project_id, name, source_filename FROM documents ORDER BY id",
         "documents")
    same("datasets rows (rebuilt at v1.5.2 — they are column parents)",
         "SELECT id, project_id, name FROM datasets ORDER BY id", "datasets")
    same("participants (no rebuild may disturb the shared identity spine)",
         "SELECT id, project_id, identifier, display_name FROM participants ORDER BY id",
         "participants")
    same("dataset_rows participant links (the FK crossing v1.5.2's `datasets` rebuild)",
         "SELECT id, dataset_id, participant_id FROM dataset_rows ORDER BY id",
         "dataset_rows")
    same("magnitude ratings (0.0 stays 0.0, NULL stays UNRATED)",
         "SELECT id, magnitude, magnitude_conflict FROM code_applications ORDER BY id",
         "magnitudes")
    same("declared rating scales (ON `codes` — the scale 0.0 is interior to)",
         "SELECT id, magnitude_min, magnitude_max, magnitude_step, magnitude_labels "
         "FROM codes ORDER BY id", "code_scales")

    # ── Every PRE-EXISTING column, every row, of the tables this cut can touch ──
    #
    # 🔴 The check a rebuild most needs and the one a hand-listed SELECT cannot give:
    # a copy that dropped ONE column's data keeps every count, id and parent link.
    # The column list was read from the database at seed time, so a column that
    # exists but nobody thought to name is compared too. New columns are not in it;
    # what they must hold is asserted separately below. The repair's rows are compared
    # against what they must BECOME (`EXPECTED_REWRITES`).
    for table, (cols, was) in before["full_rows"].items():
        missing = [c for c in cols if c not in _cols(conn, table)]
        if missing:
            fails.append(f"`{table}` LOST column(s) {missing} in the upgrade — every row's "
                         "value for them is gone")
            continue
        want = _expected_after(table, cols, was)
        got = _full_rows(conn, table, cols)
        if got != want:
            diff = [(w, g) for w, g in zip(want, got) if w != g]
            first = (f"\n     expected={diff[0][0]}\n     after   ={diff[0][1]}"
                     if diff else "")
            fails.append(
                f"`{table}`: {len(diff) or 'the set of'} row(s) differ from what the "
                f"upgrade must leave (rows {len(want)} -> {len(got)}; columns {cols}){first}")

    # ── Foreign keys: `codes`' own, and its two children's ────────────────────
    #
    # One lost or re-declared with another ON DELETE is invisible to every count until
    # something is deleted — and a category delete that CASCADEd instead of SET NULL
    # would take its codes and, at runtime, their coding.
    for table, was in before["fks"].items():
        now = _fks(conn, table)
        for fk in was:
            if fk not in now:
                same_col = [n for n in now if n[1] == fk[1]]
                fails.append(
                    f"FK on `{table}.{fk[1]}` → `{fk[0]}` did not survive the upgrade "
                    f"(ON DELETE {fk[4]})" +
                    (f"; it now reads {same_col}" if same_col else "; it is GONE"))
    for (table, col), (ref, on_delete) in NEW_FKS.items():
        got = [fk for fk in _fks(conn, table) if fk[1] == col]
        if not got:
            fails.append(f"`{table}.{col}` has no FK to `{ref}` at all")
        elif got[0][0] != ref or got[0][4] != on_delete:
            fails.append(f"`{table}.{col}` → `{got[0][0]}` is ON DELETE {got[0][4]}, not "
                         f"{on_delete}")

    # ── What this cut must have ADDED, and the VALUE each new column holds ─────
    #
    # The rows must not move (asserted above); what must be different is the SHAPE,
    # and what each new column arrives HOLDING is the assertion no count, parentage or
    # integrity check can make. Per COLUMN, with each one's own reason — v1.5.2's
    # `managed_stale` showed that "every new column arrives empty" is not a rule.
    for table, expected in NEW_COLUMNS.items():
        have_cols = _cols(conn, table)
        missing = [c for c in expected if c not in have_cols]
        if missing:
            fails.append(f"{table} is missing {missing} after the upgrade")
            continue
        rows = x(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        if not rows:
            fails.append(f"{table} has NO rows, so what its new columns hold "
                         "proves nothing — seed one before trusting this run")
            continue
        for col, (want, why) in expected.items():
            if want is IDENTITY:
                vals = [r[0] for r in x(f"SELECT {col} FROM {table} ORDER BY id")]
                unusable = sum(1 for v in vals
                               if not (isinstance(v, str) and 0 < len(v) <= 36))
                shared = len(vals) - len(set(vals))
                if unusable:
                    fails.append(
                        f"{unusable} of {len(vals)} pre-existing {table} row(s) came out of "
                        f"the migration with no usable {col} — {why}")
                elif shared:
                    fails.append(
                        f"{shared} pre-existing {table} row(s) came out of the migration "
                        f"sharing a {col} with another — two people would read as one")
                continue
            if want is None:
                bad = x(f"SELECT COUNT(*) FROM {table} WHERE {col} IS NOT NULL").fetchone()[0]
            else:
                bad = x(f"SELECT COUNT(*) FROM {table} "
                        f"WHERE {col} IS NULL OR {col} != ?", (want,)).fetchone()[0]
            if bad:
                fails.append(
                    f"{bad} pre-existing {table} row(s) came out of the migration "
                    f"with {col} not {want!r} — {why}")
    for table, why in NEW_TABLES_EMPTY.items():
        if table not in _tables(conn):
            fails.append(f"table `{table}` was never created")
        elif n := x(f"SELECT COUNT(*) FROM {table}").fetchone()[0]:
            fails.append(f"`{table}` arrived holding {n} row(s) — {why}")

    # ── The REPAIR (#1368 D4, `b5d1f7a3c9e2`): exactly the shaped formulas marked ──
    #
    # The full-row comparison above already expects these values; this says which
    # formula failed and why it matters, in the researcher's terms.
    for cid, (formula, was, want) in REPAIR_STALE.items():
        got = x("SELECT stale FROM dataset_columns WHERE id=?", (cid,)).fetchone()
        if got is None:
            fails.append(f"#1368 D4: the computed column `{formula}` is GONE after the upgrade")
        elif got[0] != want:
            if want and not was:
                why = ("it compares a column with a quoted text, so its stored values are "
                       "the old evaluator's and nothing would say so")
            elif want:
                why = "it was out of date before the upgrade, and a stale column stays stale"
            else:
                why = ("it compares no column with a quoted text, so the mark says "
                       "'out of date' about a column that is not")
            fails.append(f"#1368 D4: `{formula}` arrived stale={got[0]!r}, not {want} — {why}")

    # v1.4.0's provenance fields are BELOW --from-revision: present before this
    # release starts, so they are checked as INVARIANT, never as evidence anything ran.
    dc_cols = _cols(conn, "dataset_columns")
    for c in V140_COLUMNS:
        if c not in dc_cols:
            fails.append(f"v1.4.0 column `{c}` vanished — this release must not touch it")
    if V140_INDEX not in _indexes(conn, "dataset_columns"):
        fails.append(f"v1.4.0 index `{V140_INDEX}` vanished — this release must not touch it")

    # ── Indexes: every one that existed before must still exist ───────────────
    #
    # 🔴 A dropped index leaves a UNIQUE constraint unenforced, and nothing else about
    # the database looks wrong afterwards (a table rebuild is the usual way to lose
    # one; this cut has none, so this guards against a migration that drops one
    # outright). A partial one must still carry its `WHERE` — the same name over a
    # different predicate is a different constraint.
    for table, was in before["indexes"].items():
        now = _indexes(conn, table)
        for name, sql in was.items():
            if name not in now:
                # Say which it was. A dropped UNIQUE index leaves a CONSTRAINT
                # unenforced, which is a correctness failure; a dropped plain index
                # costs speed. Reporting either as the other sends the next reader
                # to the wrong question.
                cost = ("a UNIQUE constraint is now UNENFORCED"
                        if "unique" in sql.lower() else
                        "a lookup it backed is now a table scan")
                fails.append(
                    f"index `{name}` was LOST in the rebuild of `{table}` — batch "
                    f"reflection is supposed to copy it, and {cost}: {sql}")
            elif " ".join(sql.split()) != " ".join(now[name].split()):
                fails.append(f"index `{name}` on `{table}` changed definition\n"
                             f"     before={sql}\n     after ={now[name]}")

    # What this cut must CREATE: on which columns, and whether it must — or must NOT —
    # be UNIQUE. Read from the pragmas, not the statement's text.
    for name, (table, columns, unique, why) in NEW_INDEXES.items():
        listed = ({r[1]: bool(r[2]) for r in x(f"PRAGMA index_list({table})")}
                  if table in _tables(conn) else {})
        if name not in listed:
            fails.append(f"index `{name}` on `{table}` was never created")
            continue
        covers = tuple(r[2] for r in x(f"PRAGMA index_info({name})"))
        if covers != columns:
            fails.append(f"index `{name}` covers {covers}, not {columns}")
        if listed[name] != unique:
            fails.append(f"index `{name}` is {'UNIQUE' if listed[name] else 'not unique'}, "
                         f"and must {'be' if unique else 'NOT be'} — {why}")

    # ══ BEHAVIOURAL: the new constraints actually DO what they declare ═══════
    #
    # Reflecting a constraint back only re-reads what the migration wrote. These
    # checks exercise it instead, with foreign keys ON, as the app runs. ⚠️ **They
    # all MUTATE the database, so every comparison above must already have run.**
    conn.execute("PRAGMA foreign_keys=ON")

    # #1352 — `ix_users_uuid` must refuse a second coder holding someone's identity, and
    # still accept coders holding none: NULL stays legal, because a row written around
    # the ORM default has no identity and the import then falls back to the name rules.
    if "uuid" in _cols(conn, "users"):
        lead = x("SELECT uuid FROM users WHERE id=?", (LEAD_CODER,)).fetchone()
        if not (lead and lead[0]):
            fails.append("(`ix_users_uuid`'s uniqueness not exercised: the seeded coder has "
                         "no uuid — see the failures above)")
        else:
            try:
                x("UPDATE users SET uuid=? WHERE id=?", (lead[0], MACHINE_CODER))
                conn.commit()
                fails.append("#1352: two coders were stored with ONE uuid — `ix_users_uuid` "
                             "does not enforce uniqueness, so a merge could land one "
                             "person's codings on another")
            except Exception:
                conn.rollback()
        try:
            for uid in NULL_IDENTITY_CODERS:
                x("INSERT INTO users (id, username, is_admin, created_at) VALUES (?,?,0,?)",
                  (uid, f"No identity {uid}", NOW))
            conn.commit()
        except Exception as exc:
            conn.rollback()
            fails.append(f"#1352: two coders without a uuid were refused ({exc}) — NULL "
                         "must stay legal, or a write that omits it fails")

    # #1190 — two withdrawals in one project, remembered by a participant's uuid and by
    # an identifier's hash. Both must be accepted: a project withdraws many people.
    if "removal_tombstones" in _tables(conn):
        try:
            x("INSERT INTO removal_tombstones (project_uuid, entity_type, entity_uuid, "
              "identifier_hash, reason, created_at) VALUES "
              "(?,'participant',?,NULL,'withdrawal',?), (?,'participant',NULL,?,'withdrawal',?)",
              (TOMBSTONE_PROJECT_UUID, "9a7e0001-0000-4000-8000-000000000007", NOW,
               TOMBSTONE_PROJECT_UUID, "ab" * 32, NOW))
            conn.commit()
        except Exception as exc:
            conn.rollback()
            fails.append(f"#1190: a second withdrawal in one project was refused ({exc}) — "
                         "the person withdrawing would stay in every later merge and import")

    # v1.5.3's code set (row 48) — a set written the way a writer that omits
    # `exhaustive` would. The default is visible only to a write; 1 would turn every
    # blank on the set into MISSING data.
    if "code_sets" in _tables(conn) and "code_set_id" in _cols(conn, "codes"):
        x("INSERT INTO code_sets (id, project_id, uuid, label, created_at, updated_at) "
          "VALUES (?,1,?,'Tone',?,?)",
          (CODE_SET_FRESH, "5c0de5e7-0000-4000-8000-000000000008", NOW, NOW))
        conn.commit()
        ex = x("SELECT exhaustive FROM code_sets WHERE id=?", (CODE_SET_FRESH,)).fetchone()[0]
        if ex != 0:
            fails.append(f"row 48: a code set written without `exhaustive` reads {ex!r}, "
                         "not 0 — a blank passage on it would count as MISSING data "
                         "rather than the answer 'none of these'")
        # The uuid is what a merge matches a set on; two sets sharing one would merge
        # a colleague's set into the wrong one.
        try:
            x("INSERT INTO code_sets (id, project_id, uuid, label, created_at, updated_at) "
              "VALUES (?,1,?,'Stance (copy)',?,?)",
              (CODE_SET_DUPLICATE, CODE_SET_UUID, NOW, NOW))
            conn.commit()
            fails.append("row 48: two code sets were stored with ONE uuid — "
                         "`ix_code_sets_uuid` does not enforce uniqueness")
        except Exception:
            conn.rollback()

        # 🔴 Deleting a set must leave its codes, and their coding, exactly where they
        # were. The seeded set holds two: one with a person's applications, one with
        # the MACHINE coder's.
        members = CODE_SET_MEMBERS
        marks = ",".join("?" * len(members))
        if not x("SELECT 1 FROM code_sets WHERE id=?", (CODE_SET_ID,)).fetchone():
            fails.append("(row 48's ON DELETE SET NULL not exercised: the seeded code set "
                         "was already gone — see the failures above)")
        else:
            coded = x(f"SELECT COUNT(*) FROM code_applications WHERE code_id IN ({marks})",
                      members).fetchone()[0]
            x("DELETE FROM code_sets WHERE id=?", (CODE_SET_ID,))
            conn.commit()
            left = x(f"SELECT id, code_set_id FROM codes WHERE id IN ({marks}) ORDER BY id",
                     members).fetchall()
            still = x(f"SELECT COUNT(*) FROM code_applications WHERE code_id IN ({marks})",
                      members).fetchone()[0]
            if len(left) != len(members):
                fails.append(
                    f"row 48 ON DELETE SET NULL: deleting a code set DELETED "
                    f"{len(members) - len(left)} of its codes, and {coded - still} of {coded} "
                    "codings with them — the FK behaves as CASCADE")
            elif any(r[1] is not None for r in left):
                fails.append(f"row 48 ON DELETE SET NULL did not fire: {left}")
            elif still != coded:
                fails.append(f"row 48: deleting a code set lost {coded - still} codings")

    # v1.5.3's rebuild RE-DECLARED `codes`' two SET NULL FKs. Deleting what a code
    # points at must leave the code — and its machine coder's application — in place.
    for parent, pid, col in (("code_categories", CATEGORY_ID, "category_id"),
                             ("code_equivalence_groups", CODE_GROUP_ID,
                              "code_equivalence_group_id")):
        if parent in _tables(conn) and col in _cols(conn, "codes") and \
                x(f"SELECT 1 FROM {parent} WHERE id=?", (pid,)).fetchone():
            # ⚠️ Only a check whose subject still EXISTS can blame its own delete.
            # When an earlier failure already took the code or its coding (measured:
            # a CASCADE set FK, or foreign keys ON during the rebuild), this delete
            # would be reported as the cause — the wrong question for the reader.
            if not (x("SELECT 1 FROM codes WHERE id=?", (CODE_GROUPED,)).fetchone() and
                    x("SELECT 1 FROM code_applications WHERE id=?",
                      (APP_MACHINE,)).fetchone()):
                fails.append(f"(`codes.{col}` ON DELETE not exercised: code {CODE_GROUPED} "
                             "or its coding was already gone — see the failures above)")
                continue
            x(f"DELETE FROM {parent} WHERE id=?", (pid,))
            conn.commit()
            code = x(f"SELECT {col} FROM codes WHERE id=?", (CODE_GROUPED,)).fetchone()
            if code is None:
                fails.append(f"deleting a row of `{parent}` DELETED the code that pointed "
                             f"at it — `codes.{col}` came out of the rebuild as CASCADE")
            elif code[0] is not None:
                fails.append(f"deleting a row of `{parent}` left `codes.{col}` = {code[0]} "
                             "— its ON DELETE SET NULL did not survive the rebuild")
            elif not x("SELECT 1 FROM code_applications WHERE id=?",
                       (APP_MACHINE,)).fetchone():
                fails.append(f"deleting a row of `{parent}` lost the coding on its code")

    # v1.5.2's checks below are RETAINED as coverage of the BUILT database, not as
    # claims about this cut: the constraints they exercise were created below
    # --from-revision.
    #
    # Row 46: deleting a participant must degrade the document's link, never take
    # the document. This is the withdrawal case — `withdrawal_redaction.py` UNLINKS
    # documents and reports them precisely because "about this person" is true of a
    # workplan they wrote AND of a document that merely names them. A CASCADE here
    # would delete the document and every segment and code application under it.
    doc_has_link = "participant_id" in _cols(conn, "documents")
    participant_seeded = x("SELECT 1 FROM participants WHERE id=?",
                           (PARTICIPANT_LINKED,)).fetchone()
    if doc_has_link and participant_seeded and \
            x("SELECT 1 FROM documents WHERE id=1").fetchone():
        linked = x("SELECT participant_id FROM documents WHERE id=1").fetchone()
        if not linked or linked[0] != PARTICIPANT_LINKED:
            fails.append(f"row 46: the document's seeded participant link reads {linked} "
                         f"after the upgrade, not {PARTICIPANT_LINKED}")
        else:
            x("DELETE FROM participants WHERE id=?", (PARTICIPANT_LINKED,))
            conn.commit()
            doc = x("SELECT participant_id FROM documents WHERE id=1").fetchone()
            if doc is None:
                fails.append(
                    "row 46 ON DELETE SET NULL: the DOCUMENT was deleted along with the "
                    "participant — the FK is behaving as CASCADE, so withdrawing a "
                    "participant would take their documents and all coding under them")
            elif doc[0] is not None:
                fails.append("row 46 ON DELETE SET NULL did not fire: "
                             f"documents.participant_id={doc[0]}")
            # The same FK family on a child of v1.5.2's rebuilt `datasets` table.
            row = x("SELECT participant_id FROM dataset_rows WHERE id=1").fetchone()
            if row is None:
                fails.append("the dataset ROW was deleted with the participant — its "
                             "ON DELETE SET NULL did not survive the `datasets` rebuild")
            elif row[0] is not None:
                fails.append(f"dataset_rows.participant_id did not degrade: {row[0]}")

    # Row 45 (i).3: at most one participant dataset PER PROJECT. The index is what
    # makes that structural rather than something a service has to remember, so it
    # has to refuse a second one in a project — `PARTICIPANT_TABLE` is the first —
    # and permit one in the next.
    if "managed_kind" in _cols(conn, "datasets") and \
            x("SELECT 1 FROM datasets WHERE id=? AND managed_kind='participants'",
              (PARTICIPANT_TABLE,)).fetchone():
        try:
            x("UPDATE datasets SET managed_kind='participants' WHERE id=?", (DS_MAIN,))
            conn.commit()
            fails.append(
                "uq_datasets_project_managed_kind did NOT refuse a SECOND participant "
                "dataset in the same project — the index is not unique (or not there), "
                "and two tool-maintained tables would compete over one participant spine")
        except Exception:
            conn.rollback()
        try:
            x("UPDATE datasets SET managed_kind='participants' WHERE id=?",
              (DS_OTHER_PROJECT,))
            conn.commit()
        except Exception as exc:
            conn.rollback()
            fails.append(
                "uq_datasets_project_managed_kind refused a participant dataset in a "
                f"DIFFERENT project — it is scoped to managed_kind alone: {exc}")

    # v1.4.0's `derived_from_column_id`. ⚠️ RETAINED as coverage of the BUILT DB,
    # not as a claim about this release: `d7f3a91c8b24` sits below --from-revision,
    # so the FK it declares was created before these migrations ran. It still proves
    # the constraint survives an upgrade, and it costs nothing.
    # ⚠️ Runs LAST of all: its delete cascades into `dataset_values`.
    if all(c in dc_cols for c in V140_COLUMNS) and \
            x("SELECT 1 FROM dataset_columns WHERE id=?", (DC_SOURCE,)).fetchone():
        x("UPDATE dataset_columns SET derived_from_column_id=?, derived_via=? WHERE id=?",
          (DC_SOURCE, "Trust 2-point", DC_TARGET))
        x("DELETE FROM dataset_columns WHERE id=?", (DC_SOURCE,))
        conn.commit()
        got = x("SELECT derived_from_column_id, derived_via FROM dataset_columns "
                "WHERE id=?", (DC_TARGET,)).fetchone()
        if got is None:
            fails.append("ON DELETE SET NULL: the DEPENDENT column was deleted too — "
                         "the FK is behaving as CASCADE")
        elif got[0] is not None:
            fails.append(f"ON DELETE SET NULL did not fire: derived_from_column_id={got[0]}")
        elif got[1] != "Trust 2-point":
            fails.append(f"the snapshotted rule name was lost with the link: {got[1]!r} "
                         "— `derived_via` is a string precisely so it survives this")

    conn.close()
    return fails


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from-revision", required=True,
                    help="Alembic head of the PREVIOUS release")
    ap.add_argument("--to-revision", default="head")
    args = ap.parse_args()

    try:
        import sqlcipher3  # noqa: F401
    except ImportError:
        print("sqlcipher3 is not installed — it is pinned in requirements.txt", file=sys.stderr)
        return 1

    tmp = Path(tempfile.mkdtemp(prefix="mm-migration-rehearsal-"))
    db = tmp / "rehearsal.db"
    env = {
        **os.environ,
        "MM_DATABASE_PATH": str(db),
        "MM_ENCRYPTION_ENABLED": "true",
        "MM_ENCRYPTION_KEY": KEY_HEX,
        "MM_BACKUP_DIR": str(tmp / "backups"),
        "MM_DATA_DIR": str(tmp / "data"),
    }
    try:
        print(f"1. building an ENCRYPTED DB at {args.from_revision} …")
        _alembic(env, "upgrade", args.from_revision)
        if db.read_bytes()[:15] == b"SQLite format 3":
            print("   FAIL: the DB is plaintext — encryption env was not honoured", file=sys.stderr)
            return 1

        print("2. seeding the shapes a rebuild can damage, and the rows a repair must move …")
        before = seed(db)
        print("   " + ", ".join(f"{t}={n}" for t, n in before["counts"].items()))

        print(f"3. upgrading to {args.to_revision} …")
        _alembic(env, "upgrade", args.to_revision)

        print("4. verifying …")
        fails = verify(db, before)
        if fails:
            print(f"\n❌ {len(fails)} FAILED:")
            for f in fails:
                print("  - " + f)
            print(f"\nDB kept for inspection: {db}")
            return 1
        print("\n✅ data, parent links, encryption and integrity all survived the upgrade")
    except Exception:
        print(f"\nDB kept for inspection: {db}", file=sys.stderr)
        raise
    else:
        # Only clean up on a clean pass — a failure's DB is the evidence.
        shutil.rmtree(tmp, ignore_errors=True)
        return 0
    return 1


if __name__ == "__main__":
    code = main()
    raise SystemExit(code)
