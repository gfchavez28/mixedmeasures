"""#1605 (D230) — the update upgrades each withdrawal made before it, from the plain ID its
`withdrawn` audit entry keeps (D9): the ID's composed (NFC) hash and its FOLDED name hash,
where missing. Revision `b8d4f2a6c0e9`.

Every database here is built by the real chain to the revision BEFORE the fix, filled
with Core inserts (never today's ORM, which names every column the models declare NOW —
`backend/tests/the internal design notes), then upgraded by the real chain and read back through the
app's own reader (`tombstones.load`) at head.

The revision carries its OWN copy of the two hash rules (a revision never imports `app.`);
`TestTheRevisionsRulesAreTheModules` holds the copies equal.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import unicodedata
from pathlib import Path

from alembic import command
from sqlalchemy import create_engine, insert, text
from sqlalchemy.orm import sessionmaker

from app.database import _script_only_alembic_config
from app.models.audit import AuditEntry
from app.models.project import Project
from app.models.removal_tombstone import RemovalTombstone
from app.models.user import User
from app.services import tombstones

BEFORE = "f2a6c8d4b1e7"
FIX = "b8d4f2a6c0e9"
REVISION_FILE = (Path(__file__).resolve().parents[1] / "alembic" / "versions"
                 / "b8d4f2a6c0e9_withdrawal_record_forms_1605.py")

NFC = unicodedata.normalize("NFC", "José Núñez")
NFD = unicodedata.normalize("NFD", "José Núñez")
MIXED = "José Núñez"
UUID_A = "aaaaaaaa-1605-4000-8000-000000000001"
PID = 1605


def _upgrade(db: Path, revision: str) -> None:
    cfg = _script_only_alembic_config()
    cfg.attributes["mm_database_path"] = str(db)
    command.upgrade(cfg, revision)


def _downgrade(db: Path, revision: str) -> None:
    cfg = _script_only_alembic_config()
    cfg.attributes["mm_database_path"] = str(db)
    command.downgrade(cfg, revision)


def _v1(prefix: str, written: str) -> str:
    """A row as a withdrawal before #1605 wrote it: the text as written, trimmed."""
    return hashlib.sha256((prefix + written.strip()).encode()).hexdigest()


def _withdrawn(details) -> dict:
    return {"action": "withdrawn", "entity_type": "participant", "project_id": PID,
            "details": details if details is None or isinstance(details, str)
            else json.dumps(details)}


def _a_160_install(db: Path, entries: list[dict]) -> None:
    """A database at `BEFORE` holding one project that withdrew `M01` ("Maria") and an
    NFD `José Núñez`, with the record those withdrawals wrote, and `entries` beside."""
    _upgrade(db, BEFORE)
    engine = create_engine(f"sqlite:///{db}")
    with engine.begin() as c:
        c.execute(insert(User.__table__).values(id=1, username="Owner", coder_type="human"))
        c.execute(insert(Project.__table__).values(
            id=PID, name="Withdrawals", user_id=1, project_uuid=UUID_A))
        for kind, h in (("participant", _v1("mm-withdrawn-identifier:v1:", "M01")),
                        ("participant_name", _v1("mm-withdrawn-name:v1:", "Maria")),
                        ("participant", _v1("mm-withdrawn-identifier:v1:", NFD))):
            c.execute(insert(RemovalTombstone.__table__).values(
                project_uuid=UUID_A, entity_type=kind, identifier_hash=h, reason="withdrawal"))
        for e in [_withdrawn({"identifier": "M01", "participant_id": 7}),
                  _withdrawn({"identifier": NFD}), *entries]:
            c.execute(insert(AuditEntry.__table__).values(**e))
    engine.dispose()


def _rows(db: Path) -> set[tuple[str, str]]:
    engine = create_engine(f"sqlite:///{db}")
    try:
        with engine.connect() as c:
            return set(c.execute(text(
                "SELECT entity_type, identifier_hash FROM removal_tombstones "
                "WHERE project_uuid = :u"), {"u": UUID_A}).all())
    finally:
        engine.dispose()


def _record(db: Path) -> tombstones.Tombstones:
    engine = create_engine(f"sqlite:///{db}")
    s = sessionmaker(bind=engine)()
    try:
        return tombstones.load(s, UUID_A)
    finally:
        s.close()
        engine.dispose()


