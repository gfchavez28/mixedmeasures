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

    python scripts/migration_rehearsal.py --from-revision a9c3e7b1d5f2   # v1.5.1

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


# ── What THIS release's migration must do ────────────────────────────────────
#
# ⚠️ **Review this block at every cut, exactly like `--from-revision`.** It is the
# half the script was missing at v1.3.1: v1.3.0 carried only STRUCTURAL migrations
# (table rebuilds), where "every row and every link is unchanged" is the whole of
# correctness. A DATA-REPAIR migration inverts that — the rows it is supposed to
# rewrite MUST move, and a corpus on which it no-ops proves nothing while exiting 0.
#
# ── v1.5.2 (2026-09-11) — TWO TABLE REBUILDS, and v1.5.1's fixture CHANGES SIDES ──
#
# `--from-revision a9c3e7b1d5f2` (v1.5.1's head). THREE migrations:
#
#   c2f8a5b31d47  documents.participant_id       REBUILD  (row 46 — the document spine)
#   b7d4e2a9c153  datasets.managed_kind          REBUILD  (row 45 i.3 — the participant table)
#                 + uq_datasets_project_managed_kind, a PARTIAL unique index
#   d3f8b6e2a915  datasets.managed_synced_at               (row 45 i.4 — the freshness pair)
#                 datasets.managed_stale
#                 dataset_columns.managed_spec
#
# 🔴 **THE REBUILDS ARE BACK, AND THIS IS v1.3.0's SHAPE, NOT v1.5.0's.** The last
# two cuts were purely additive, where this script's parentage checks were cheap
# insurance rather than the point. Both rebuilds here are
# `batch_alter_table(recreate='always')` = DROP + RENAME, and both are on a PARENT
# of the coded spine:
#
#   documents → segments (ON DELETE CASCADE) → code_applications (CASCADE)
#             → notes (CASCADE)
#   datasets  → dataset_columns (CASCADE) → dataset_values (CASCADE)
#             → dataset_rows (CASCADE)
#
# If `PRAGMA foreign_keys` were ever left ON during either, SQLite's implicit
# DELETE would cascade TWO levels and the coding would vanish while the app still
# opened fine. `env.py` holds it OFF at the connection level; this script is what
# proves that held. **The seed therefore hangs a code application off a DOCUMENT
# segment**, not only a conversation one — a canary one level below the rebuilt
# table catches a cascade that counting the rebuilt table's own rows cannot see.
#
# **The second thing a rebuild can do is lose an index.** Batch reflection copies
# them; a copy that silently drops one leaves a UNIQUE constraint unenforced and
# nothing else looks wrong. `REBUILT_TABLES` snapshots every index on both tables
# before and after.
#
# ── What must ARRIVE — and the one column that must NOT arrive empty ─────────
#
# 🔴 **`managed_stale` carries a `server_default='0'`, so "every new column
# arrives NULL" — the v1.5.0 assertion — IS NOW FALSE, and carrying it forward
# would have failed a CORRECT migration.** The expectation is therefore per
# COLUMN, and the split is `d3f8b6e2a915`'s central promise rather than a detail:
#
#   * `managed_synced_at` MUST be NULL. It is the honest half — *"computed 3 days
#     ago"* — and a fabricated timestamp on a dataset that was never scored would
#     claim a snapshot exists when none does. That is the precise failure the
#     pair was designed to avoid.
#   * `managed_stale` MUST be 0. It is a POSITIVE signal only ("we know something
#     changed"), and its ABSENCE never claims freshness — so 0 on an untouched
#     dataset is TRUE, not merely harmless.
#   * `managed_spec` and `documents.participant_id` MUST be NULL. Both are CLAIMS
#     (which code this column scores; who this document is about) and a default
#     would assert one that nobody made.
#
# ── v1.5.1's magnitude fixture CHANGES SIDES ─────────────────────────────────
#
# 🔴 `a9c3e7b1d5f2` IS `--from-revision` now, so the #35 columns are present
# BEFORE these migrations start. **Asserting they arrive would pass VACUOUSLY** —
# the inert-gate failure this block warns about above — so they move to the "must
# NOT touch" side, seeded with REAL VALUES, which is the stronger test anyway:
#
#   * a rating of **0.0** on a declared −2…+2 scale. Zero is an interior,
#     meaningful neutral and NULL means UNRATED (`magnitude-coding.md` §2: MAXQDA
#     default-stamps 0 and thereby destroys the distinction). A rebuild-and-recopy
#     that coerced either into the other is invisible to every count in this file.
#   * an application deliberately left UNRATED, so NULL has to survive AS NULL.
#   * a `magnitude_conflict` — the other coder's differing rating, kept beside ours.
#
# ⚠️ The v1.3.1 repairs (`a1b2c3d4e5f7` astral offsets, `b8e4c2a70d19` note
# numbering) and v1.4.0's provenance columns remain seeded at their post-migration
# values and asserted invariant, for the same reason they were at the last cut.

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
# that pass. ⚠️ v1.5.2 does NOT rebuild this table — these are invariance fixtures,
# and the tables it DOES rebuild carry non-contiguous ids for the same reason.
DC_SOURCE, DC_TARGET, DC_EQUIV, DC_PLAIN = 41, 47, 53, 61

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

