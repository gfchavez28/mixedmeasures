"""#1035 — deleting a whole project: the database deletes, the ORM loads nothing.

`db.delete(project)` used to LOAD every child as an ORM object purely to delete it
(50 cascade relationships reachable from `Project`, 6 passive): 76 s / 3.2 GB on
the BES corpus, 11.3 min / 6.5 GB on a 300-interview project. Now every `Project`
collection is `passive_deletes=True` and `services/project_deletion.py` deletes the
data-scaled tables leaf-first in one statement each (review:
the internal design notes).

The guards, each with what it kills:
- **G1 structural** — every `Project` collection and the second layer is passive
  over an `ON DELETE CASCADE` FK, derived from the mapper (a 22nd collection
  without the flag fails), plus the SET NULL rule the review measured.
- **G2 census** — a target AND a control project, each holding a row in EVERY
  table reachable from `projects` (derived from `Base.metadata`, self-checked):
  the target's rows go, the control's stay, FKs stay clean, and no child table is
  SELECTed during the delete.
- **G2b order** — the statement sequence. ⚠️ Removing one statement leaves G2
  GREEN (the cascade still deletes those rows, only slower), so the order is pinned
  here or nowhere.
- **G3** — the endpoint's success path over HTTP: project gone, folders gone, the
  audit entry written. It had no test at all (only a refusal 404).
- **G4** — the overwrite import, which deletes through the same function, under
  SQLAlchemy warnings as errors (an identity the session still held is a warning).
- **G5** — conversation, document, observation and metric deletes (second layer),
  each against a control, + a statement count that does not grow with the data.
"""
import asyncio
import warnings
from pathlib import Path

import pytest
from sqlalchemy import event, inspect, text
from sqlalchemy.exc import SAWarning
from sqlalchemy.orm import ONETOMANY

from app.database import Base
from app.models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from app.models.canvas import (
    Canvas, CanvasPendingItem, CanvasSnapshot, CanvasTheme, CanvasThemeRelationship,
)
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_category import CodeCategory, CodeCategoryMembership
from app.models.code_equivalence_group import CodeEquivalenceGroup
from app.models.code_set import CodeSet
from app.models.consensus_stale_target import ConsensusStaleTarget
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn, DatasetRow, DatasetValue
from app.models.document import Document
from app.models.equivalence_group import EquivalenceGroup
from app.models.excerpt import Excerpt
from app.models.materials import Material, MaterialCollection
from app.models.memo import Memo
from app.models.metric import ComputedResult, MetricDefinition
from app.models.note import Note
from app.models.observation import Observation
from app.models.participant import Participant
from app.models.project import Project
from app.models.quote_board_config import QuoteBoardConfig
from app.models.recode import RecodeDefinition
from app.models.row_score import RowScore
from app.models.scratchpad import ScratchpadEntry
from app.models.segment import Segment
from app.models.segment_group import SegmentGroup
from app.models.speaker import Speaker
from app.models.statistical_test import StatisticalTest
from app.models.text_coding_config import TextCodingConfig
from app.models.user import User
from app.routers.conversations import delete_conversation
from app.routers.documents import delete_document
from app.routers.metrics import delete_metric
from app.routers.observations import delete_observation
from app.routers.projects import delete_project
from app.services.project_deletion import delete_project_tree
from app.services.project_portability import export_project, import_project


def _run(x):
    return asyncio.run(x) if asyncio.iscoroutine(x) else x


# ── G1: structural ─────────────────────────────────────────────────────────


def _loading_cascades(cls) -> set[str]:
    """One-to-many relationships whose delete cascade LOADS its children first."""
    return {
        rel.key for rel in inspect(cls).relationships
        if rel.direction is ONETOMANY and "delete" in rel.cascade and not rel.passive_deletes
    }


def _ondeletes(rel) -> set:
    return {fk.ondelete for col in rel.remote_side for fk in col.foreign_keys}


