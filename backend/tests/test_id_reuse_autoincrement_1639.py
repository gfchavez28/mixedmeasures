"""#1639 option (c), r2-1 … r2-3 — a deleted row's id is never handed to the next row of the
tables a joint display names by id. Revision `c3a7e1f9b5d8`.

A display is one Tiptap node in canvas text (D162), so its ids are plain integers with no
foreign key. Without AUTOINCREMENT SQLite gives a new row `max(id) + 1`, so deleting a table's
NEWEST row hands its id to the next one, and a display that bound the deleted row would draw
the new row's numbers under the old construct's name.

- `TestTheSchemaTheSuiteBuilds` — on `create_all()`'s schema (what the suite and the models
  declare): delete the newest row of each table, make another, and the id is new.
- `TestTheCensus` — the tables are every table `services/joint_display_node.py` names, less a
  stated exemption, and the revision's frozen list is the same set: a new id-holding key on a
  table that reuses ids fails here.
- `TestTheUpgrade` — the real chain from the revision before: every id and child link kept,
  the tables AUTOINCREMENT, the sequence raised past an id the audit trail names (r2-2), and a
  downgrade that returns them.
- `TestTheHarnessSeesIt` — `scripts/schema_diff_harness.py` compares AUTOINCREMENT, because
  SQLAlchemy does not reflect it and a later batch rebuild would otherwise drop it unseen.

Databases at a revision are built by the real chain and filled with raw SQL (never today's
ORM, which names every column the models declare NOW — `backend/tests/the internal design notes).
"""
from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import create_engine

from app.database import Base, _script_only_alembic_config
from app.services import joint_display_node as node

BACKEND = Path(__file__).resolve().parents[1]
BEFORE = "b8d4f2a6c0e9"
FIX = "c3a7e1f9b5d8"
REVISION_FILE = BACKEND / "alembic" / "versions" / "c3a7e1f9b5d8_never_reuse_bound_ids_1639.py"

#: The node module names tables by its remap's names; two differ from SQL's.
REMAP_TO_SQL = {"excerpts": "excerpt", "coders": "users"}
#: A table the node names that may keep reusing ids, and why (r2-1).
EXEMPT = {"users": "nothing deletes a user (no route, no service)"}
#: The tables `c3a7e1f9b5d8` made never reuse an id (r2-1).
NEVER_REUSED_1639 = {"codes", "dataset_columns", "conversations", "documents", "observations",
                     "datasets", "materials", "excerpt", "participants"}
#: #1678 D366 — `bdf1ffd93239`: a saved chart's variable groups (`domain_ids`).
NEVER_REUSED_1678 = {"analysis_domains"}
NEVER_REUSED = NEVER_REUSED_1639 | NEVER_REUSED_1678
FIX_1678 = "bdf1ffd93239"
REVISION_FILE_1678 = BACKEND / "alembic" / "versions" / "bdf1ffd93239_analysis_domains_never_reuse_ids_1678.py"

#: #1678 D367 — a chart setting's id KIND (`services/material_config.py`) → its table.
CHART_KIND_TABLES = {
    "column": "dataset_columns", "domain": "analysis_domains", "code": "codes",
    "category": "code_categories", "conversation": "conversations", "document": "documents",
    "observation": "observations", "participant": "participants", "coder": "users",
    "metric": "metric_definitions",
}
#: A chart setting's table that may keep reusing ids, and why (D367).
CHART_EXEMPT = {
    "users": "nothing deletes a user — a coder id names the same person for good",
    "metric_definitions": "only inside `custom_order`, which orders the chart's axis and selects "
                          "nothing: a reused id moves a bar, never draws another variable",
    "code_categories": "only inside `custom_order` (under `code_mode: categories`): it orders, "
                       "and selects nothing",
}


def _node_tables() -> set[str]:
    maps = [node.DISPLAY_ID_KEYS, node.ATTRIBUTION_ID_KEYS, node.ROW_ID_KEYS,
            node.META_INFERENCE_ID_KEYS, node.STRAND_ID_KEYS, node.BINDING_ID_KEYS,
            node.PIN_ID_KEYS, node.MISFIT_CASE_ID_KEYS, node.MISFIT_CONDITION_ID_KEYS]
    names = {table for m in maps for table, _ in m.values()}
    names |= set(node.BASELINE_KEY_TABLES.values())
    return {REMAP_TO_SQL.get(n, n) for n in names}