def _revision_module():
    spec = importlib.util.spec_from_file_location("rev_1605", REVISION_FILE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestTheUpgrade:
    def test_it_adds_the_composed_ID_and_the_IDs_folded_name_where_missing(self, tmp_path):
        db = tmp_path / "mm.db"
        _a_160_install(db, [])
        before = _rows(db)
        _upgrade(db, FIX)
        added = _rows(db) - before
        assert added == {
            ("participant", tombstones.identifier_hash(NFC)),         # the NFD ID, composed
            ("participant_name", tombstones.folded_name_hash(NFD)),
            ("participant_name", tombstones.folded_name_hash("M01")),
        }   # M01's composed hash IS its old hash: nothing added for it

    def test_what_it_makes_recognisable_and_what_it_cannot(self, tmp_path):
        db = tmp_path / "mm.db"
        _a_160_install(db, [])
        old = _record(db)
        assert old.withdrawn_speaker_match("JOSÉ NÚÑEZ") is None
        assert old.withdrawn_speaker_match("m01") is None
        _upgrade(db, FIX)
        t = _record(db)
        assert t.withdrawn_speaker_match("JOSÉ NÚÑEZ") == tombstones.SPEAKER_MATCH_FOLDED
        assert t.withdrawn_speaker_match("m01") == tombstones.SPEAKER_MATCH_FOLDED
        assert not t.withdrawn_identifier("m01")               # an ID keeps its capitals
        assert t.withdrawn_speaker_match("Maria") == tombstones.SPEAKER_MATCH_EXACT
        assert t.withdrawn_speaker_match("MARIA") is None      # her other names: as written

    def test_entries_it_cannot_read_or_must_not_use_are_skipped(self, tmp_path):
        db = tmp_path / "mm.db"
        _a_160_install(db, [
            _withdrawn("{not json"),
            _withdrawn({"identifier": 42}),
            _withdrawn({"participant_id": 3}),
            _withdrawn(None),
            {**_withdrawn({"identifier": "GONE1"}), "project_id": 99999},   # no such project
            {**_withdrawn({"identifier": "EDIT1"}), "action": "participant_updated"},
            {**_withdrawn({"identifier": "SPK1"}), "entity_type": "speaker"},
        ])
        before = _rows(db)
        _upgrade(db, FIX)
        assert len(_rows(db) - before) == 3                    # the first test's three only

    def test_it_is_idempotent_and_a_repeated_withdrawal_is_one_row(self, tmp_path):
        db = tmp_path / "mm.db"
        _a_160_install(db, [_withdrawn({"identifier": NFD})])   # NFD withdrawn twice
        _upgrade(db, FIX)
        once = _rows(db)
        _downgrade(db, BEFORE)                                  # a no-op …
        assert _rows(db) == once
        _upgrade(db, FIX)                                       # … and again, nothing new
        assert _rows(db) == once
        engine = create_engine(f"sqlite:///{db}")
        with engine.connect() as c:
            dupes = c.execute(text(
                "SELECT count(*) FROM (SELECT entity_type, identifier_hash FROM "
                "removal_tombstones GROUP BY project_uuid, entity_type, identifier_hash "
                "HAVING count(*) > 1)")).scalar()
        engine.dispose()
        assert dupes == 0


class TestTheRevisionsRulesAreTheModules:
    CASES = ("P01", "  P01 ", "p01", NFC, NFD, MIXED, "  MARÍA   López ", "maria lopez",
             "", "   ", None)

    def test_the_copied_rules_equal_the_apps(self):
        rev = _revision_module()
        for case in self.CASES:
            assert rev.identifier_hash(case) == tombstones.identifier_hash(case), case
            assert rev.folded_name_hash(case) == tombstones.folded_name_hash(case), case

    def test_the_cases_discriminate(self):
        """The fixture could have disagreed: the forms hash differently as written, and a
        rule that skipped composing or folding would differ from the app's."""
        assert len({_v1("p:", c) for c in (NFC, NFD, MIXED)}) == 3
        assert len({tombstones.identifier_hash(c) for c in (NFC, NFD, MIXED)}) == 1
        assert tombstones.identifier_hash("P01") != tombstones.identifier_hash("p01")
        assert (tombstones.folded_name_hash("  MARÍA   López ")
                == tombstones.folded_name_hash(unicodedata.normalize("NFD", "maría lópez")))
        assert (tombstones.folded_name_hash("María")
                != tombstones.folded_name_hash("Maria"))          # never the accents


def test_the_fix_is_in_the_chain_the_app_runs():
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(_script_only_alembic_config())
    assert len(script.get_heads()) == 1
    assert script.get_revision(FIX).down_revision == BEFORE
    assert FIX in {r.revision for r in script.walk_revisions()}