# The delete of ONE conversation, document, observation, segment, code or metric
# — each a door of its own. Measured (2026-10-13): a 1,000-turn conversation 2.12 s
# and 5,023 SELECTs → 0.17 s and 1; one GSS metric with 75,699 row scores 3.1 s /
# 232 MB → 0.25 s / 69 MB. The small canvas, material and domain collections are
# left loading on purpose: nothing there is data-scaled.
SECOND_LAYER = {
    (Conversation, "segments"), (Conversation, "attached_notes"),
    (Document, "segments"), (Document, "notes"),
    (Observation, "segments"), (Observation, "notes"),
    (Segment, "code_applications"), (Segment, "excerpts"),
    (Code, "applications"),
    (MetricDefinition, "results"), (MetricDefinition, "row_scores"),
}

# Passive over SET NULL, which leaves a LOADED child reading the deleted parent's
# id (`test_canvas.py::test_theme_parent_set_null_on_delete` fails if
# `CanvasTheme.children` takes it). These predate #1035 and are deliberate:
# `equivalence.md` §1 — a group merge reassigns its members through the
# relationship setter and must not have the ORM null them behind it.
PASSIVE_SET_NULL = {
    ("EquivalenceGroup", "columns"),
    ("CodeEquivalenceGroup", "codes"),
    ("CodeSet", "codes"),
}


class TestStructure:
    def test_every_project_collection_is_passive_over_a_cascading_fk(self):
        rels = [r for r in inspect(Project).relationships if r.direction is ONETOMANY]
        assert len(rels) >= 21, "population: Project had 21 collections on 2026-10-13"
        assert _loading_cascades(Project) == set(), (
            "a Project collection without passive_deletes=True loads every child on a "
            "project delete (#1035) — add the flag (the FK must be ON DELETE CASCADE)"
        )
        for rel in rels:
            assert _ondeletes(rel) == {"CASCADE"}, (rel.key, _ondeletes(rel))

    @pytest.mark.parametrize("cls,key", sorted(SECOND_LAYER, key=lambda p: (p[0].__name__, p[1])),
                             ids=lambda v: getattr(v, "__name__", v))
    def test_the_second_layer_is_passive_over_a_cascading_fk(self, cls, key):
        rel = inspect(cls).relationships[key]
        assert rel.passive_deletes is True, f"{cls.__name__}.{key}"
        assert _ondeletes(rel) == {"CASCADE"}, f"{cls.__name__}.{key}"

    def test_no_new_passive_relationship_over_SET_NULL(self):
        found = {
            (m.class_.__name__, rel.key)
            for m in Base.registry.mappers for rel in m.relationships
            if rel.direction is ONETOMANY and rel.passive_deletes
            and _ondeletes(rel) == {"SET NULL"}
        }
        assert found == PASSIVE_SET_NULL

    def test_the_predicate_fires(self):
        """Falsifier: `User.projects` is a loading cascade, so the predicate must see it."""
        assert _loading_cascades(User) == {"projects"}


# ── a project holding a row in every reachable table ───────────────────────


def _reachable_tables() -> set[str]:
    """Every table the database's ON DELETE CASCADE reaches from `projects`."""
    reach = {"projects"}
    grew = True
    while grew:
        grew = False
        for table in Base.metadata.sorted_tables:
            if table.name not in reach and any(
                fk.column.table.name in reach and fk.ondelete == "CASCADE"
                for fk in table.foreign_keys
            ):
                reach.add(table.name)
                grew = True
    return reach