# Row 46 / row 45's own fixtures. Non-contiguous, and the second participant and
# second dataset exist only so the new constraints have something to refuse.
PARTICIPANT_LINKED, PARTICIPANT_SPARE = 7, 11
PROJECT_OTHER = 2
DS_MAIN, DS_SECOND, DS_OTHER_PROJECT = 1, 5, 9

# Both tables this release REBUILDS. A rebuild that drops an index leaves a UNIQUE
# constraint unenforced and nothing else looks wrong, so every index on both is
# snapshotted before and after. `dataset_columns` is not rebuilt here but is kept
# in the set: it is the child of one rebuilt table and was rebuilt at the v1.4.0 cut.
REBUILT_TABLES = ("documents", "datasets")
INDEXED_TABLES = REBUILT_TABLES + ("dataset_columns",)

# ── What v1.5.2 must ADD, per column, with the value it must arrive HOLDING ──
#
# 🔴 Per COLUMN, not per table, and that is the correction this cut forced: three
# of these must be NULL and `managed_stale` must be 0. See the block above — the
# v1.5.0 shape ("every new column arrives empty") would fail a correct migration.
NEW_COLUMNS = {
    "documents": {"participant_id": None},
    "datasets": {"managed_kind": None, "managed_synced_at": None, "managed_stale": 0},
    "dataset_columns": {"managed_spec": None},
}

