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

    python scripts/migration_rehearsal.py --from-revision b8e4c2a70d19   # v1.4.0

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


# ── What THIS release's migration must do ────────────────────────────────────
#
# ⚠️ **Review this block at every cut, exactly like `--from-revision`.** It is the
# half the script was missing at v1.3.1: v1.3.0 carried only STRUCTURAL migrations
# (table rebuilds), where "every row and every link is unchanged" is the whole of
# correctness. A DATA-REPAIR migration inverts that — the rows it is supposed to
# rewrite MUST move, and a corpus on which it no-ops proves nothing while exiting 0.
#
# ── v1.5.0 (2026-09-02) — PURELY ADDITIVE, and v1.4.0's fixture CHANGES SIDES ──
#
# `--from-revision d7f3a91c8b24` (v1.4.0's head). THREE migrations, and every one
# of them is `op.add_column` of a NULLABLE column — no FK, no default, no
# server_default, no backfill:
#
#   c9e1f4a2b7d3  recode_definitions.ranges                (#823d range bands)
#   e5c7a91d3f28  codes.magnitude_{min,max,step,labels}    (#35 the declared scale)
#                 code_applications.magnitude              (#35 the rating)
#   a9c3e7b1d5f2  code_applications.magnitude_conflict     (#35 the merge flag)
#
# 🔴 **THERE IS NO TABLE REBUILD THIS RELEASE, WHICH CHANGES WHAT THIS SCRIPT IS
# FOR.** v1.3.0's danger was DROP+RENAME cascading into children; v1.4.0's was the
# same on `dataset_columns`. `add_column` does none of that, so the parentage and
# cascade checks below are cheap insurance this time rather than the point.
#
# **The point this time is the NULLS.** `magnitude` is nullable precisely because
# NULL means UNRATED and must never be confused with a rating of ZERO (rules
# `magnitude-coding.md` §2 — MAXQDA default-stamps 0 and thereby destroys the
# distinction; on a −1…+1 scale zero is a real, meaningful neutral). A migration
# that acquired a `server_default` of 0, or a backfill "to tidy up", would
# silently fabricate a rating on every application that already exists — and
# **no count, no parentage check and no integrity_check could see it.** That is
# what the positive assertions below are for: the columns must arrive, and they
# must arrive EMPTY on pre-existing rows.
#
# 🔴 v1.4.0's own fixture CHANGES SIDES, exactly as the v1.3.1 repairs did at the
# last cut. `d7f3a91c8b24` IS `--from-revision` now, so it does NOT run here:
# `derived_from_column_id`, `derived_via` and their index are already present
# before this release's migrations start. **Asserting they exist would pass
# VACUOUSLY** — the inert-gate failure this block warns about above — so they move
# to the "must NOT touch" side. The ON DELETE SET NULL behavioural check is
# retained as coverage of the built DB, not as a claim about this release.
#
# ⚠️ The v1.3.1 repairs (`a1b2c3d4e5f7` astral offsets, `b8e4c2a70d19` note
# numbering) remain seeded at their POST-repair values and asserted invariant,
# for the same reason they were at the last cut.

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
# that pass. ⚠️ v1.5.0 rebuilds NOTHING — these are now invariance fixtures.
DC_SOURCE, DC_TARGET, DC_EQUIV, DC_PLAIN = 41, 47, 53, 61

# v1.4.0's additions. At `--from-revision d7f3a91c8b24` they are ALREADY PRESENT,
# so they are asserted UNCHANGED, never as evidence that anything ran.
V140_COLUMNS = ("derived_from_column_id", "derived_via")
V140_INDEX = "ix_dataset_columns_derived_from_column_id"