def _seed_project(db, tag: str) -> dict:
    """One project with at least one row in every table `_reachable_tables` names."""
    def add(obj):
        db.add(obj)
        db.flush()
        return obj

    p = add(Project(name=f"P-{tag}", user_id=1))
    part = add(Participant(project_id=p.id, identifier=f"id-{tag}"))
    spk = add(Speaker(project_id=p.id, name=f"S-{tag}", participant_id=part.id))
    cat = add(CodeCategory(project_id=p.id, name=f"Cat-{tag}"))
    add(CodeCategory(project_id=p.id, name=f"Sub-{tag}", parent_id=cat.id))
    cset = add(CodeSet(project_id=p.id, label=f"Set-{tag}"))
    ceg = add(CodeEquivalenceGroup(project_id=p.id, label=f"CEG-{tag}"))
    code = add(Code(project_id=p.id, name=f"C-{tag}", numeric_id=1, category_id=cat.id,
                    code_set_id=cset.id, code_equivalence_group_id=ceg.id))
    add(CodeCategoryMembership(code_id=code.id, category_id=cat.id))

    conv = add(Conversation(project_id=p.id, name=f"conv-{tag}"))
    grp = add(SegmentGroup(conversation_id=conv.id))
    segs = [add(Segment(conversation_id=conv.id, speaker_id=spk.id, sequence_order=i,
                        text=f"turn {i}", group_id=grp.id if i < 2 else None))
            for i in range(3)]
    merged = add(Segment(conversation_id=conv.id, sequence_order=9, text="merged",
                         is_merge_result=1))
    segs[2].merged_into_id = merged.id
    doc = add(Document(project_id=p.id, name=f"doc-{tag}", source_filename="d.txt",
                       source_format="txt", participant_id=part.id))
    dseg = add(Segment(document_id=doc.id, sequence_order=0, text="para"))
    obs = add(Observation(project_id=p.id, name=f"obs-{tag}"))
    clip = add(Segment(observation_id=obs.id, sequence_order=0, text="clip",
                       start_time=0.0, end_time=1.0))
    for s in (segs[0], segs[1], dseg, clip):
        add(CodeApplication(segment_id=s.id, code_id=code.id, user_id=1))
    ex = add(Excerpt(project_id=p.id, segment_id=segs[1].id))
    add(Note(conversation_id=conv.id, segment_id=segs[1].id, excerpt_id=ex.id,
             content="n", sequence_number=1))
    add(Note(document_id=doc.id, segment_id=dseg.id, content="dn", sequence_number=1))
    add(Note(observation_id=obs.id, segment_id=clip.id, content="on", sequence_number=1))
    add(ConsensusStaleTarget(project_id=p.id, segment_id=segs[0].id))

    ds = add(Dataset(project_id=p.id, name=f"ds-{tag}"))
    eg = add(EquivalenceGroup(project_id=p.id, label=f"EG-{tag}"))
    col = add(DatasetColumn(dataset_id=ds.id, column_code="Q1", column_name="Q1",
                            column_text="Q1", column_type=ColumnType.OPEN_TEXT,
                            sequence_order=0, display_order=0, equivalence_group_id=eg.id))
    add(RecodeDefinition(column_id=col.id, name="r", recode_type="scale_map",
                         output_type="numeric", mapping="{}"))
    row = add(DatasetRow(dataset_id=ds.id, participant_id=part.id))
    val = add(DatasetValue(row_id=row.id, column_id=col.id, value_text="hello"))
    add(CodeApplication(dataset_value_id=val.id, code_id=code.id, user_id=1))
    add(Excerpt(project_id=p.id, dataset_value_id=val.id))
    add(Note(dataset_value_id=val.id, content="vn", sequence_number=1))
    metric = add(MetricDefinition(project_id=p.id, name="m", metric_type="frequency_distribution",
                                  config="{}", input_source_type="dataset_column",
                                  input_source_id=col.id, sequence_order=0))
    add(ComputedResult(metric_definition_id=metric.id, result_data="{}", valid_n=1, total_n=1))
    add(RowScore(metric_definition_id=metric.id, dataset_row_id=row.id))
    add(StatisticalTest(project_id=p.id, test_type="chi_square", config="{}",
                        target_type="metric_definition", target_id=metric.id))
    # A numeric member, so the overwrite import's scale-score backfill can compute.
    score_col = add(DatasetColumn(dataset_id=ds.id, column_code="Q2", column_name="Q2",
                                  column_text="Q2", column_type=ColumnType.NUMERIC,
                                  sequence_order=1, display_order=1))
    add(DatasetValue(row_id=row.id, column_id=score_col.id, value_text="3", value_numeric=3.0))
    dom = add(AnalysisDomain(project_id=p.id, name=f"D-{tag}"))
    add(AnalysisDomainMember(domain_id=dom.id, member_type="column", member_id=score_col.id))

    add(Memo(project_id=p.id, numeric_id=1, entity_type="conversation",
             entity_id=conv.id, content="m"))
    add(ScratchpadEntry(project_id=p.id, numeric_id=1, content="s"))
    add(QuoteBoardConfig(project_id=p.id))
    add(TextCodingConfig(project_id=p.id))
    canvas = add(Canvas(project_id=p.id, name=f"Canvas-{tag}"))
    t1 = add(CanvasTheme(canvas_id=canvas.id, name="T1"))
    t2 = add(CanvasTheme(canvas_id=canvas.id, name="T2", parent_theme_id=t1.id))
    add(CanvasThemeRelationship(canvas_id=canvas.id, source_theme_id=t1.id,
                                target_theme_id=t2.id, relationship_type="supports"))
    add(CanvasPendingItem(canvas_id=canvas.id, item_type="excerpt", source_id=ex.id))
    add(CanvasSnapshot(canvas_id=canvas.id, name="snap", snapshot_data="{}"))
    coll = add(MaterialCollection(project_id=p.id, name=f"MC-{tag}"))
    add(Material(collection_id=coll.id, material_type="chart", config="{}", auto_name="a"))
    return {"project": p.id, "conversation": conv.id, "document": doc.id,
            "observation": obs.id, "metric": metric.id}


