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

    python scripts/migration_rehearsal.py --from-revision d3f8b6e2a915   # v1.5.3

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


# ── What THIS release's migration must do ────────────────────────────────────
#
# ⚠️ **Review this block at every cut, exactly like `--from-revision`.** It is the
# half the script was missing at v1.3.1: v1.3.0 carried only STRUCTURAL migrations
# (table rebuilds), where "every row and every link is unchanged" is the whole of
# correctness. A DATA-REPAIR migration inverts that — the rows it is supposed to
# rewrite MUST move, and a corpus on which it no-ops proves nothing while exiting 0.
#
# ── The cut after v1.5.3 (rehearsed 2026-09-25) — ONE REBUILD, and it is `codes` ──
#
# `--from-revision d3f8b6e2a915` — v1.5.3's head. v1.5.3 carried NO migrations, so
# this is also v1.5.2's head, and everything v1.5.2's block asserted as ARRIVING now
# exists before the upgrade starts. TWO migrations:
#
#   e4a9c7b21f68  code_sets (a new table)             REBUILD of `codes`   (row 48)
#                 + codes.code_set_id → code_sets, ON DELETE SET NULL
#   f5b2d8c47e13  users.machine_provenance            plain ADD COLUMN     (row 49)
#
# 🔴 **THE REBUILT TABLE IS THE PARENT OF EVERY CODING.** v1.5.2 rebuilt two tables
# one and two levels above the coded spine; this cut rebuilds the table the spine
# hangs from directly:
#
#   codes → code_applications          (ON DELETE CASCADE)  every coding and rating
#         → code_category_memberships  (ON DELETE CASCADE)  the legacy M2M, still a table
#
# If `PRAGMA foreign_keys` were ever left ON during the rebuild, SQLite's implicit
# DELETE would take every coding in the database with it, and the app would still
# open. **So the seed puts applications on FOUR codes** — one by a MACHINE coder,
# one on an inactive code — at NON-CONTIGUOUS ids (1, 2, 7, 12), because a copy
# that renumbered instead of preserving ids would re-point applications at other
# codes and keep every count.
#
# **A rebuild can lose three things no count can see, so each is compared whole:**
#   * a COLUMN's data — `codes` carries the four magnitude-scale columns, `uuid`,
#     `category_order` and more. `FULL_ROW_TABLES` compares EVERY pre-existing column
#     of every seeded row, so a column added to `codes` later is covered without
#     anyone remembering to list it here.
#   * an INDEX — `ix_codes_project_numeric` and `ix_codes_uuid` are UNIQUE, and a
#     dropped one leaves a constraint unenforced with nothing else looking wrong.
#   * a FOREIGN KEY — batch reflection re-declares `codes`' outbound FKs (project
#     CASCADE, category SET NULL, equivalence group SET NULL); a lost one is silent
#     until something is deleted. `FK_TABLES` compares `PRAGMA foreign_key_list`
#     before and after, for `codes` AND for the two children that point at it.
#
# ── What must ARRIVE, and what each must arrive HOLDING ──────────────────────
#
#   * `codes.code_set_id` MUST be NULL. Membership in a set is a CLAIM — "this code
#     is one of k mutually exclusive values" — and it changes what the Reliability
#     tab computes; a default would assert one nobody made.
#   * `users.machine_provenance` MUST be NULL, on the seeded MACHINE coder too. The
#     migration's own docstring: NULL is the honest state for a machine whose
#     configuration was never recorded, and nothing may infer one.
#   * `code_sets` MUST exist and be EMPTY. A migration that fabricated a set would
#     reclassify coding that already exists.
#   * 🔴 `code_sets.exhaustive` MUST default to 0 for a row that omits it. Set, it
#     makes a passage nobody assigned MISSING data instead of the answer "none of
#     these", so a default of 1 would silently change every figure for a set written
#     by anything that omits the column. A declared default is visible only to a
#     WRITE, so this is checked by inserting one after the upgrade.
#   * 🔴 `fk_codes_code_set_id` MUST be ON DELETE SET NULL. Deleting a set has to
#     leave its codes as ordinary codes; a CASCADE would delete the codes and — at
#     runtime, where `foreign_keys` is ON — every coding on them. Checked by deleting
#     a set after the upgrade with foreign keys ON, as the app runs.
#   * three new indexes, `ix_code_sets_uuid` UNIQUE (by its statement, and by a
#     duplicate it has to refuse).
#
# ── v1.5.2's fixtures CHANGE SIDES ────────────────────────────────────────────
#
# 🔴 `d3f8b6e2a915` IS `--from-revision`, so `documents.participant_id`, the three
# `managed_*` columns on `datasets` and `dataset_columns.managed_spec` exist BEFORE
# these migrations start. **v1.5.2's "they arrive NULL" now passes VACUOUSLY —
# MEASURED: the block as v1.5.2 left it exited 0 against this cut's code-set
# migration switched to ON DELETE CASCADE.** They are seeded with REAL values instead —
# a participant table (`DS_SECOND`) with a sync time, a raised stale flag and a score
# column whose `managed_spec` names a code id IN THE REBUILT TABLE — and asserted
# invariant. v1.5.2's behavioural checks (the document link's SET NULL, one
# participant table per project) stay, as coverage of the BUILT database rather than
# as claims about this cut.
#
# ⚠️ The v1.3.1 repairs (`a1b2c3d4e5f7` astral offsets, `b8e4c2a70d19` note
# numbering), v1.4.0's provenance columns and v1.5.1's #35 ratings remain seeded at
# real values and asserted invariant. **The #35 fixture is this cut's sharpest, not
# inherited coverage:** the scale lives ON the rebuilt table and the ratings on its
# child —
#
#   * a rating of **0.0** on a declared −2…+2 scale. Zero is an interior,
#     meaningful neutral and NULL means UNRATED (`magnitude-coding.md` §2: MAXQDA
#     default-stamps 0 and thereby destroys the distinction). A rebuild-and-recopy
#     that coerced either into the other is invisible to every count in this file.
#   * an application deliberately left UNRATED, so NULL has to survive AS NULL.
#   * a `magnitude_conflict` — the other coder's differing rating, kept beside ours.

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
# that pass. ⚠️ This cut does NOT rebuild this table — these are invariance
# fixtures, and the table it DOES rebuild carries non-contiguous ids for the same
# reason. `DC_SCORE` is the participant table's score column (below).
DC_SOURCE, DC_TARGET, DC_EQUIV, DC_PLAIN = 41, 47, 53, 61
DC_SCORE = 67

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
# names `SCALE_CODE_ID`: an id inside a JSON blob, pointing INTO the rebuilt table.
PARTICIPANT_LINKED, PARTICIPANT_SPARE = 7, 11
PROJECT_OTHER = 2
DS_MAIN, DS_SECOND, DS_OTHER_PROJECT = 1, 5, 9
PARTICIPANT_TABLE = DS_SECOND
MANAGED_SPEC = json.dumps({"kind": "magnitude_score", "code_id": SCALE_CODE_ID})

