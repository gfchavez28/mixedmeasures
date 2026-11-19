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

    python scripts/migration_rehearsal.py --from-revision d4e8a1c7b2f6   # v1.6.0

`--from-revision` is the Alembic head of the PREVIOUS release. Find it with:

    git show <previous-release-tag>:backend/alembic/versions/ ...   # or
    alembic history            # and take the last revision before this cut

Exits 0 on success, 1 on any failure. Writes only to a temp dir; never touches
`dev.db`, the real backup dir, or the developer's data.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
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


def _table_sql(conn, table: str) -> str:
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                       (table,)).fetchone()
    return (row[0] or "") if row else ""


def _checks(sql: str) -> list[str]:
    """Every CHECK constraint in a CREATE TABLE statement, its expression read to the
    matching parenthesis and whitespace-normalised. A rebuild REGENERATES the statement,
    so the text as a whole differs; the constraints it carries must not."""
    out = []
    for m in re.finditer(r"\bCHECK\s*\(", sql, re.IGNORECASE):
        j = m.end() - 1                     # the opening parenthesis
        depth, k = 0, j
        while k < len(sql):
            depth += {"(": 1, ")": -1}.get(sql[k], 0)
            if depth == 0:
                break
            k += 1
        out.append(" ".join(sql[j + 1:k].split()))
    return sorted(out)


def _structure(conn, table: str) -> dict:
    """What a rebuild must carry across: the columns (name, type, NOT NULL, default, key —
    in order) and the CHECK constraints."""
    return {
        "columns": [tuple(r[1:6]) for r in conn.execute(f"PRAGMA table_xinfo({table})")],
        "checks": _checks(_table_sql(conn, table)),
    }


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
# ── 1.7.0 (rehearsed 2026-11-19) — TEN table REBUILDS, a data REPAIR, a column + an index ──
#
# `--from-revision d4e8a1c7b2f6` — v1.6.0's head (`b72a43c4`). FIVE migrations:
#
#   e7b3c5a9d2f4  the joint display's version fence: does nothing, exists to be unknown
#   f2a6c8d4b1e7  datasets.managed_rater_ids (NULL: no backfill) + ix_code_applications_rated
#                 on (code_id, user_id, magnitude) WHERE magnitude IS NOT NULL   (#1617/#1623)
#   b8d4f2a6c0e9  removal_tombstones += each withdrawal's ID in composed (NFC) form and as a
#                 FOLDED name, rebuilt from the `withdrawn` audit entry           (#1605)
#   c3a7e1f9b5d8  NINE tables rebuilt with AUTOINCREMENT, each sequence raised to the
#                 highest id the audit trail names for it                         (#1639)
#   bdf1ffd93239  `analysis_domains` rebuilt the same way                         (#1678)
#
# 🔴 **The rebuilds are the dangerous half** — the first since the code sets' rebuild of
# `codes` (`e4a9c7b21f68`, shipped in 1.5.4). A DROP +
# RENAME with foreign keys ON would CASCADE out of `codes` into the coding, out of the
# three source tables into every segment and its coding, out of `excerpt` into a note's
# link (SET NULL), out of `participants` into speakers and dataset rows (SET NULL), and
# out of `analysis_domains` into its members. Every one of those children is seeded and
# compared whole, BY ID (`FULL_ROW_TABLES`); each rebuilt table's columns, CHECK
# constraints, indexes and FKs are compared before and after (`REBUILT_TABLES`); and
# AUTOINCREMENT must be ABSENT before and PRESENT after, or its arrival proves nothing.
#
# 🔴 **The sequence seed is a claim about NUMBERS, so it is asserted against literals**
# (`SEQ_EXPECTED`, not the revision's formula): the audit trail names a code, a
# conversation, a variable group and withdrawn participants ABOVE each table's highest
# id (a deleted newest row), and a dataset column BELOW it; `materials` has no audit
# kind. The behavioural checks then insert a code and a variable group with no id and
# require the id after the seeded sequence — the reuse #1639/#1678 end.
#
# 🔴 **The withdrawal repair MUST add rows** (RELEASING §4c). `TOMBSTONES_ADDED` is the
# set it must add and nothing else: a DECOMPOSED ID (`W_NFD_ID`, which reads the same on
# screen) gains its composed hash and its folded name; an ASCII ID gains only its folded
# name (its composed hash IS the stored one); the same ID withdrawn twice adds one row;
# an unreadable entry, an entry in a project with no uuid and a non-withdrawal entry add
# nothing. The rows seeded before it must come through unchanged.
#
# The new column must arrive NULL on every dataset (`NEW_COLUMNS` — "no record", so the
# live rule answers), and the new index must not exist before, must cover exactly
# `(code_id, user_id, magnitude)`, must be PARTIAL on `magnitude IS NOT NULL` and must NOT
# be unique. The fence has nothing to assert beyond the revision reaching head.
#
# ── 1.6.0's fixtures CHANGE SIDES ─────────────────────────────────────────────
#
# 🔴 `d4e8a1c7b2f6` IS `--from-revision`, so #1597's queue repair and #1463's index ran
# BELOW this cut, on the empty database the build makes, and 1.6.0's "QUEUE_EXPECTED
# arrives queued" would pass VACUOUSLY. The queue is seeded as that repair LEFT it (both
# of `G_SPLIT`'s turns marked, nothing else) and asserted invariant: 1.7.0 must queue no
# turn and rewrite no marker. `ix_code_applications_code_user` is compared as an existing
# index of `code_applications` (`INDEXED_TABLES`).
#
# ── 1.5.8's fixtures CHANGE SIDES ─────────────────────────────────────────────
#
# 🔴 `b5d1f7a3c9e2` IS `--from-revision`, so `users.uuid`, `removal_tombstones` and #1368
# D4's repair all ran BELOW this cut, on the empty database the build makes — and the 1.5.8
# block's "arrives SET / EMPTY / MARKED" would pass VACUOUSLY (an IDENTITY check over
# NULL uuids would even FAIL for the wrong reason: raw SQL writes none). They are seeded
# at REAL values instead and asserted invariant: every coder with a distinct uuid, one
# withdrawal record, and the four computed columns at their POST-repair `stale` flags.
# The 1.5.8 behavioural checks (two coders cannot share a uuid, two may hold none, a
# project takes many withdrawals) stay, as coverage of the BUILT database.
#
# ── v1.5.3's fixtures ─────────────────────────────────────────────────────────
#
# `code_sets`, `codes.code_set_id` and `users.machine_provenance` sit further below and are
# seeded with REAL values — a set with `exhaustive` RAISED and two member codes, a machine
# coder with a recorded provenance — and asserted invariant by the full-row comparison. Their
# behavioural checks (`exhaustive` defaults to 0, a set's uuid is unique, deleting a set
# leaves its codes and their coding) stay as coverage of the BUILT database.
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
    (5, 2),   # conversation note on a QUOTE (1.7.0: the canary for the `excerpt` rebuild)
]