def _counts(db) -> dict[str, int]:
    return {t.name: db.execute(text(f'SELECT count(*) FROM "{t.name}"')).scalar()
            for t in Base.metadata.sorted_tables}


def _fk_clean(db) -> bool:
    return db.execute(text("PRAGMA foreign_key_check")).fetchall() == []


class _Statements:
    """Every statement the engine runs while active, as (verb, first table)."""

    def __init__(self, db):
        self.engine = db.get_bind()
        self.seen: list[tuple[str, str]] = []

    def _spy(self, conn, cursor, statement, *_):
        words = statement.split()
        verb = words[0].upper()
        if verb == "DELETE":
            table = words[2]
        elif "FROM" in words:
            table = words[words.index("FROM") + 1]
        else:
            table = ""
        self.seen.append((verb, table.strip('"')))

    def __enter__(self):
        event.listen(self.engine, "before_cursor_execute", self._spy)
        return self

    def __exit__(self, *exc):
        event.remove(self.engine, "before_cursor_execute", self._spy)


# What `delete_project_tree` runs, in order (G2b says why it is pinned).
LEAF_FIRST = [
    "code_applications", "row_scores", "dataset_values", "dataset_rows",
    "segments", "segments", "segments", "projects",
]


# ── G2: census ─────────────────────────────────────────────────────────────


class TestCensus:
    def test_the_target_goes_the_control_stays_and_no_child_is_loaded(self, db_session):
        db = db_session
        reachable = _reachable_tables()
        assert len(reachable) >= 40, "population: 40 reachable tables on 2026-10-13"
        _seed_project(db, "control")
        control_only = _counts(db)
        target = _seed_project(db, "target")
        both = _counts(db)
        unseeded = sorted(t for t in reachable if both[t] == control_only[t])
        assert not unseeded, (
            f"_seed_project writes no row to {unseeded} — a table reachable from "
            "projects must be seeded here, or this census cannot see it deleted"
        )
        db.commit()
        db.expunge_all()

        with _Statements(db) as spy:
            _run(delete_project(target["project"], user=db.get(User, 1), db=db))

        after = _counts(db)
        expected = dict(control_only, audit_entries=control_only["audit_entries"] + 1)
        assert after == expected
        assert _fk_clean(db)
        loaded = sorted({t for verb, t in spy.seen if verb == "SELECT"} & (reachable - {"projects"}))
        assert not loaded, f"the delete SELECTed child tables {loaded} — a loading cascade is back"
        # The tree, then the project's own audit entries (#1230 — the id may be reused).
        assert [t for verb, t in spy.seen if verb == "DELETE"] == LEAF_FIRST + ["audit_entries"], (
            "the endpoint must delete through services/project_deletion.py, then forget "
            "the project's audit entries"
        )