def _autoincrement_tables(path: Path) -> set[str]:
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return {n for n, sql in c.execute("SELECT name, sql FROM sqlite_master WHERE type='table'")
                if sql and "AUTOINCREMENT" in sql.upper()}
    finally:
        c.close()


def _fill(c: sqlite3.Connection, table: str, n: int) -> int:
    """Insert one row with a distinct value in every NOT NULL column; return its id."""
    cols, vals = [], []
    for _, name, typ, notnull, default, pk in c.execute(f'PRAGMA table_info("{table}")'):
        if pk or not notnull or default is not None:
            continue
        typ = (typ or "").upper()
        cols.append(f'"{name}"')
        vals.append(n if typ.startswith(("INT", "BOOL", "FLOAT", "NUM", "REAL"))
                    else f"2026-01-0{1 + n % 9} 00:00:00" if typ.startswith(("DATE", "TIME"))
                    else f"r2-{table}-{n}")
    marks = ", ".join("?" for _ in vals)
    cur = c.execute(f'INSERT INTO "{table}" ({", ".join(cols)}) VALUES ({marks})', vals)
    return cur.lastrowid


def _the_newest_id_after_a_delete(path: Path, table: str) -> tuple[int, int]:
    """Make two rows, delete the newer, make a third: (the deleted id, the third's id)."""
    c = sqlite3.connect(str(path))
    try:
        # Parents and CHECKs are not this test's subject: the id SQLite hands out is.
        c.execute("PRAGMA foreign_keys=OFF")
        c.execute("PRAGMA ignore_check_constraints=ON")
        _fill(c, table, 1)
        freed = _fill(c, table, 2)
        c.execute(f'DELETE FROM "{table}" WHERE id = ?', (freed,))
        return freed, _fill(c, table, 3)
    finally:
        c.close()


def _upgrade(db: Path, revision: str) -> None:
    cfg = _script_only_alembic_config()
    cfg.attributes["mm_database_path"] = str(db)
    command.upgrade(cfg, revision)


def _downgrade(db: Path, revision: str) -> None:
    cfg = _script_only_alembic_config()
    cfg.attributes["mm_database_path"] = str(db)
    command.downgrade(cfg, revision)