# ── What v1.5.0 must ADD, per table. Every one nullable and EMPTY on existing
# rows; see the NULLS paragraph in the block above for why "empty" is the
# assertion that matters and not merely the column's presence.
NEW_COLUMNS_BY_TABLE = {
    "recode_definitions": ("ranges",),
    "codes": ("magnitude_min", "magnitude_max", "magnitude_step", "magnitude_labels"),
    "code_applications": ("magnitude", "magnitude_conflict"),
}


def seed(db_path: Path) -> dict:
    """Fill the old-revision DB with the shapes a table rebuild can damage.

    Deliberately includes: segments under BOTH parents, the self-referencing
    merge/split links, children hanging off segments (the cascade canaries),
    excerpts in both pre-time-range shapes, and non-contiguous ids (a rebuild
    that renumbers instead of preserving ids breaks every child FK).

    Tables absent at the given revision are skipped with a note rather than
    crashing — the seed has to survive a moving "from" revision.
    """
    conn = _connect(db_path)
    conn.execute("PRAGMA foreign_keys=ON")
    x, have = conn.execute, _tables(conn)
    skipped = []

    x("INSERT INTO users (id, username, is_admin, created_at) VALUES (1,'lead',1,?)", (NOW,))
    x("INSERT INTO projects (id, user_id, name, status, created_at, updated_at) "
      "VALUES (1,1,'Rehearsal project','active',?,?)", (NOW, NOW))
    x("INSERT INTO conversations (id, project_id, name, status, created_at, updated_at, "
      "media_offset_seconds) VALUES (1,1,'Interview 01','ready',?,?,0.0)", (NOW, NOW))
    if "documents" in have:
        x("INSERT INTO documents (id, project_id, name, source_filename, source_format, "
          "segmentation_mode, created_at, updated_at) "
          "VALUES (1,1,'Brief','brief.pdf','pdf','paragraph',?,?)", (NOW, NOW))
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

    # ── dataset_columns: THE table this release rebuilds ──────────────────────
    #
    # Four columns on deliberately NON-CONTIGUOUS ids, each carrying a different
    # kind of dependant, because a DROP+RENAME can fail in four different ways:
    #   * dataset_values     — the FK children, and the cascade canary
    #   * recode_definitions — a second child table, on a different FK
    #   * equivalence_group  — exercises the PARTIAL unique index the migration's
    #                          own docstring flags as the reflection risk
    #   * an untouched plain column — the sibling that proves the rebuild did not
    #                          simply rewrite everything
    if "dataset_columns" in have:
        x("INSERT INTO datasets (id, project_id, name, created_at) VALUES (1,1,'Survey',?)", (NOW,))
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

        x("INSERT INTO dataset_rows (id, dataset_id, created_at) VALUES (1,1,?), (2,1,?)",
          (NOW, NOW))
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
    else:
        skipped.append("dataset_columns")

    conn.commit()
    snap = {
        "counts": {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                   for t in sorted(have & {
                       "users", "projects", "conversations", "documents", "segments",
                       "codes", "code_applications", "excerpt", "notes",
                       "datasets", "dataset_columns", "dataset_rows", "dataset_values",
                       "recode_definitions", "equivalence_groups"})},
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
        # Every index on the rebuilt table, so a silently-dropped one is caught.
        "dc_indexes": sorted(
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND tbl_name='dataset_columns' AND name NOT LIKE 'sqlite_%'")),
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
    same("excerpt shape, astral offsets INCLUDED (v1.4.0 must not touch them)",
         "SELECT id, segment_id, start_offset, end_offset FROM excerpt ORDER BY id",
         "excerpts")
    same("notes parentage AND numbering (v1.4.0 must not renumber)",
         "SELECT id, conversation_id, segment_id, sequence_number FROM notes ORDER BY id",
         "notes")
    same("dataset_columns rows (the REBUILT table — ids must be preserved)",
         "SELECT id, dataset_id, column_text, column_type, sequence_order, source, "
         "equivalence_group_id FROM dataset_columns ORDER BY id", "dataset_columns")
    same("dataset_values parentage (the cascade canary for the rebuild)",
         "SELECT id, row_id, column_id, value_text FROM dataset_values ORDER BY id",
         "dataset_values")
    same("recode_definitions parentage (the rebuilt table's second child)",
         "SELECT id, column_id, name, is_primary FROM recode_definitions ORDER BY id",
         "recode_defs")

    # ── What v1.5.0 must have CHANGED: three additive, EMPTY columns ──────
    #
    # No data repair and no rebuild, so "nothing moved" above IS correctness for
    # the rows. What must be different is the SHAPE — and, more importantly, what
    # must NOT have arrived with it is a value. See the NULLS paragraph at the top
    # of this file: a `server_default` of 0 or a helpful backfill on `magnitude`
    # would fabricate a rating on every pre-existing application, and no count,
    # parentage or integrity check in this script could see it.
    for table, cols in NEW_COLUMNS_BY_TABLE.items():
        have_cols = _cols(conn, table)
        missing = [c for c in cols if c not in have_cols]
        if missing:
            fails.append(f"v1.5.0: {table} is missing {missing} after the upgrade")
            continue
        rows = x(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        if not rows:
            fails.append(f"v1.5.0: {table} has NO rows, so 'the new columns are empty' "
                         "proves nothing — seed one before trusting this run")
            continue
        where = " OR ".join(f"{c} IS NOT NULL" for c in cols)
        dirty = x(f"SELECT COUNT(*) FROM {table} WHERE {where}").fetchone()[0]
        if dirty:
            fails.append(
                f"v1.5.0: {dirty} pre-existing {table} row(s) came out of the migration "
                f"with one of {list(cols)} SET. These columns must arrive EMPTY — for "
                "`magnitude`, NULL means UNRATED and a default of 0 would fabricate a "
                "rating on every application that already exists (magnitude-coding.md §2)")

    # v1.4.0's provenance fields are BELOW --from-revision now: present before this
    # release starts, so they are checked as INVARIANT, never as evidence anything ran.
    dc_cols = _cols(conn, "dataset_columns")
    for c in V140_COLUMNS:
        if c not in dc_cols:
            fails.append(f"v1.4.0 column `{c}` vanished — this release must not touch it")
    idx_now = sorted(r[0] for r in x(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND tbl_name='dataset_columns' AND name NOT LIKE 'sqlite_%'"))
    if V140_INDEX not in idx_now:
        fails.append(f"v1.4.0 index `{V140_INDEX}` vanished — this release must not touch it")
    # Kept from the v1.4.0 cut: nothing here rebuilds, so losing an index would mean
    # something rebuilt that should not have. Cheap, and it fails loudly if it does.
    lost = set(before["dc_indexes"]) - set(idx_now)
    if lost:
        fails.append(f"indexes lost on dataset_columns — nothing in v1.5.0 rebuilds "
                     f"that table, so this means something did: {sorted(lost)}")

    # ── BEHAVIOURAL: the FK actually does what it declares ────────────────
    #
    # Reflecting the FK back only re-reads what the migration wrote. Deleting a
    # source column and watching the dependant degrade is the assertion that
    # `ON DELETE SET NULL` is live — and it is the property the migration's own
    # docstring rests on ("degrades the trail rather than leaving a dangling id").
    # ⚠️ RETAINED at the v1.5.0 cut as coverage of the BUILT DB, not as a claim
    # about this release: `d7f3a91c8b24` is `--from-revision` now, so the FK it
    # declares was created before these migrations ran. It still proves the
    # constraint survives an upgrade, which is worth keeping and costs nothing.
    # ⚠️ MUTATES the DB (the delete cascades), so it must run LAST.
    if all(c in dc_cols for c in V140_COLUMNS) and \
            x("SELECT 1 FROM dataset_columns WHERE id=?", (DC_SOURCE,)).fetchone():
        conn.execute("PRAGMA foreign_keys=ON")
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