# ── G2b: the order ─────────────────────────────────────────────────────────


class TestOrder:
    def test_the_data_scaled_tables_go_leaf_first_then_the_project(self, db_session):
        """Not a correctness property — the cascade deletes the same rows in any order.

        Measured 2026-10-13: these statements before the project row took a BES
        delete from 25.5 s (the cascade alone) to 11.1 s, and 71.8 → 18.0 s under
        SQLCipher. Removing one keeps every other test green.
        """
        db = db_session
        target = _seed_project(db, "only")
        db.commit()
        project = db.get(Project, target["project"])
        with _Statements(db) as spy:
            delete_project_tree(db, project)
        assert [t for verb, t in spy.seen if verb == "DELETE"] == LEAF_FIRST

    def test_a_collection_the_caller_loaded_is_not_deleted_twice(self, db_session):
        """The overwrite import's safety export may load the project's collections.

        A loaded collection is still walked by the ORM's cascade, which would DELETE
        rows the statements already removed — SQLAlchemy warns "expected to delete 1
        row(s); 0 were matched". `delete_project_tree` expires them first.
        """
        db = db_session
        target = _seed_project(db, "only")
        db.commit()
        project = db.get(Project, target["project"])
        for conv in project.conversations:
            assert conv.segments  # loaded, and holding rows the statements delete
        with warnings.catch_warnings():
            warnings.simplefilter("error", SAWarning)
            delete_project_tree(db, project)
            db.commit()
        assert db.execute(text("SELECT count(*) FROM segments")).scalar() == 0

    def test_a_pending_row_under_the_project_lands_before_the_statements(self, db_session):
        """Flushed first, a pending child is then deleted with its parent; inserted
        after the statements it would point at a deleted segment and fail its FK."""
        db = db_session
        target = _seed_project(db, "only")
        db.commit()
        project = db.get(Project, target["project"])
        seg = db.query(Segment).filter(Segment.document_id == target["document"]).one()
        code = db.query(Code).filter(Code.project_id == project.id).one()
        db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=None))
        delete_project_tree(db, project)
        db.commit()
        assert db.execute(text("SELECT count(*) FROM code_applications")).scalar() == 0
        assert _fk_clean(db)


# ── G3: the endpoint, over HTTP ────────────────────────────────────────────


class TestTheEndpoint:
    @pytest.fixture()
    def client(self):
        from starlette.testclient import TestClient
        from app.database import engine
        from app.main import app
        Base.metadata.create_all(bind=engine)
        try:
            with TestClient(app, raise_server_exceptions=False) as c:
                yield c
        finally:
            Base.metadata.drop_all(bind=engine)

    def test_a_delete_removes_the_project_its_folders_and_writes_the_audit_entry(self, client):
        from app.config import get_documents_dir, get_media_dir
        from app.database import SessionLocal
        from app.models.audit import AuditEntry

        headers = {"X-CSRF-Token": client.get("/api/auth/status").json()["user"]["csrf_token"]}
        resp = client.post("/api/projects", json={"name": "Going"}, headers=headers)
        assert resp.status_code in (200, 201), resp.text
        pid = resp.json()["id"]
        db = SessionLocal()
        try:
            conv = Conversation(project_id=pid, name="c")
            code = Code(project_id=pid, name="k", numeric_id=1)
            db.add_all([conv, code])
            db.flush()
            seg = Segment(conversation_id=conv.id, sequence_order=0, text="t")
            db.add(seg)
            db.flush()
            db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=None))
            db.commit()
        finally:
            db.close()
        docs, media = get_documents_dir() / str(pid), get_media_dir() / str(pid) / "1"
        for folder in (docs, media):
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "f.bin").write_bytes(b"x")

        resp = client.delete(f"/api/projects/{pid}", headers=headers)

        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "ok", "deleted_id": pid}
        assert client.get(f"/api/projects/{pid}").status_code == 404
        assert not docs.exists() and not (get_media_dir() / str(pid)).exists()
        db = SessionLocal()
        try:
            assert db.execute(text("SELECT count(*) FROM code_applications")).scalar() == 0
            assert db.execute(text("SELECT count(*) FROM segments")).scalar() == 0
            entry = db.query(AuditEntry).filter(
                AuditEntry.action == "deleted", AuditEntry.entity_type == "project",
                AuditEntry.entity_id == pid,
            ).one()
            assert '"Going"' in entry.details
        finally:
            db.close()