# This cut's `codes` fixtures, beside SCALE_CODE_ID (1) and code 2. Non-contiguous,
# and each carries a different dependant of the rebuilt table: `CODE_GROUPED` sits in
# a category (FK + legacy membership row) AND an equivalence group, with a uuid, a
# colour and a description; `CODE_RETIRED` is inactive. The MACHINE coder is the one
# `machine_provenance` must arrive NULL on, and it holds one of the applications.
CODE_GROUPED, CODE_RETIRED = 7, 12
CATEGORY_ID, CODE_GROUP_ID = 3, 5
MACHINE_CODER = 4
APP_MACHINE, APP_RETIRED = 7, 8
# Written AFTER the upgrade by the behavioural checks — the table does not exist before.
CODE_SET_ID, CODE_SET_DUPLICATE = 4, 6
CODE_SET_UUID = "5c0de5e7-0000-4000-8000-000000000048"

# The one table this cut REBUILDS.
REBUILT_TABLES = ("codes",)
# Every index on these is compared before and after, with its CREATE statement. A
# rebuild that drops one leaves a UNIQUE constraint unenforced and nothing else looks
# wrong. The children of `codes`, the table gaining a column, and v1.5.2's rebuilt
# tables are kept in the set: it costs nothing and they are all parents of data.
INDEXED_TABLES = REBUILT_TABLES + (
    "code_applications", "code_category_memberships", "users",
    "documents", "datasets", "dataset_columns",
)
# `PRAGMA foreign_key_list` before and after: the rebuilt table's own FKs, and the
# FKs of the two children that name it.
FK_TABLES = ("codes", "code_applications", "code_category_memberships")
# Every PRE-EXISTING column of every seeded row, compared whole. Listing columns by
# hand is how a column added later goes unchecked, so the column list is read from
# the database at seed time.
FULL_ROW_TABLES = (
    "codes", "users", "code_applications", "code_category_memberships",
    "code_categories", "code_equivalence_groups",
    "documents", "datasets", "dataset_columns", "dataset_rows",
)