def _revision_module(path: Path = REVISION_FILE):
    spec = importlib.util.spec_from_file_location(f"rev_{path.stem[:12]}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def models_db(tmp_path_factory) -> Path:
    path = tmp_path_factory.mktemp("models") / "create_all.db"
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    engine.dispose()
    return path


class TestTheSchemaTheSuiteBuilds:
    @pytest.mark.parametrize("table", sorted(NEVER_REUSED))
    def test_a_deleted_newest_id_is_not_handed_to_the_next_row(self, models_db, table):
        freed, new = _the_newest_id_after_a_delete(models_db, table)
        assert new > freed, f"{table}: the next row took the deleted row's id {freed}"

    def test_positive_control_a_table_left_out_still_reuses(self, models_db):
        """Non-vacuous: the helper CAN see reuse — `segments` is left out (r2-1)."""
        freed, new = _the_newest_id_after_a_delete(models_db, "segments")
        assert new == freed


def _chart_tables() -> dict[str, set[str]]:
    """#1678 D367 — every table a saved chart's settings can name, by where it is named:
    `ID_KEYS` and `TAGGED_KEYS` select what the chart draws; `custom_order` only orders it."""
    from app.services import material_config as mc
    selecting = {k.kind for k in mc.ID_KEYS.values()}
    selecting |= {kind for tags in mc.TAGGED_KEYS.values() for kind in tags.values()}
    ordering = {mc.METRIC, mc.CATEGORY, mc.CODE}  # `order_kind`'s three answers
    unknown = (selecting | ordering) - set(CHART_KIND_TABLES)
    assert not unknown, f"a chart setting names a kind this census has no table for: {unknown}"
    return {"selecting": {CHART_KIND_TABLES[k] for k in selecting},
            "ordering": {CHART_KIND_TABLES[k] for k in ordering}}


class TestTheCensus:
    def test_every_table_the_display_names_never_reuses_an_id(self, models_db):
        named = _node_tables()
        assert named - set(EXEMPT) <= NEVER_REUSED, (
            "joint_display_node names a table that reuses ids — add it to a migration with "
            "AUTOINCREMENT (and to NEVER_REUSED), or exempt it with a reason")
        assert NEVER_REUSED <= _autoincrement_tables(models_db)

    def test_every_table_a_chart_setting_names_never_reuses_an_id(self):
        """#1678 D367 — `analysis_domains` was the one a chart's `domain_ids` named that still
        reused ids, and the census read only the joint display's keys."""
        chart = _chart_tables()
        reusing = (chart["selecting"] | chart["ordering"]) - NEVER_REUSED - set(CHART_EXEMPT)
        assert not reusing, (
            f"a chart setting names {sorted(reusing)}, which reuse ids — give it AUTOINCREMENT "
            "in a revision (and NEVER_REUSED), or exempt it in CHART_EXEMPT with the reason")
        # An exemption for a SELECTING key must be the no-delete kind (coders) — ordering ones
        # are exempt because they only order.
        assert chart["selecting"] & set(CHART_EXEMPT) == {"users"}

    def test_the_tables_that_must_not_reuse_are_exactly_the_two_censuses(self):
        named = (_node_tables() - set(EXEMPT)) | (
            (_chart_tables()["selecting"] | _chart_tables()["ordering"]) - set(CHART_EXEMPT))
        assert named == NEVER_REUSED

    def test_the_exemptions_are_named_by_the_display(self):
        assert set(EXEMPT) <= _node_tables()

    def test_the_chart_exemptions_are_named_by_a_chart(self):
        chart = _chart_tables()
        assert set(CHART_EXEMPT) <= chart["selecting"] | chart["ordering"]

    def test_the_revisions_frozen_list_is_the_same_set(self):
        """#1678 D367: the union of both revisions' frozen lists."""
        assert set(_revision_module().TABLES) == NEVER_REUSED_1639
        assert set(_revision_module(REVISION_FILE_1678).TABLES) == NEVER_REUSED_1678
        assert NEVER_REUSED_1639 | NEVER_REUSED_1678 == NEVER_REUSED

    def test_the_fix_is_in_the_chain_the_app_runs(self):
        from alembic.script import ScriptDirectory

        script = ScriptDirectory.from_config(_script_only_alembic_config())
        assert script.get_revision(FIX).down_revision == BEFORE
        assert FIX in {r.revision for r in script.walk_revisions()}


def _a_db_before_the_fix(db: Path) -> None:
    """A database at `BEFORE`: one project, three codes (the newest of four already deleted,
    with the audit entry that created it), two coded passages, one column and its value."""
    _upgrade(db, BEFORE)
    c = sqlite3.connect(str(db))
    c.executescript("""
        INSERT INTO users (id, username, is_admin, created_at, coder_type)
            VALUES (1, 'Owner', 0, '2026-01-01', 'human');
        INSERT INTO projects (id, name, user_id, status, created_at, updated_at)
            VALUES (1, 'P', 1, 'active', '2026-01-01', '2026-01-01');
        INSERT INTO codes (id, project_id, numeric_id, name, is_universal, is_active,
                           created_at, updated_at)
            VALUES (1, 1, 10, 'A', 0, 1, '2026-01-01', '2026-01-01'),
                   (2, 1, 11, 'B', 0, 1, '2026-01-01', '2026-01-01'),
                   (3, 1, 12, 'C', 0, 1, '2026-01-01', '2026-01-01');
        INSERT INTO audit_entries (timestamp, action, entity_type, entity_id, project_id)
            VALUES ('2026-01-01', 'created', 'code', 4, 1),
                   ('2026-01-01', 'merged', 'code', 3, 1);
        INSERT INTO conversations (id, project_id, name, status, created_at, updated_at,
                                   media_offset_seconds)
            VALUES (1, 1, 'Interview', 'imported', '2026-01-01', '2026-01-01', 0);
        INSERT INTO segments (id, conversation_id, sequence_order, text, created_at,
                              is_starred, is_merge_result, is_split_result)
            VALUES (1, 1, 1, 'one', '2026-01-01', 0, 0, 0),
                   (2, 1, 2, 'two', '2026-01-01', 0, 0, 0);
        INSERT INTO code_applications (segment_id, code_id, user_id, created_at)
            VALUES (1, 2, 1, '2026-01-01'), (2, 3, 1, '2026-01-01');
    """)
    c.commit()
    c.close()


def _q(db: Path, sql: str, *args):
    c = sqlite3.connect(str(db))
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


class TestTheUpgrade:
    def test_ids_and_links_are_kept_and_the_tables_never_reuse(self, tmp_path):
        db = tmp_path / "pre.db"
        try:
            _a_db_before_the_fix(db)
        except sqlite3.Error as exc:  # a column this fixture does not know — fix the fixture
            pytest.fail(f"fixture: {exc}")
        assert NEVER_REUSED_1639.isdisjoint(_autoincrement_tables(db)), "precondition: before"
        before = _q(db, "SELECT segment_id, code_id FROM code_applications ORDER BY 1")

        _upgrade(db, FIX)

        assert NEVER_REUSED_1639 <= _autoincrement_tables(db)
        assert _q(db, "SELECT id, name FROM codes ORDER BY id") == [(1, "A"), (2, "B"), (3, "C")]
        assert _q(db, "SELECT segment_id, code_id FROM code_applications ORDER BY 1") == before
        assert _q(db, "PRAGMA foreign_key_check") == []

    def test_an_id_the_audit_trail_names_is_not_issued_again(self, tmp_path):
        """r2-2 — code 4 was created (audited) and deleted before the upgrade; the copy alone
        would start the sequence at 3 and give the next code id 4 once."""
        db = tmp_path / "pre.db"
        _a_db_before_the_fix(db)
        _upgrade(db, FIX)
        assert _q(db, "SELECT seq FROM sqlite_sequence WHERE name = 'codes'") == [(4,)]
        c = sqlite3.connect(str(db))
        new = c.execute(
            "INSERT INTO codes (project_id, numeric_id, name, is_universal, is_active, "
            "created_at, updated_at) "
            "VALUES (1, 13, 'D', 0, 1, '2026-01-02', '2026-01-02')").lastrowid
        c.commit()
        c.close()
        assert new == 5

    def test_a_table_the_audit_never_names_starts_at_its_highest_id(self, tmp_path):
        """The stated residual (r2-2): `conversations` has no audited id above its rows here,
        so the sequence starts at the highest id still in the table."""
        db = tmp_path / "pre.db"
        _a_db_before_the_fix(db)
        _upgrade(db, FIX)
        assert _q(db, "SELECT seq FROM sqlite_sequence WHERE name = 'conversations'") == [(1,)]

    def test_the_downgrade_returns_the_tables_and_keeps_the_ids(self, tmp_path):
        db = tmp_path / "pre.db"
        _a_db_before_the_fix(db)
        _upgrade(db, FIX)
        _downgrade(db, BEFORE)
        assert NEVER_REUSED_1639.isdisjoint(_autoincrement_tables(db))
        assert _q(db, "SELECT name FROM sqlite_sequence WHERE name IN ('codes', 'participants')") == []
        assert _q(db, "SELECT id FROM codes ORDER BY id") == [(1,), (2,), (3,)]
        assert _q(db, "PRAGMA foreign_key_check") == []


class TestTheHarnessSeesIt:
    @staticmethod
    def _harness():
        sys.path.insert(0, str(BACKEND / "scripts"))
        try:
            import schema_diff_harness
        finally:
            sys.path.pop(0)
        return schema_diff_harness

    def test_a_table_that_lost_autoincrement_is_a_diff(self, tmp_path):
        h = self._harness()
        a, b = tmp_path / "a.db", tmp_path / "b.db"
        for path, ddl in ((a, "CREATE TABLE t (id INTEGER NOT NULL, PRIMARY KEY (id))"),
                          (b, "CREATE TABLE t (id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT)")):
            c = sqlite3.connect(str(path))
            c.execute(ddl)
            c.close()
        assert any("AUTOINCREMENT" in line
                   for line in h.diff_schemas(h.introspect(a), h.introspect(b)))
        assert h.diff_schemas(h.introspect(b), h.introspect(b)) == []


class TestTheUpgrade1678:
    """#1678 D366 — `bdf1ffd93239`: `analysis_domains` the same way, from the revision before."""

    def _a_db_before(self, db: Path) -> None:
        _upgrade(db, FIX)
        c = sqlite3.connect(str(db))
        c.executescript("""
            INSERT INTO users (id, username, is_admin, created_at, coder_type)
                VALUES (1, 'Owner', 0, '2026-01-01', 'human');
            INSERT INTO projects (id, name, user_id, status, created_at, updated_at)
                VALUES (1, 'P', 1, 'active', '2026-01-01', '2026-01-01');
            INSERT INTO analysis_domains (id, project_id, name, origin, created_at, updated_at)
                VALUES (1, 1, 'Wellbeing', 'human', '2026-01-01', '2026-01-01'),
                       (2, 1, 'Burnout', 'human', '2026-01-01', '2026-01-01');
            INSERT INTO analysis_domain_members (domain_id, member_type, member_id, sequence_order,
                                                 created_at)
                VALUES (2, 'column', 7, 0, '2026-01-01');
            INSERT INTO audit_entries (timestamp, action, entity_type, entity_id, project_id)
                VALUES ('2026-01-01', 'created', 'analysis_domain', 3, 1),
                       ('2026-01-01', 'deleted', 'analysis_domain', 3, 1);
        """)
        c.commit()
        c.close()

    def test_ids_and_members_are_kept_and_the_table_never_reuses(self, tmp_path):
        db = tmp_path / "pre.db"
        try:
            self._a_db_before(db)
        except sqlite3.Error as exc:  # a column this fixture does not know — fix the fixture
            pytest.fail(f"fixture: {exc}")
        assert "analysis_domains" not in _autoincrement_tables(db), "precondition: before"
        _upgrade(db, FIX_1678)
        assert "analysis_domains" in _autoincrement_tables(db)
        assert _q(db, "SELECT id, name FROM analysis_domains ORDER BY id") == [(1, "Wellbeing"), (2, "Burnout")]
        assert _q(db, "SELECT domain_id, member_id FROM analysis_domain_members") == [(2, 7)]
        assert _q(db, "PRAGMA foreign_key_check") == []

    def test_an_id_the_audit_trail_names_is_not_issued_again(self, tmp_path):
        """Group 3 was made and deleted before the upgrade; the copy alone starts at 2."""
        db = tmp_path / "pre.db"
        self._a_db_before(db)
        _upgrade(db, FIX_1678)
        assert _q(db, "SELECT seq FROM sqlite_sequence WHERE name = 'analysis_domains'") == [(3,)]
        c = sqlite3.connect(str(db))
        new = c.execute("INSERT INTO analysis_domains (project_id, name, origin, created_at, updated_at) "
                        "VALUES (1, 'New', 'human', '2026-01-02', '2026-01-02')").lastrowid
        c.commit()
        c.close()
        assert new == 4

    def test_the_downgrade_returns_the_table_and_keeps_the_ids(self, tmp_path):
        db = tmp_path / "pre.db"
        self._a_db_before(db)
        _upgrade(db, FIX_1678)
        _downgrade(db, FIX)
        assert "analysis_domains" not in _autoincrement_tables(db)
        assert NEVER_REUSED_1639 <= _autoincrement_tables(db), "the nine stay as they were"
        assert _q(db, "SELECT id FROM analysis_domains ORDER BY id") == [(1,), (2,)]

    def test_the_fix_is_in_the_chain_the_app_runs(self):
        from alembic.script import ScriptDirectory

        script = ScriptDirectory.from_config(_script_only_alembic_config())
        assert script.get_revision(FIX_1678).down_revision == FIX