# ── G4: the overwrite import ───────────────────────────────────────────────


class TestOverwriteImport:
    def test_an_overwrite_deletes_through_the_same_path_without_a_warning(
        self, db_session, tmp_path, monkeypatch,
    ):
        db = db_session
        monkeypatch.setattr(
            "app.services.project_portability.get_backup_dir", lambda: tmp_path / "backups"
        )
        docs = tmp_path / "docs"
        _seed_project(db, "control")
        control_only = _counts(db)
        target = _seed_project(db, "target")
        db.commit()
        archive = tmp_path / "t.mmproject"
        archive.write_bytes(export_project(db, target["project"], docs).getvalue())
        old_uuid = db.get(Project, target["project"]).project_uuid
        calls = []
        real = delete_project_tree

        def _spy(db_, project):
            calls.append(project.id)
            return real(db_, project)

        monkeypatch.setattr("app.services.project_portability.delete_project_tree", _spy)
        with warnings.catch_warnings():
            warnings.simplefilter("error", SAWarning)
            new_id, _ = import_project(
                db, archive, docs, media_dir=None, user_id=1,
                import_mode="overwrite", target_project_id=target["project"],
            )
            db.commit()

        assert calls == [target["project"]]
        assert db.query(Project).filter(Project.project_uuid == old_uuid).one().id == new_id
        assert _fk_clean(db)
        control = db.query(Project).filter(Project.name == "P-control").one()
        assert db.query(Conversation).filter(Conversation.project_id == control.id).count() == 1
        assert db.query(CodeApplication).join(Code).filter(Code.project_id == control.id).count() == 5


# ── G5: the second layer's own doors ───────────────────────────────────────


def _project_rows(db, pid: int) -> dict[str, int]:
    q = lambda sql: db.execute(text(sql), {"p": pid}).scalar()
    return {
        "segments": q(
            "SELECT count(*) FROM segments s LEFT JOIN conversations c ON c.id = s.conversation_id "
            "LEFT JOIN documents d ON d.id = s.document_id LEFT JOIN observations o ON o.id = s.observation_id "
            "WHERE :p IN (c.project_id, d.project_id, o.project_id)"),
        "code_applications": q(
            "SELECT count(*) FROM code_applications a JOIN codes k ON k.id = a.code_id WHERE k.project_id = :p"),
        "notes": q(
            "SELECT count(*) FROM notes n LEFT JOIN conversations c ON c.id = n.conversation_id "
            "LEFT JOIN documents d ON d.id = n.document_id LEFT JOIN observations o ON o.id = n.observation_id "
            "LEFT JOIN dataset_values v ON v.id = n.dataset_value_id LEFT JOIN dataset_rows r ON r.id = v.row_id "
            "LEFT JOIN datasets ds ON ds.id = r.dataset_id "
            "WHERE :p IN (c.project_id, d.project_id, o.project_id, ds.project_id)"),
        "excerpts": q("SELECT count(*) FROM excerpt WHERE project_id = :p"),
        "row_scores": q(
            "SELECT count(*) FROM row_scores r JOIN metric_definitions m ON m.id = r.metric_definition_id "
            "WHERE m.project_id = :p"),
        "computed_results": q(
            "SELECT count(*) FROM computed_results r JOIN metric_definitions m ON m.id = r.metric_definition_id "
            "WHERE m.project_id = :p"),
    }