# Indexes this release must CREATE. The partial `WHERE` on the second is what
# scopes "at most one participant dataset" to a project; its liveness is checked
# behaviourally below, and its partial-ness structurally, because SQLite treats
# NULLs as distinct in a plain unique index and the two are otherwise
# indistinguishable by behaviour alone.
NEW_INDEXES = {
    "ix_documents_participant_id": None,
    "uq_datasets_project_managed_kind": "managed_kind IS NOT NULL",
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

    # ── datasets: one of THE TWO tables this release rebuilds ─────────────────
    #
    # Three datasets: two in project 1, so "at most one participant dataset per
    # project" has something to refuse, and one in a SECOND project, so an index
    # wrongly scoped to `managed_kind` alone is caught by refusing there too.
    if "datasets" in have:
        x("INSERT INTO datasets (id, project_id, name, created_at) "
          "VALUES (?,1,'Survey',?), (?,1,'Follow-up',?), (?,?,'Other study',?)",
          (DS_MAIN, NOW, DS_SECOND, NOW, DS_OTHER_PROJECT, PROJECT_OTHER, NOW))
    else:
        skipped.append("datasets")

    # ── dataset_columns: rebuilt at the v1.4.0 cut, a CHILD of a rebuilt table now ─
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
        # Every index on both rebuilt tables (and on `dataset_columns`, a child of
        # one of them), so a silently-dropped one is caught. A dropped UNIQUE index
        # leaves a constraint unenforced and nothing else looks wrong.
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
    same("dataset_columns rows (the REBUILT table — ids must be preserved)",
         "SELECT id, dataset_id, column_text, column_type, sequence_order, source, "
         "equivalence_group_id FROM dataset_columns ORDER BY id", "dataset_columns")
    same("dataset_values parentage (the cascade canary for the rebuild)",
         "SELECT id, row_id, column_id, value_text FROM dataset_values ORDER BY id",
         "dataset_values")
    same("recode_definitions parentage (a rebuilt table's second child)",
         "SELECT id, column_id, name, is_primary FROM recode_definitions ORDER BY id",
         "recode_defs")
    same("documents rows (REBUILT — ids must be preserved, they are segment parents)",
         "SELECT id, project_id, name, source_filename FROM documents ORDER BY id",
         "documents")
    same("datasets rows (REBUILT — ids must be preserved, they are column parents)",
         "SELECT id, project_id, name FROM datasets ORDER BY id", "datasets")
    same("participants (neither rebuild may disturb the shared identity spine)",
         "SELECT id, project_id, identifier, display_name FROM participants ORDER BY id",
         "participants")
    same("dataset_rows participant links (the FK crossing the `datasets` rebuild)",
         "SELECT id, dataset_id, participant_id FROM dataset_rows ORDER BY id",
         "dataset_rows")
    same("magnitude ratings (v1.5.1's fixture: 0.0 stays 0.0, NULL stays UNRATED)",
         "SELECT id, magnitude, magnitude_conflict FROM code_applications ORDER BY id",
         "magnitudes")
    same("declared rating scales (v1.5.1's fixture — the scale 0.0 is interior to)",
         "SELECT id, magnitude_min, magnitude_max, magnitude_step, magnitude_labels "
         "FROM codes ORDER BY id", "code_scales")

    # ── What v1.5.2 must have CHANGED: five columns, and the VALUE each holds ──
    #
    # The rows must not move (asserted above); what must be different is the SHAPE,
    # and what each new column must arrive HOLDING is the assertion no count,
    # parentage or integrity check can make. 🔴 Per COLUMN — `managed_stale` has a
    # `server_default='0'` and the other four must be NULL, so the v1.5.0 form of
    # this loop ("every new column arrives empty") would fail a correct migration.
    for table, expected in NEW_COLUMNS.items():
        have_cols = _cols(conn, table)
        missing = [c for c in expected if c not in have_cols]
        if missing:
            fails.append(f"v1.5.2: {table} is missing {missing} after the upgrade")
            continue
        rows = x(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        if not rows:
            fails.append(f"v1.5.2: {table} has NO rows, so what its new columns hold "
                         "proves nothing — seed one before trusting this run")
            continue
        for col, want in expected.items():
            if want is None:
                bad = x(f"SELECT COUNT(*) FROM {table} WHERE {col} IS NOT NULL").fetchone()[0]
                why = ("it is a CLAIM — which code this column scores, who this document "
                       "is about, when this was last computed — and a default asserts one "
                       "that nobody made")
            else:
                bad = x(f"SELECT COUNT(*) FROM {table} "
                        f"WHERE {col} IS NULL OR {col} != ?", (want,)).fetchone()[0]
                why = (f"it must arrive as {want!r}: `managed_stale` is a POSITIVE signal "
                       "only, so 0 on an untouched dataset is true, while NULL would leave "
                       "a three-state flag the freshness pair does not define")
            if bad:
                fails.append(
                    f"v1.5.2: {bad} pre-existing {table} row(s) came out of the migration "
                    f"with {col} not {want!r} — {why}")

    # v1.4.0's provenance fields are BELOW --from-revision: present before this
    # release starts, so they are checked as INVARIANT, never as evidence anything ran.
    dc_cols = _cols(conn, "dataset_columns")
    for c in V140_COLUMNS:
        if c not in dc_cols:
            fails.append(f"v1.4.0 column `{c}` vanished — this release must not touch it")
    if V140_INDEX not in _indexes(conn, "dataset_columns"):
        fails.append(f"v1.4.0 index `{V140_INDEX}` vanished — this release must not touch it")

    # ── Indexes across the two REBUILDS ───────────────────────────────────────
    #
    # 🔴 This is the check the last two cuts did not need. Batch reflection COPIES
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

    # What this release must CREATE. Checked here rather than behaviourally for the
    # partial `WHERE`: SQLite treats NULLs as distinct in a plain unique index, so a
    # non-partial version of `uq_datasets_project_managed_kind` would behave
    # identically on every row this corpus can hold. The text is the only tell.
    all_indexes = {n: s for t in INDEXED_TABLES for n, s in _indexes(conn, t).items()}
    for name, predicate in NEW_INDEXES.items():
        if name not in all_indexes:
            fails.append(f"v1.5.2: index `{name}` was never created")
        elif predicate and predicate.lower() not in all_indexes[name].lower():
            fails.append(
                f"v1.5.2: index `{name}` exists but is NOT partial on `{predicate}` — "
                "without it the constraint reaches ordinary datasets, where NULL is the "
                f"normal value: {all_indexes[name]}")

    # ══ BEHAVIOURAL: the new constraints actually DO what they declare ═══════
    #
    # Reflecting a constraint back only re-reads what the migration wrote. These
    # checks exercise it instead. ⚠️ **They all MUTATE the database, so every
    # comparison above must already have run** — in particular the partial-index
    # check sets `managed_kind`, which the "arrives NULL" assertion reads.
    conn.execute("PRAGMA foreign_keys=ON")

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
        x("UPDATE documents SET participant_id=? WHERE id=1", (PARTICIPANT_LINKED,))
        conn.commit()
        linked = x("SELECT participant_id FROM documents WHERE id=1").fetchone()
        if not linked or linked[0] != PARTICIPANT_LINKED:
            fails.append(f"row 46: a document could not be linked to a participant at "
                         f"all — participant_id reads {linked}")
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
            # The same FK family on a child of the REBUILT `datasets` table.
            row = x("SELECT participant_id FROM dataset_rows WHERE id=1").fetchone()
            if row is None:
                fails.append("the dataset ROW was deleted with the participant — its "
                             "ON DELETE SET NULL did not survive the `datasets` rebuild")
            elif row[0] is not None:
                fails.append(f"dataset_rows.participant_id did not degrade: {row[0]}")

    # Row 45 (i).3: at most one participant dataset PER PROJECT. The index is what
    # makes that structural rather than something a service has to remember, so it
    # has to refuse the second one in a project — and permit one in the next.
    if "managed_kind" in _cols(conn, "datasets") and \
            x("SELECT 1 FROM datasets WHERE id=?", (DS_SECOND,)).fetchone():
        x("UPDATE datasets SET managed_kind='participants' WHERE id=?", (DS_MAIN,))
        conn.commit()
        try:
            x("UPDATE datasets SET managed_kind='participants' WHERE id=?", (DS_SECOND,))
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