# ── What this cut must ADD, per column: the value it must arrive HOLDING, and why ──
NEW_COLUMNS = {
    "codes": {"code_set_id": (
        None,
        "membership in a set is a CLAIM that the code is one of k mutually exclusive "
        "values, and it changes what the Reliability tab computes — a default asserts "
        "one nobody made")},
    "users": {"machine_provenance": (
        None,
        "NULL is the honest state for every human coder and for a machine whose "
        "configuration was never recorded — a default fabricates a provenance")},
}
# New tables that must arrive EMPTY: a fabricated set would reclassify existing coding.
NEW_TABLES_EMPTY = ("code_sets",)
# New FKs: (table, column) -> (referenced table, ON DELETE). SET NULL is the point.
NEW_FKS = {("codes", "code_set_id"): ("code_sets", "SET NULL")}
# Indexes this cut must CREATE: name -> must it be UNIQUE?
NEW_INDEXES = {
    "ix_codes_code_set_id": False,
    "ix_code_sets_project_id": False,
    "ix_code_sets_uuid": True,
}


def seed(db_path: Path) -> dict:
    """Fill the old-revision DB with the shapes a table rebuild can damage.

    Deliberately includes: segments under BOTH parents, the self-referencing
    merge/split links, children hanging off segments and off CODES (the cascade
    canaries), every kind of row that depends on `codes` (applications by a human
    and a machine coder, a category membership, a category and an equivalence
    group it points at), excerpts in both pre-time-range shapes, and
    non-contiguous ids (a rebuild that renumbers instead of preserving ids breaks
    every child FK).

    Tables absent at the given revision are skipped with a note rather than
    crashing — the seed has to survive a moving "from" revision.
    """
    conn = _connect(db_path)
    conn.execute("PRAGMA foreign_keys=ON")
    x, have = conn.execute, _tables(conn)
    skipped = []

    x("INSERT INTO users (id, username, is_admin, created_at) VALUES (1,'lead',1,?)", (NOW,))
    # Row 49's column must arrive NULL on a MACHINE coder specifically — the one
    # coder a migration might be tempted to give a provenance. `coder_type='ai'` is
    # reachable before this cut through a merged project file (#989).
    machine = "coder_type" in _cols(conn, "users")
    if machine:
        x("INSERT INTO users (id, username, is_admin, created_at, coder_type) "
          "VALUES (?,'Model A',0,?,'ai')", (MACHINE_CODER, NOW))
    else:
        skipped.append("machine coder")
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

    # ── codes: THE table this cut rebuilds ───────────────────────────────────
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

        # The participant table's score column, as `participant_scores.py` writes it:
        # `source='managed'` and a `managed_spec` naming the code it scores. That
        # code id points INTO the table this cut rebuilds, from inside a JSON blob no
        # FK can see — so ids preserved across the rebuild is what keeps it true. One
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

    conn.commit()
    snap = {
        "counts": {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                   for t in sorted(have & {
                       "users", "projects", "participants", "conversations",
                       "documents", "segments",
                       "codes", "code_applications", "excerpt", "notes",
                       "code_categories", "code_equivalence_groups",
                       "code_category_memberships",
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
        # The rebuilt table and both of its child tables, by identity.
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
        # The two REBUILT tables, by identity. A rebuild that renumbers instead of
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
        # Every index on the rebuilt table and the tables around it, so a
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
    same("dataset_values parentage (the cascade canary for v1.5.2's rebuild)",
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
    same("magnitude ratings (0.0 stays 0.0, NULL stays UNRATED — on the REBUILT table's child)",
         "SELECT id, magnitude, magnitude_conflict FROM code_applications ORDER BY id",
         "magnitudes")
    same("declared rating scales (ON the REBUILT table — the scale 0.0 is interior to)",
         "SELECT id, magnitude_min, magnitude_max, magnitude_step, magnitude_labels "
         "FROM codes ORDER BY id", "code_scales")

    # ── Every PRE-EXISTING column, every row, of the tables this cut can touch ──
    #
    # 🔴 The check a rebuild most needs and the one a hand-listed SELECT cannot give:
    # a copy that dropped ONE column's data keeps every count, id and parent link.
    # The column list was read from the database at seed time, so a column that
    # exists but nobody thought to name is compared too. New columns are not in it;
    # what they must hold is asserted separately below.
    for table, (cols, want) in before["full_rows"].items():
        missing = [c for c in cols if c not in _cols(conn, table)]
        if missing:
            fails.append(f"`{table}` LOST column(s) {missing} in the upgrade — every row's "
                         "value for them is gone")
            continue
        got = _full_rows(conn, table, cols)
        if got != want:
            diff = [(w, g) for w, g in zip(want, got) if w != g]
            first = (f"\n     before={diff[0][0]}\n     after ={diff[0][1]}"
                     if diff else "")
            fails.append(
                f"`{table}`: {len(diff) or 'the set of'} row(s) changed across the upgrade "
                f"(rows {len(want)} -> {len(got)}; columns {cols}){first}")

    # ── Foreign keys: the rebuilt table's own, and its two children's ─────────
    #
    # Batch reflection RE-DECLARES `codes`' FKs on the recreated table. One lost or
    # re-declared with another ON DELETE is invisible to every count until something
    # is deleted — and a category delete that CASCADEd instead of SET NULL would take
    # its codes and, at runtime, their coding.
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
            fails.append(f"row 48: `{table}.{col}` has no FK to `{ref}` at all")
        elif got[0][0] != ref or got[0][4] != on_delete:
            fails.append(
                f"row 48: `{table}.{col}` → `{got[0][0]}` is ON DELETE {got[0][4]}, not "
                f"{on_delete} — deleting a set must leave its codes as ordinary codes, "
                "and a CASCADE would take them and every coding on them")

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
            if want is None:
                bad = x(f"SELECT COUNT(*) FROM {table} WHERE {col} IS NOT NULL").fetchone()[0]
            else:
                bad = x(f"SELECT COUNT(*) FROM {table} "
                        f"WHERE {col} IS NULL OR {col} != ?", (want,)).fetchone()[0]
            if bad:
                fails.append(
                    f"{bad} pre-existing {table} row(s) came out of the migration "
                    f"with {col} not {want!r} — {why}")
    for table in NEW_TABLES_EMPTY:
        if table not in _tables(conn):
            fails.append(f"row 48: table `{table}` was never created")
        elif n := x(f"SELECT COUNT(*) FROM {table}").fetchone()[0]:
            fails.append(f"row 48: `{table}` arrived holding {n} row(s) — a migration that "
                         "fabricates a set reclassifies coding that already exists")

    # v1.4.0's provenance fields are BELOW --from-revision: present before this
    # release starts, so they are checked as INVARIANT, never as evidence anything ran.
    dc_cols = _cols(conn, "dataset_columns")
    for c in V140_COLUMNS:
        if c not in dc_cols:
            fails.append(f"v1.4.0 column `{c}` vanished — this release must not touch it")
    if V140_INDEX not in _indexes(conn, "dataset_columns"):
        fails.append(f"v1.4.0 index `{V140_INDEX}` vanished — this release must not touch it")

    # ── Indexes across the REBUILD of `codes` ─────────────────────────────────
    #
    # 🔴 Batch reflection COPIES
    # a table's indexes onto the recreated table; a copy that quietly drops one
    # leaves a UNIQUE constraint unenforced, and nothing else about the database
    # looks wrong afterwards. Every index that existed before must still exist, and
    # a partial one must still carry its `WHERE` — the same name over a different
    # predicate is a different constraint.
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

    # What this cut must CREATE, and which of it must be UNIQUE. `code_sets` is a
    # new table, so the lookup is over every index in the database rather than
    # `INDEXED_TABLES`.
    all_indexes = {r[0]: (r[1] or "") for r in x(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")}
    for name, unique in NEW_INDEXES.items():
        if name not in all_indexes:
            fails.append(f"index `{name}` was never created")
        elif unique and "unique" not in all_indexes[name].lower():
            fails.append(f"index `{name}` exists but is NOT UNIQUE: {all_indexes[name]}")

    # ══ BEHAVIOURAL: the new constraints actually DO what they declare ═══════
    #
    # Reflecting a constraint back only re-reads what the migration wrote. These
    # checks exercise it instead, with foreign keys ON, as the app runs. ⚠️ **They
    # all MUTATE the database, so every comparison above must already have run.**
    conn.execute("PRAGMA foreign_keys=ON")

    # Row 48 — a code set, written the way a writer that omits `exhaustive` would.
    # The default is visible only to a write; 1 would turn every blank on the set
    # into MISSING data.
    if "code_sets" in _tables(conn) and "code_set_id" in _cols(conn, "codes"):
        x("INSERT INTO code_sets (id, project_id, uuid, label, created_at, updated_at) "
          "VALUES (?,1,?,'Stance',?,?)", (CODE_SET_ID, CODE_SET_UUID, NOW, NOW))
        conn.commit()
        ex = x("SELECT exhaustive FROM code_sets WHERE id=?", (CODE_SET_ID,)).fetchone()[0]
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
        # were. Two codes join it: one with a human's applications, one with the
        # MACHINE coder's.
        members = (2, CODE_GROUPED)
        coded = x("SELECT COUNT(*) FROM code_applications WHERE code_id IN (?,?)",
                  members).fetchone()[0]
        x("UPDATE codes SET code_set_id=? WHERE id IN (?,?)", (CODE_SET_ID, *members))
        conn.commit()
        x("DELETE FROM code_sets WHERE id=?", (CODE_SET_ID,))
        conn.commit()
        left = x("SELECT id, code_set_id FROM codes WHERE id IN (?,?) ORDER BY id",
                 members).fetchall()
        still = x("SELECT COUNT(*) FROM code_applications WHERE code_id IN (?,?)",
                  members).fetchone()[0]
        if len(left) != len(members):
            fails.append(
                f"row 48 ON DELETE SET NULL: deleting a code set DELETED {len(members) - len(left)} "
                f"of its codes, and {coded - still} of {coded} codings with them — the FK "
                "behaves as CASCADE")
        elif any(r[1] is not None for r in left):
            fails.append(f"row 48 ON DELETE SET NULL did not fire: {left}")
        elif still != coded:
            fails.append(f"row 48: deleting a code set lost {coded - still} codings")

    # The rebuild RE-DECLARED `codes`' two SET NULL FKs. Deleting what a code points
    # at must leave the code — and its machine coder's application — in place.
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