class TestSourceDeletes:
    @pytest.fixture()
    def two(self, db_session):
        db = db_session
        a = _seed_project(db, "a")
        b = _seed_project(db, "b")
        db.commit()
        db.expunge_all()
        return db, a, b, _project_rows(db, b["project"])

    def test_a_conversation(self, two):
        db, a, b, control = two
        before = _project_rows(db, a["project"])
        _run(delete_conversation(a["project"], a["conversation"], user=db.get(User, 1), db=db))
        after = _project_rows(db, a["project"])
        assert after["segments"] == before["segments"] - 4
        assert after["code_applications"] == before["code_applications"] - 2
        assert after["notes"] == before["notes"] - 1
        assert after["excerpts"] == before["excerpts"] - 1
        assert db.query(Speaker).filter(Speaker.project_id == a["project"]).count() == 1, \
            "a speaker survives its conversation by design"
        assert _project_rows(db, b["project"]) == control
        assert _fk_clean(db)

    def test_a_document(self, two):
        db, a, b, control = two
        before = _project_rows(db, a["project"])
        _run(delete_document(a["project"], a["document"], user=db.get(User, 1), db=db))
        after = _project_rows(db, a["project"])
        assert after["segments"] == before["segments"] - 1
        assert after["code_applications"] == before["code_applications"] - 1
        assert after["notes"] == before["notes"] - 1
        assert db.query(Participant).filter(Participant.project_id == a["project"]).count() == 1
        assert _project_rows(db, b["project"]) == control
        assert _fk_clean(db)

    def test_an_observation(self, two):
        db, a, b, control = two
        before = _project_rows(db, a["project"])
        _run(delete_observation(a["project"], a["observation"], user=db.get(User, 1), db=db))
        after = _project_rows(db, a["project"])
        assert after["segments"] == before["segments"] - 1
        assert after["code_applications"] == before["code_applications"] - 1
        assert after["notes"] == before["notes"] - 1
        assert _project_rows(db, b["project"]) == control
        assert _fk_clean(db)

    def test_a_metric(self, two):
        db, a, b, control = two
        _run(delete_metric(a["project"], a["metric"], user=db.get(User, 1), db=db))
        after = _project_rows(db, a["project"])
        assert after["row_scores"] == 0 and after["computed_results"] == 0
        assert _project_rows(db, b["project"]) == control
        assert _fk_clean(db)


class TestTheCostDoesNotGrowWithTheData:
    @pytest.mark.parametrize("turns", [5, 60])
    def test_a_conversation_delete_runs_a_fixed_number_of_statements(self, db_session, turns):
        """2026-10-13: 5,023 SELECTs for a 1,000-turn conversation before #1035; one after.

        #1546 (D157, 2026-11-08) adds the two reads of the AUDIT trail that decide which
        edit wording leaves with the conversation — the hand edits, and the merges and
        splits — and, with nothing found there, no read of its turns at all. Still the
        same statements at 5 turns and at 60.
        """
        db = db_session
        p = Project(name="P", user_id=1)
        db.add(p)
        db.flush()
        code = Code(project_id=p.id, name="k", numeric_id=1)
        conv = Conversation(project_id=p.id, name="c")
        db.add_all([code, conv])
        db.flush()
        for i in range(turns):
            seg = Segment(conversation_id=conv.id, sequence_order=i, text=f"t{i}")
            db.add(seg)
            db.flush()
            db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=1))
            db.add(Excerpt(project_id=p.id, segment_id=seg.id))
        db.commit()
        pid, cid = p.id, conv.id
        db.expunge_all()
        user = db.get(User, 1)
        with _Statements(db) as spy:
            _run(delete_conversation(pid, cid, user=user, db=db))
        selects = [t for verb, t in spy.seen if verb == "SELECT"]
        assert selects == ["projects", "conversations", "audit_entries", "audit_entries"], selects
        assert db.execute(text("SELECT count(*) FROM segments")).scalar() == 0