# `dataset_columns` ids are deliberately NON-CONTIGUOUS: a rebuild that renumbers
# instead of preserving ids breaks every child FK, and contiguous ids would let
# that pass. ⚠️ No table is rebuilt this cut; this is the one its REPAIR writes.
# `DC_SCORE` is the participant table's score column (below).
DC_SOURCE, DC_TARGET, DC_EQUIV, DC_PLAIN = 41, 47, 53, 61
DC_SCORE = 67

# #1368 D4's repair (`b5d1f7a3c9e2`) ran BELOW this cut's --from-revision, so every
# computed column is seeded at the `stale` the repair LEFT — the two quoted-answer shapes
# marked, the numeric comparison not, the arithmetic formula still out of date — and must
# arrive holding the same (formula, seeded, after: equal by construction this cut).
# 1.6.0's migrations must not touch a flag: a repair that re-ran over them, or a migration
# that cleared them, gets one of these wrong.
DC_QUOTED, DC_QUOTED_MIRRORED, DC_NUMERIC_CMP, DC_ALREADY_STALE = 71, 73, 79, 83
REPAIR_STALE = {
    DC_QUOTED:          ('[Trust] == "Agree"',                1, 1),
    DC_QUOTED_MIRRORED: ('IF("Agree" != ( [Trust] ), 1, 0)',  1, 1),
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

# 1.5.8's `users.uuid` (`c6e2a8d41f97`), BELOW --from-revision now: every seeded coder
# carries a distinct identity at a real value, asserted invariant.
CODER_UUIDS = {
    1: "c0de4001-0000-4000-8000-000000000001",   # LEAD_CODER
    4: "c0de4004-0000-4000-8000-000000000004",   # MACHINE_CODER
    9: "c0de4009-0000-4000-8000-000000000009",   # ARCHIVED_CODER
    6: "c0de4006-0000-4000-8000-000000000006",   # TEAM_CODER (1.6.0's second voter)
    30: "c0de4030-0000-4000-8000-000000000030",  # CONSENSUS_CODER (the system coder)
}
# 1.5.8's `removal_tombstones` (`a7c3e9f1d2b4`), BELOW --from-revision now: one withdrawal
# record a 1.5.8 install holds, asserted invariant — a migration that cleared it would let
# the next merge bring the person back.
TOMBSTONE_SEEDED_ID = 3

# ── 1.6.0's repair (`d4e8a1c7b2f6`, #1597) — the fixture its predicate decides ─────
#
# A second PERSON (the voter a group needs), the global consensus coder, and three cases:
#   G_SPLIT      turns SEG_SPLIT_A (the lead coded it) and SEG_ALREADY_QUEUED (the
#                colleague coded it) — two coders on different turns: QUEUED, both turns.
#                SEG_ALREADY_QUEUED carries a marker from before the upgrade.
#   G_ONE_CODER  turns SEG_ONE_A and SEG_ONE_B, both coded by the lead only: NOT queued.
#   SEG_UNGROUPED  no group; the lead, the colleague and a stored consensus row: NOT queued.
TEAM_CODER, CONSENSUS_CODER = 6, 30
G_SPLIT, G_ONE_CODER = 2, 4
SEG_SPLIT_A, SEG_ALREADY_QUEUED, SEG_ONE_A, SEG_ONE_B, SEG_UNGROUPED = 40, 41, 43, 44, 47
APP_SPLIT_A, APP_SPLIT_B, APP_ONE_A, APP_ONE_B = 21, 22, 23, 24
APP_UNGROUPED_LEAD, APP_UNGROUPED_TEAM, APP_UNGROUPED_CONSENSUS = 25, 26, 27
MARKER_SEEDED = 5
# 1.7.0: the repair is BELOW this cut, so the seed holds what it LEFT — a marker on every
# turn of G_SPLIT (the one from before it, and the one it added) — and the upgrade must
# leave exactly these, as the same rows.
MARKER_SPLIT_A = 6
QUEUE_EXPECTED = (SEG_SPLIT_A, SEG_ALREADY_QUEUED)

# ── 1.7.0's rebuilds (`c3a7e1f9b5d8` #1639, `bdf1ffd93239` #1678) ──────────────
#
# The ten tables rebuilt with AUTOINCREMENT, and the sequence each must arrive holding —
# LITERALS, worked by hand from the seed: the highest id the table holds, raised to the
# highest id the audit trail names for its kind when that is higher.
#   codes             ids 1 2 7 12; a code 15 was created and deleted (audit)   → 15
#   dataset_columns   highest 83; the audit names 50, BELOW it                    → 83
#   conversations     id 1; conversation 6 was deleted (audit)                    → 6
#   documents, observations   id 1 each, no audit                                 → 1
#   datasets          ids 1 5 9                                                    → 9
#   materials         ids 3 8; materials have no audit kind                       → 8
#   excerpt           ids 1 2 3                                                    → 3
#   participants      ids 7 11; withdrawn participants 13 14 16 17 (audit)        → 17
#   analysis_domains  ids 2 4; variable group 9 was deleted (audit)               → 9
SEQ_EXPECTED = {
    "codes": 15, "dataset_columns": 83, "conversations": 6, "documents": 1,
    "observations": 1, "datasets": 9, "materials": 8, "excerpt": 3, "participants": 17,
    "analysis_domains": 9,
}
REBUILT_TABLES = tuple(SEQ_EXPECTED)
# The sequences the AUDIT must raise above the table's own highest id: if the seed ever
# stops putting one above, its check is inert against a revision that seeds nothing.
SEQ_RAISED_BY_AUDIT = ("codes", "conversations", "participants", "analysis_domains")
# (id, entity_type, entity_id, action) — create and delete entries as the doors log them.
SEQ_AUDIT = (
    (90, "code", 15, "created"), (91, "code", 15, "deleted"),
    (92, "dataset_column", 50, "deleted"),
    (93, "conversation", 6, "deleted"),
    (94, "analysis_domain", 9, "deleted"),
)
MATERIAL_COLLECTION, MATERIAL_A, MATERIAL_B = 2, 3, 8
DOMAIN_A, DOMAIN_B = 2, 4
SPEAKER_LINKED = 3
NOTE_ON_EXCERPT, EXCERPT_NOTED = 5, 2

# ── 1.7.0's withdrawal repair (`b8d4f2a6c0e9`, #1605) ──────────────────────────
#
# Project 1 carries a uuid (the tombstones are keyed by it); `PROJECT_OTHER` carries none,
# so its withdrawal cannot be keyed and must be skipped.
PROJECT_UUID_MAIN = "7b0a7b0a-0000-4000-8000-000000000001"
# The DECOMPOSED form (an `i` + a combining acute): it reads as "María López" on screen,
# and 1.6.0 hashed it as written, so a transcript writing the composed form brought her back.
W_NFD_ID = "María López"
W_ASCII_ID = "P-014"
# (audit id, project, participant id, action, details) — `withdrawn` entries as
# `routers/participants.py` logs them (the outcome's `identifier`, the backup's name).
WITHDRAWAL_AUDIT = (
    (101, 1, 13, "withdrawn", json.dumps({"identifier": W_NFD_ID, "backup_filename": "a.mmbackup"})),
    (102, 1, 14, "withdrawn", json.dumps({"identifier": W_ASCII_ID, "backup_filename": "b.mmbackup"})),
    # The same ID withdrawn again (re-created, withdrawn a second time): one row, not two.
    (103, 1, 16, "withdrawn", json.dumps({"identifier": W_ASCII_ID, "backup_filename": "c.mmbackup"})),
    # Unreadable: skipped, never a failed upgrade.
    (104, 1, 17, "withdrawn", "{not json"),
    # A project with no uuid: nothing to key the record by.
    (105, PROJECT_OTHER, 5, "withdrawn", json.dumps({"identifier": "P-099"})),
    # Not a withdrawal, though it names an identifier: never read.
    (106, 1, 11, "created", json.dumps({"identifier": "P-002"})),
)
# 1.6.0's writer hashed the ID as written (trimmed), kind `participant`. Rows 7 and 8 are
# what a 1.6.0 install holds for the two withdrawals above.
TOMBSTONE_NFD_ID, TOMBSTONE_ASCII_ID = 7, 8


def _sha(prefix: str, key: str) -> str:
    return hashlib.sha256((prefix + key).encode("utf-8")).hexdigest()


# The three rules, as `services/tombstones.py` states them in words (written here from that
# statement, not imported: this script imports nothing from `app.`, and the revision's own
# copy is held equal to the module by `tests/test_withdrawal_record_upgrade_1605.py`).
def _id_as_written(ident: str) -> str:          # 1.6.0: trimmed, capitals kept, as encoded
    return _sha("mm-withdrawn-identifier:v1:", ident.strip())


def _id_composed(ident: str) -> str:            # 1.7.0: the same, in composed (NFC) form
    return _sha("mm-withdrawn-identifier:v1:", unicodedata.normalize("NFC", ident.strip()))


def _name_folded(name: str) -> str:             # 1.7.0: spacing, capitals and encoding ignored
    spaced = " ".join(name.strip().split())
    return _sha("mm-withdrawn-name:v2:", unicodedata.normalize(
        "NFD", unicodedata.normalize("NFD", spaced).casefold()))


# What the repair must ADD, as (project_uuid, kind, hash) — and nothing else.
TOMBSTONES_ADDED = {
    (PROJECT_UUID_MAIN, "participant", _id_composed(W_NFD_ID)),
    (PROJECT_UUID_MAIN, "participant_name", _name_folded(W_NFD_ID)),
    (PROJECT_UUID_MAIN, "participant_name", _name_folded(W_ASCII_ID)),
}

# 1.7.0 rebuilds the ten `REBUILT_TABLES`. Every index on these is compared with its
# CREATE statement — a dropped UNIQUE index leaves a constraint unenforced and nothing
# else looks wrong, and batch reflection is what re-creates a rebuilt table's indexes
# (the partial ones on `datasets`, `dataset_columns` and `excerpt` included).
INDEXED_TABLES = (
    "codes", "code_applications", "code_category_memberships", "code_sets", "users",
    "documents", "datasets", "dataset_columns", "removal_tombstones",
    "consensus_stale_targets", "segment_groups", "segments",
    "conversations", "observations", "materials", "excerpt", "participants",
    "analysis_domains", "analysis_domain_members", "speakers", "notes",
)
# `PRAGMA foreign_key_list` before and after: each rebuilt table's own FKs (the batch
# re-declares them) and its children's.
FK_TABLES = (
    "codes", "code_applications", "code_category_memberships", "code_sets",
    *REBUILT_TABLES, "segments", "notes", "speakers", "dataset_rows", "dataset_values",
    "analysis_domain_members", "recode_definitions",
)
# Every PRE-EXISTING column of every seeded row, compared whole — against what it must
# hold AFTER, which is what it held before except `EXPECTED_REWRITES`. Listing columns
# by hand is how a column added later goes unchecked, so the column list is read from
# the database at seed time. 1.7.0: the ten rebuilt tables and every child a CASCADE or
# SET NULL out of them would reach.
FULL_ROW_TABLES = (
    "codes", "users", "code_applications", "code_category_memberships",
    "code_categories", "code_equivalence_groups", "code_sets",
    "documents", "datasets", "dataset_columns", "dataset_rows",
    "removal_tombstones", "segment_groups", "segments",
    "projects", "conversations", "observations", "materials", "material_collections",
    "excerpt", "participants", "analysis_domains", "analysis_domain_members",
    "speakers", "notes", "dataset_values", "recode_definitions", "audit_entries",
    "equivalence_groups",
)
# Tables this cut ADDS rows to: the full-row comparison reads only the rows seeded before
# the upgrade, and what was added is asserted on its own (`TOMBSTONES_ADDED`).
GROWING_TABLES = ("removal_tombstones",)
# (table, column) -> {row id: the value the repair must leave there}. The full-row
# comparison expects these too, so a repair that moved nothing — or moved a row it
# must not — fails there as well as in its own check below. 1.7.0's repair rewrites no
# existing row (it only ADDS tombstones), and #1368 D4's flags are seeded post-repair,
# so nothing here moves this cut.
EXPECTED_REWRITES = {
    ("dataset_columns", "stale"): {cid: after for cid, (_, _, after) in REPAIR_STALE.items()},
}

# ── What this cut must ADD, per column: the value it must arrive HOLDING, and why ──
#
# `IDENTITY`: set on every row, distinct, and readable by the `.mmproject` import as an
# identity — `project_portability._file_coder_uuid` takes a non-empty string of at most
# 36 characters and treats anything else as NO identity.
IDENTITY = object()
# 1.7.0 adds one (`f2a6c8d4b1e7`); 1.5.8's `users.uuid` is seeded at real values above.
NEW_COLUMNS: dict = {
    "datasets": {
        "managed_rater_ids": (
            None, "it records whose ratings a participant table's snapshot holds, which only "
            "a refresh can know; NULL is 'no record', so the live rule answers (D222)"),
    },
}
# New tables that must arrive EMPTY, and why. This cut adds none (1.5.8's
# `removal_tombstones` is seeded with a real withdrawal above).
NEW_TABLES_EMPTY: dict = {}
# New FKs: (table, column) -> (referenced table, ON DELETE). This cut adds none.
NEW_FKS: dict = {}
# Indexes this cut must CREATE: name -> (table, columns, must it be UNIQUE?, its partial
# WHERE or None, why). Each must also be ABSENT before the upgrade, or its arrival proves
# nothing. (1.6.0's `ix_code_applications_code_user` is below this cut: an existing index
# of `code_applications`, compared by `INDEXED_TABLES`.)
NEW_INDEXES = {
    "ix_code_applications_rated": (
        "code_applications", ("code_id", "user_id", "magnitude"), False,
        "magnitude IS NOT NULL",
        "many coders rate one code, so a unique index would refuse the second rating; and "
        "without the predicate it indexes every unrated coding the live rule must skip"),
}


def seed(db_path: Path) -> dict:
    """Fill the old-revision DB with the shapes a table rebuild can damage.

    Deliberately includes: segments under BOTH parents, the self-referencing
    merge/split links, children hanging off segments and off CODES (the cascade
    canaries), every kind of row that depends on `codes` (applications by a human
    and a machine coder, a category membership, a category and an equivalence
    group it points at), excerpts in both pre-time-range shapes, and
    non-contiguous ids (a rebuild that renumbers instead of preserving ids breaks
    every child FK). For this cut (1.7.0): a child under each of the ten tables it
    rebuilds, audit entries the sequences must be raised to, and the withdrawals the
    repair rebuilds its records from — beside the older fixtures, all at real values.

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
    # 1.6.0's second PERSON — the voter a segment group needs — and the global consensus
    # coder, whose rows a 1.5.8 install's saved consensus layer holds.
    x("INSERT INTO users (id, username, is_admin, created_at) VALUES (?,'Priya',0,?)",
      (TEAM_CODER, NOW))
    if machine:
        x("INSERT INTO users (id, username, is_admin, created_at, coder_type) "
          "VALUES (?,'Consensus',0,?,'consensus')", (CONSENSUS_CODER, NOW))
    else:
        skipped.append("consensus coder")
    # 1.5.8's identity backfill ran below --from-revision: every coder holds a real one.
    if "uuid" in user_cols:
        for uid, uuid in CODER_UUIDS.items():
            x("UPDATE users SET uuid=? WHERE id=?", (uuid, uid))
    else:
        skipped.append("coder identities")
    x("INSERT INTO projects (id, user_id, name, status, created_at, updated_at) "
      "VALUES (1,1,'Rehearsal project','active',?,?), (?,1,'Second study','active',?,?)",
      (NOW, NOW, PROJECT_OTHER, NOW, NOW))
    # 1.7.0's withdrawal repair keys each record by its project's uuid: project 1 holds one,
    # the second study none (so its withdrawal must be skipped).
    if "project_uuid" in _cols(conn, "projects"):
        x("UPDATE projects SET project_uuid=? WHERE id=1", (PROJECT_UUID_MAIN,))
    else:
        skipped.append("project uuid")
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
        # 1.7.0 rebuilds `participants`: a speaker linked to one is its SET NULL canary.
        if "speakers" in have:
            x("INSERT INTO speakers (id, project_id, name, original_label, is_facilitator, "
              "color_index, participant_id, created_at) VALUES (?,1,'Alex','SPEAKER_01',0,2,?,?)",
              (SPEAKER_LINKED, PARTICIPANT_LINKED, NOW))
        else:
            skipped.append("speakers")
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

    # ── 1.6.0's repair (`d4e8a1c7b2f6`, #1597): the three cases its predicate decides ──
    #
    # Built as a 1.5.8 install holds them: grouped turns whose coders coded different turns
    # (so 1.5.8's per-turn rule found one voter per turn and stored no consensus there), a
    # one-coder group, and an ungrouped two-coder turn whose per-turn consensus 1.5.8 DID
    # store — plus one turn already queued from before the upgrade.
    queue_fixture = ("segment_groups" in have and "consensus_stale_targets" in have
                     and "group_id" in _cols(conn, "segments")
                     and "origin" in _cols(conn, "code_applications") and machine)
    if queue_fixture:
        x("INSERT INTO segment_groups (id, conversation_id, created_at) VALUES (?,1,?), (?,1,?)",
          (G_SPLIT, NOW, G_ONE_CODER, NOW))
        for sid, group in ((SEG_SPLIT_A, G_SPLIT), (SEG_ALREADY_QUEUED, G_SPLIT),
                           (SEG_ONE_A, G_ONE_CODER), (SEG_ONE_B, G_ONE_CODER),
                           (SEG_UNGROUPED, None)):
            x("INSERT INTO segments (id, conversation_id, sequence_order, text, group_id, "
              "created_at, is_starred, is_merge_result, is_split_result) "
              "VALUES (?,1,?,?,?,?,0,0,0)", (sid, sid, f"turn {sid}", group, NOW))
        for aid, sid, uid, origin in (
            (APP_SPLIT_A, SEG_SPLIT_A, LEAD_CODER, "human"),
            (APP_SPLIT_B, SEG_ALREADY_QUEUED, TEAM_CODER, "human"),
            (APP_ONE_A, SEG_ONE_A, LEAD_CODER, "human"),
            (APP_ONE_B, SEG_ONE_B, LEAD_CODER, "human"),
            (APP_UNGROUPED_LEAD, SEG_UNGROUPED, LEAD_CODER, "human"),
            (APP_UNGROUPED_TEAM, SEG_UNGROUPED, TEAM_CODER, "human"),
            (APP_UNGROUPED_CONSENSUS, SEG_UNGROUPED, CONSENSUS_CODER, "consensus"),
        ):
            x("INSERT INTO code_applications (id, segment_id, code_id, user_id, origin, "
              "created_at) VALUES (?,?,2,?,?,?)", (aid, sid, uid, origin, NOW))
        x("INSERT INTO consensus_stale_targets (id, project_id, segment_id, created_at) "
          "VALUES (?,1,?,?)", (MARKER_SEEDED, SEG_ALREADY_QUEUED, NOW))
        # ...and the marker 1.6.0's first start ADDED (its repair is below this cut).
        x("INSERT INTO consensus_stale_targets (id, project_id, segment_id, created_at) "
          "VALUES (?,1,?,?)", (MARKER_SPLIT_A, SEG_SPLIT_A, NOW))
    else:
        skipped.append("1.6.0 consensus queue fixture")

    # 1.5.8's withdrawal record, below --from-revision: one a 1.5.8 install holds.
    if "removal_tombstones" in have:
        x("INSERT INTO removal_tombstones (id, project_uuid, entity_type, entity_uuid, "
          "identifier_hash, reason, created_at) VALUES (?,?,'participant',?,NULL,"
          "'withdrawal',?)",
          (TOMBSTONE_SEEDED_ID, "7b0a7b0a-0000-4000-8000-000000000158",
           "9a7e0003-0000-4000-8000-000000000003", NOW))
        # The two records a 1.6.0 install wrote for `WITHDRAWAL_AUDIT`'s withdrawals in
        # project 1: the ID hashed as written. 1.7.0 must keep both and add beside them.
        x("INSERT INTO removal_tombstones (id, project_uuid, entity_type, entity_uuid, "
          "identifier_hash, reason, created_at) VALUES "
          "(?,?,'participant',NULL,?,'withdrawal',?), (?,?,'participant',NULL,?,'withdrawal',?)",
          (TOMBSTONE_NFD_ID, PROJECT_UUID_MAIN, _id_as_written(W_NFD_ID), NOW,
           TOMBSTONE_ASCII_ID, PROJECT_UUID_MAIN, _id_as_written(W_ASCII_ID), NOW))
    else:
        skipped.append("withdrawal record")

    # The audit trail 1.7.0's revisions READ: the withdrawals the repair rebuilds its rows
    # from, and the create/delete entries the sequences are raised to.
    if "audit_entries" in have:
        for aid, pid, ent, action, details in WITHDRAWAL_AUDIT:
            x("INSERT INTO audit_entries (id, timestamp, user_id, action, entity_type, "
              "entity_id, details, project_id) VALUES (?,?,1,?,'participant',?,?,?)",
              (aid, NOW, action, ent, details, pid))
        for aid, etype, ent, action in SEQ_AUDIT:
            x("INSERT INTO audit_entries (id, timestamp, user_id, action, entity_type, "
              "entity_id, details, project_id) VALUES (?,?,1,?,?,?,NULL,1)",
              (aid, NOW, action, etype, ent))
    else:
        skipped.append("audit trail")

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
    # 1.7.0 rebuilds `excerpt`: a note ON a quote is its SET NULL canary (the conversation's
    # second note, so numbered 2).
    x("INSERT INTO notes (id, conversation_id, segment_id, excerpt_id, content, "
      "sequence_number, is_archived, created_at, updated_at) "
      "VALUES (?,1,11,?,'why this quote',2,0,?,?)", (NOTE_ON_EXCERPT, EXCERPT_NOTED, NOW, NOW))

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

    # ── 1.7.0: `materials` and `analysis_domains`, two of the ten rebuilt tables ──
    #
    # A saved result (a material, in a collection — its parent, CASCADE) whose config names
    # a variable group by id, as `material_config.ID_KEYS` stores one; and two variable
    # groups with a member each (`analysis_domain_members`, CASCADE — the canary a DROP of
    # `analysis_domains` with foreign keys ON would empty). Non-contiguous ids, both tables.
    if "materials" in have and "material_collections" in have:
        x("INSERT INTO material_collections (id, project_id, name, display_order, created_at) "
          "VALUES (?,1,'Saved results',0,?)", (MATERIAL_COLLECTION, NOW))
        for mid, order in ((MATERIAL_A, 0), (MATERIAL_B, 1)):
            x("INSERT INTO materials (id, collection_id, material_type, config, auto_name, "
              "custom_name, display_order, source_tab, created_at) "
              "VALUES (?,?,'descriptives',?,?,NULL,?,'quantitative',?)",
              (mid, MATERIAL_COLLECTION, json.dumps({"domain_ids": [DOMAIN_A]}),
               f"Descriptives {mid}", order, NOW))
    else:
        skipped.append("materials")
    if "analysis_domains" in have and "analysis_domain_members" in have:
        for did, name, member in ((DOMAIN_A, "Wellbeing", DC_SOURCE),
                                  (DOMAIN_B, "Burnout", DC_EQUIV)):
            x("INSERT INTO analysis_domains (id, project_id, name, sequence_order, created_at, "
              "updated_at) VALUES (?,1,?,?,?,?)", (did, name, did, NOW, NOW))
            x("INSERT INTO analysis_domain_members (id, domain_id, member_type, member_id, "
              "sequence_order, created_at) VALUES (?,?,'column',?,1,?)",
              (did, did, member, NOW))
    else:
        skipped.append("analysis domains")

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
        # ⚠️ 1.6.0: #1368 D4's repair is below --from-revision, so REPAIR_STALE is an
        # INVARIANCE fixture this cut and moves no flag by design. The 1.5.8 check that
        # refused an inert fixture here now belongs to the queue fixture (below).
    # 1.6.0's repair is BELOW this cut: the seed holds exactly what it left.
    if "1.6.0 consensus queue fixture" not in skipped:
        queued = [sid for (sid,) in conn.execute(
            "SELECT segment_id FROM consensus_stale_targets ORDER BY segment_id")]
        if queued != sorted(QUEUE_EXPECTED):
            raise SystemExit(f"seed drift: consensus_stale_targets holds {queued}, not "
                             f"{sorted(QUEUE_EXPECTED)} — fix the seed, not this check")

    # 1.7.0's sequences: every table at or below its literal, and the audit-raised ones
    # strictly below it — or the seed check passes against a revision that seeds nothing.
    for t, want in SEQ_EXPECTED.items():
        if t not in have:
            skipped.append(f"sequence fixture for {t}")
            continue
        top = conn.execute(f"SELECT MAX(id) FROM {t}").fetchone()[0] or 0
        if top > want or (t in SEQ_RAISED_BY_AUDIT) != (top < want):
            raise SystemExit(f"seed drift: `{t}`'s highest id is {top} against SEQ_EXPECTED "
                             f"{want} — fix the seed or the literal, not this check")
        if "AUTOINCREMENT" in _table_sql(conn, t).upper():
            raise SystemExit(f"`{t}` already has AUTOINCREMENT at --from-revision, so its "
                             "arrival proves nothing — is --from-revision 1.6.0's head?")
    # 1.7.0's withdrawal repair must have work, and the decomposed ID must actually differ
    # from its composed form, or the composed-hash check is inert.
    if "withdrawal record" not in skipped and "audit trail" not in skipped:
        if _id_as_written(W_NFD_ID) == _id_composed(W_NFD_ID):
            raise SystemExit("W_NFD_ID is already composed, so the repair's composed hash is "
                             "the stored one and its check proves nothing")
        held = set(conn.execute("SELECT project_uuid, entity_type, identifier_hash "
                                "FROM removal_tombstones").fetchall())
        if held & TOMBSTONES_ADDED:
            raise SystemExit(f"seed drift: the seed already holds {held & TOMBSTONES_ADDED}, "
                             "which the repair is meant to add")

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
                       "recode_definitions", "equivalence_groups",
                       "speakers", "materials", "material_collections", "analysis_domains",
                       "analysis_domain_members", "audit_entries"})},
        # 1.7.0: what each rebuilt table must carry across — columns and CHECKs.
        "structure": {t: _structure(conn, t) for t in REBUILT_TABLES if t in have},
        # The rows of a table the upgrade ADDS to: the full-row comparison reads these only.
        "seeded_ids": {t: [r[0] for r in conn.execute(f"SELECT id FROM {t} ORDER BY id")]
                       for t in GROWING_TABLES if t in have},
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
        # 1.6.0's repair ADDS rows here; the one seeded before the upgrade must survive.
        "markers": conn.execute(
            "SELECT id, project_id, segment_id, dataset_value_id, created_at "
            "FROM consensus_stale_targets ORDER BY id").fetchall()
            if "consensus_stale_targets" in have else [],
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
        if table in before["seeded_ids"]:
            # Rows the upgrade ADDED are asserted on their own below; these are the
            # ones that were there before it, and they must be exactly as they were.
            keep, id_at = {repr(i) for i in before["seeded_ids"][table]}, cols.index("id")
            got = [r for r in got if r[id_at] in keep]
        if got != want:
            diff = [(w, g) for w, g in zip(want, got) if w != g]
            first = (f"\n     expected={diff[0][0]}\n     after   ={diff[0][1]}"
                     if diff else "")
            fails.append(
                f"`{table}`: {len(diff) or 'the set of'} row(s) differ from what the "
                f"upgrade must leave (rows {len(want)} -> {len(got)}; columns {cols}){first}")

    # ── 1.7.0's ten REBUILDS: the same table, now with AUTOINCREMENT and a sequence ──
    #
    # The rows are compared above. What a DROP + RENAME can change without touching a row:
    # a column's type, NOT NULL or default, a CHECK the regenerated statement left out —
    # and the point of the rebuild, AUTOINCREMENT with its counter where it must start.
    seq = dict(x("SELECT name, seq FROM sqlite_sequence").fetchall()) \
        if "sqlite_sequence" in _tables(conn) else {}
    for table, was in before["structure"].items():
        now = _structure(conn, table)
        # A column this cut ADDS (`NEW_COLUMNS`) is asserted on its own; the ones that were
        # there before must come out as they went in, in order.
        names = {c[0] for c in was["columns"]}
        now["columns"] = [c for c in now["columns"] if c[0] in names]
        if now["columns"] != was["columns"]:
            diff = [(w, n) for w, n in zip(was["columns"], now["columns"]) if w != n]
            fails.append(f"#1639: `{table}`'s columns changed in its rebuild "
                         f"({len(was['columns'])} -> {len(now['columns'])}; first difference "
                         f"{diff[:1] or 'in the count'})")
        if now["checks"] != was["checks"]:
            lost = sorted(set(was["checks"]) - set(now["checks"]))
            fails.append(f"#1639: `{table}`'s rebuild changed its CHECK constraints — "
                         f"LOST {lost}" if lost else
                         f"#1639: `{table}`'s rebuild ADDED CHECK constraints "
                         f"{sorted(set(now['checks']) - set(was['checks']))}")
        if "AUTOINCREMENT" not in _table_sql(conn, table).upper():
            fails.append(f"#1639/#1678: `{table}` came out of the upgrade WITHOUT "
                         "AUTOINCREMENT, so a deleted newest row's id goes to the next row "
                         "made, and a joint display or saved chart holding it names that row")
        elif seq.get(table) != SEQ_EXPECTED[table]:
            fails.append(
                f"#1639/#1678: `{table}`'s sequence starts at {seq.get(table)!r}, not "
                f"{SEQ_EXPECTED[table]} — "
                + ("an id the audit trail says was issued (and deleted) can be issued again"
                   if (seq.get(table) or 0) < SEQ_EXPECTED[table] else
                   "it skips ids nothing issued (harmless, but not what the revision says)"))

    # ── 1.7.0's withdrawal REPAIR (#1605, `b8d4f2a6c0e9`): exactly these rows added ──
    #
    # A row missing here lets a transcript that writes a withdrawn person's ID in the
    # other encoding, or her name in other capitals, bring her back as a new participant;
    # an extra row (from an unreadable entry, a project with no uuid, or a non-withdrawal
    # entry) records a withdrawal that never happened.
    if "removal_tombstones" in _tables(conn) and before["seeded_ids"].get("removal_tombstones"):
        seeded = before["seeded_ids"]["removal_tombstones"]
        added = x(f"SELECT project_uuid, entity_type, identifier_hash, entity_uuid, reason "
                  f"FROM removal_tombstones WHERE id NOT IN ({','.join('?' * len(seeded))})",
                  tuple(seeded)).fetchall()
        got = {(p, k, h) for p, k, h, _, _ in added}
        if len(added) != len(got):
            fails.append(f"#1605: the repair added {len(added)} rows for {len(got)} records "
                         "— the same ID withdrawn twice was written twice")
        if missing := TOMBSTONES_ADDED - got:
            kinds = sorted(k for _, k, _ in missing)
            fails.append(f"#1605: the repair did NOT add {len(missing)} record(s) ({kinds}) — "
                         "a withdrawn person can come back under that form of her ID or name")
        if extra := got - TOMBSTONES_ADDED:
            fails.append(f"#1605: the repair added {len(extra)} record(s) it must not: "
                         f"{sorted(extra)}")
        if bad := [r for r in added if r[3] is not None or r[4] != "withdrawal"]:
            fails.append(f"#1605: added rows carry an entity uuid or another reason: {bad}")
    elif "removal_tombstones" in _tables(conn):
        fails.append("#1605's fixture was not seeded, so its check proves nothing — see the "
                     "skipped list above")

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

    # ── 1.6.0's REPAIR (#1597, `d4e8a1c7b2f6`, BELOW this cut): G_SPLIT's turns, still ──
    #
    # The seed holds what that repair left; 1.7.0 must neither drop a marker (the turn
    # would keep 1.5.8's per-turn consensus under a screen that calls it current) nor add
    # one (a recompute nothing asked for). Both seeded markers must be the SAME rows.
    if "consensus_stale_targets" in _tables(conn) and not before["markers"]:
        fails.append("#1597's queue fixture was not seeded, so its check proves nothing — "
                     "see the skipped list above")
    if "consensus_stale_targets" in _tables(conn) and before["markers"]:
        queued = x("SELECT segment_id FROM consensus_stale_targets "
                   "WHERE segment_id IS NOT NULL ORDER BY segment_id").fetchall()
        got = [sid for (sid,) in queued]
        if got != sorted(QUEUE_EXPECTED):
            missing = sorted(set(QUEUE_EXPECTED) - set(got))
            extra = sorted(set(got) - set(QUEUE_EXPECTED))
            fails.append(
                f"#1597: consensus_stale_targets queues turns {got}, not {sorted(QUEUE_EXPECTED)}"
                + (f" — MISSING {missing}: a group two coders coded keeps 1.5.8's per-turn "
                   "consensus, and Recompute consensus calls it up to date" if missing else "")
                + (f" — EXTRA {extra}: a one-coder group or an ungrouped turn was queued, "
                   "which no rule changes (and which creates the consensus coder on a "
                   "lone researcher's install)" if extra else ""))
        if bad := x("SELECT COUNT(*) FROM consensus_stale_targets WHERE project_id != 1"
                    ).fetchone()[0]:
            fails.append(f"#1597: {bad} marker(s) name another project than their turn's")
        seeded = [list(map(str, r)) for r in before["markers"]]
        now_rows = [list(map(str, r)) for r in x(
            "SELECT id, project_id, segment_id, dataset_value_id, created_at "
            "FROM consensus_stale_targets WHERE id IN "
            f"({','.join('?' * len(before['markers']))}) ORDER BY id",
            tuple(r[0] for r in before["markers"])).fetchall()]
        if now_rows != seeded:
            fails.append(f"#1597: the marker queued before the upgrade changed\n"
                         f"     before={seeded}\n     after ={now_rows}")

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
    # one, and 1.7.0 rebuilds ten). A partial one must still carry its `WHERE` — the
    # same name over a different predicate is a different constraint.
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
    for name, (table, columns, unique, where, why) in NEW_INDEXES.items():
        if name in before["indexes"].get(table, {}):
            fails.append(f"index `{name}` on `{table}` existed BEFORE the upgrade, so its "
                         "presence after proves nothing about this cut — is --from-revision "
                         "the previous release's head?")
        # PRAGMA index_list: (seq, name, unique, origin, partial).
        listed = ({r[1]: (bool(r[2]), bool(r[4])) for r in x(f"PRAGMA index_list({table})")}
                  if table in _tables(conn) else {})
        if name not in listed:
            fails.append(f"index `{name}` on `{table}` was never created")
            continue
        covers = tuple(r[2] for r in x(f"PRAGMA index_info({name})"))
        if covers != columns:
            fails.append(f"index `{name}` covers {covers}, not {columns}")
        is_unique, is_partial = listed[name]
        if is_unique != unique:
            fails.append(f"index `{name}` is {'UNIQUE' if is_unique else 'not unique'}, "
                         f"and must {'be' if unique else 'NOT be'} — {why}")
        sql = " ".join(_indexes(conn, table).get(name, "").split())
        if where is None and is_partial:
            fails.append(f"index `{name}` is PARTIAL and must not be: {sql}")
        elif where is not None and not (is_partial and
                                        sql.upper().endswith(f"WHERE {where}".upper())):
            fails.append(f"index `{name}` is not partial on `{where}` — {why}: {sql}")

    # ══ BEHAVIOURAL: the new constraints actually DO what they declare ═══════
    #
    # Reflecting a constraint back only re-reads what the migration wrote. These
    # checks exercise it instead, with foreign keys ON, as the app runs. ⚠️ **They
    # all MUTATE the database, so every comparison above must already have run.**
    conn.execute("PRAGMA foreign_keys=ON")

    # 1.7.0 (#1639, #1678) — the counter WORKS: a code and a variable group made after the
    # upgrade take the id after the seeded sequence, never a deleted one's. (Code 15 and
    # group 9 were deleted before the upgrade; without the seed they would be issued again.)
    for table, insert in (
        ("codes", "INSERT INTO codes (project_id, numeric_id, name, is_universal, is_active, "
                  "created_at, updated_at) VALUES (1, 99, 'Made after the upgrade', 0, 1, ?, ?)"),
        ("analysis_domains", "INSERT INTO analysis_domains (project_id, name, created_at, "
                             "updated_at) VALUES (1, 'Made after the upgrade', ?, ?)"),
    ):
        if "AUTOINCREMENT" not in _table_sql(conn, table).upper():
            continue  # already reported above
        got = x(insert, (NOW, NOW)).lastrowid
        conn.commit()
        if got != SEQ_EXPECTED[table] + 1:
            fails.append(f"#1639/#1678: a new row of `{table}` took id {got}, not "
                         f"{SEQ_EXPECTED[table] + 1} — "
                         + ("the id of a row deleted before the upgrade"
                            if got <= SEQ_EXPECTED[table] else "the counter skipped ids"))
    # A rebuilt table's CHECK still REFUSES what it declares: a quote with a start and no end.
    if "excerpt" in _tables(conn):
        try:
            x("INSERT INTO excerpt (project_id, segment_id, start_offset, end_offset, "
              "created_at, updated_at) VALUES (1, 10, 5, NULL, ?, ?)", (NOW, NOW))
            conn.commit()
            fails.append("#1639: the rebuilt `excerpt` accepted a quote with a start offset and "
                         "no end — its CHECK constraints did not survive the rebuild")
        except Exception:
            conn.rollback()

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
            # 1.7.0 rebuilt `participants`: its speaker must keep their turns and lose
            # only the link.
            if "speakers" in _tables(conn):
                spk = x("SELECT participant_id FROM speakers WHERE id=?",
                        (SPEAKER_LINKED,)).fetchone()
                if spk is None:
                    fails.append("the SPEAKER was deleted with the participant — "
                                 "`speakers.participant_id`'s ON DELETE SET NULL did not "
                                 "survive the `participants` rebuild")
                elif spk[0] is not None:
                    fails.append(f"speakers.participant_id did not degrade: {spk[0]}")

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
