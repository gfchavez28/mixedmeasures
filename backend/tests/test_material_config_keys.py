"""#1068 / #1086 — a saved chart's settings name rows, and the import must follow them.

Two halves:

1. **The key space is PINNED.** Every key the two chart savers write must be
   classified in `services/material_config.py` — an id of a known kind, the
   writer-dependent axis order, a tagged id, or a key that names no row. A NEW
   setting fails here until someone decides which it is, which is how
   `coder_ids`, `observation_ids`, `compare_by` and `content_source` reached the
   file for months with nothing remapping them.
2. **Each kind is followed through a real `.mmproject` round trip**, entered at
   `import_project` (#747's rule) and imported twice so the second import's ids
   differ from the source's — on a fresh database the ids coincide and a
   missing remap passes.
"""
import json
import re
from pathlib import Path

import pytest

from app.models.analysis_domain import AnalysisDomain
from app.models.canvas import Canvas, CanvasTheme
from app.models.code import Code
from app.models.code_application import CodeApplication
from app.models.code_category import CodeCategory
from app.models.conversation import Conversation
from app.models.dataset import ColumnType, Dataset, DatasetColumn
from app.models.materials import Material, MaterialCollection
from app.models.metric import MetricDefinition
from app.models.observation import Observation
from app.models.project import Project
from app.models.segment import Segment
from app.models.user import User
from app.services import material_config
from app.services.project_portability import export_project, import_project

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src"


# ── 1. The key space ────────────────────────────────────────────────────────


def _block(source: str, start: str, end: str) -> str:
    i = source.index(start)
    return source[i:source.index(end, i)]


def _quantitative_keys() -> set[str]:
    src = (FRONTEND / "pages" / "AnalysisView.tsx").read_text()
    literal = _block(src, "const buildCurrentChartConfig = useCallback(() => ({", "}), [")
    keys = set(re.findall(r"^ {4}(\w+):", literal, re.M))
    # `handleAddToMaterials` renames two keys on the way to the server.
    saved = _block(src, "const materialConfig: Record<string, unknown> = {", "}")
    renamed = set(re.findall(r"^ {6}(\w+):", saved, re.M))
    return keys | renamed


def _qualitative_keys() -> set[str]:
    src = (FRONTEND / "hooks" / "useQualitativeAnalysis.ts").read_text()
    body = _block(src, "const buildCurrentConfig = useCallback(", "}, [")
    literal = _block(body, "const config: Record<string, unknown> = {", "}")
    return set(re.findall(r"^ {6}(\w+):", literal, re.M)) | set(re.findall(r"config\.(\w+) =", body))


def _classified(key: str) -> bool:
    return (
        key in material_config.ID_KEYS
        or key == material_config.ORDER_KEY
        or key in material_config.TAGGED_KEYS
        or key in material_config.PLAIN_KEYS
    )


class TestTheKeySpaceIsPinned:
    def test_the_scan_sees_both_savers(self):
        # Population floors: a scan that resolves to nothing passes every
        # "is it classified" assertion (#729's rule).
        assert len(_quantitative_keys()) >= 45
        assert len(_qualitative_keys()) >= 30
        # Sentinels: one id key from each saver, read from the real source.
        assert {"compare_by", "column_ids"} <= _quantitative_keys()
        assert {"coder_ids", "content_source"} <= _qualitative_keys()

    @pytest.mark.parametrize("saver", ["quantitative", "qualitative"])
    def test_every_key_a_saver_writes_is_classified(self, saver):
        keys = _quantitative_keys() if saver == "quantitative" else _qualitative_keys()
        unclassified = sorted(k for k in keys if not _classified(k))
        assert not unclassified, (
            f"{saver} chart settings write {unclassified}, which "
            "services/material_config.py does not classify. Decide: does the key "
            "name a row (ID_KEYS / ORDER_KEY / TAGGED_KEYS — the .mmproject import "
            "must remap it) or not (PLAIN_KEYS)?"
        )

    def test_the_classifier_can_fail(self):
        assert not _classified("a_setting_nobody_classified")

    def test_no_key_is_in_two_classes(self):
        ids = set(material_config.ID_KEYS) | {material_config.ORDER_KEY} | set(material_config.TAGGED_KEYS)
        assert not ids & material_config.PLAIN_KEYS

    def test_the_qualitative_discriminator_is_the_clients(self):
        src = (FRONTEND / "lib" / "material-kind.ts").read_text()
        match = re.search(r"QUALITATIVE_CONFIG_KEYS = \[([^\]]*)\]", src)
        assert match, "lib/material-kind.ts no longer declares QUALITATIVE_CONFIG_KEYS"
        client = tuple(re.findall(r"'(\w+)'", match.group(1)))
        assert client == material_config.QUALITATIVE_CONFIG_KEYS


# ── 2. The import follows every kind ────────────────────────────────────────


def _roundtrip(db, tmp_path, pid):
    """Export project `pid` and import it TWICE; return the second import's id."""
    docs = tmp_path / "docs"
    docs.mkdir(exist_ok=True)
    archive = tmp_path / "x.mmproject"
    archive.write_bytes(export_project(db, pid, docs).getvalue())
    import_project(db, archive, tmp_path / "i1", media_dir=None, user_id=1, import_mode="new")
    db.flush()
    new_pid, _ = import_project(db, archive, tmp_path / "i2", media_dir=None, user_id=1,
                                import_mode="new")
    db.flush()
    return new_pid


def _material_config(db, pid) -> dict:
    mat = (db.query(Material).join(MaterialCollection)
           .filter(MaterialCollection.project_id == pid).one())
    return json.loads(mat.config)


def _one(db, model, pid, **filters):
    q = db.query(model).filter(model.project_id == pid)
    for k, v in filters.items():
        q = q.filter(getattr(model, k) == v)
    return q.one()


def _dataset_column(db, pid, text):
    return (db.query(DatasetColumn).join(Dataset)
            .filter(Dataset.project_id == pid, DatasetColumn.column_text == text).one())


@pytest.fixture
def source(db_session):
    """A project holding one of every kind a chart can name."""
    db = db_session
    db.add(Project(id=7001, name="Src", user_id=1))
    db.add(User(id=701, username="Bob", password_hash="x"))
    db.flush()
    conv = Conversation(project_id=7001, name="C1")
    obs = Observation(project_id=7001, name="O1")
    cat = CodeCategory(project_id=7001, name="Cat")
    db.add_all([conv, obs, cat])
    db.flush()
    code = Code(project_id=7001, numeric_id=1, name="K", category_id=cat.id)
    db.add(code)
    ds = Dataset(project_id=7001, name="S")
    db.add(ds)
    db.flush()
    q1 = DatasetColumn(dataset_id=ds.id, column_text="q1", column_type=ColumnType.NUMERIC,
                       sequence_order=0, display_order=0)
    g = DatasetColumn(dataset_id=ds.id, column_text="g", column_type=ColumnType.NOMINAL,
                      sequence_order=1, display_order=1)
    db.add_all([q1, g])
    dom = AnalysisDomain(project_id=7001, name="D")
    db.add(dom)
    db.flush()
    m1 = MetricDefinition(project_id=7001, name="m1", metric_type="mean", config="{}",
                          input_source_type="dataset_column", input_source_id=q1.id)
    m2 = MetricDefinition(project_id=7001, name="m2", metric_type="mean", config="{}",
                          input_source_type="dataset_column", input_source_id=g.id)
    db.add_all([m1, m2])
    seg = Segment(conversation_id=conv.id, sequence_order=1, text="a")
    db.add(seg)
    db.flush()
    db.add(CodeApplication(segment_id=seg.id, code_id=code.id, user_id=701))  # Bob coded
    coll = MaterialCollection(project_id=7001, name="M")
    db.add(coll)
    db.flush()
    return {"db": db, "coll": coll, "conv": conv, "obs": obs, "cat": cat, "code": code,
            "q1": q1, "g": g, "dom": dom, "m1": m1, "m2": m2}


def _save(s, config: dict):
    s["db"].add(Material(collection_id=s["coll"].id, material_type="chart", auto_name="x",
                         source_tab="descriptives", config=json.dumps(config)))
    s["db"].commit()


class TestTheImportFollowsEveryKind:
    def test_a_qualitative_charts_ids(self, source, tmp_path):
        s = source
        _save(s, {
            "tab": "descriptives", "code_mode": "codes", "code_ids": [s["code"].id],
            "conversation_ids": [s["conv"].id], "observation_ids": [s["obs"].id],
            "coder_ids": [701], "content_source": f"c:{s['conv'].id}",
            "custom_order": [s["code"].id],
        })
        db = s["db"]
        pid = _roundtrip(db, tmp_path, 7001)
        cfg = _material_config(db, pid)
        new_code = _one(db, Code, pid).id
        new_conv = _one(db, Conversation, pid).id
        assert cfg["code_ids"] == [new_code]
        assert cfg["conversation_ids"] == [new_conv]
        assert cfg["observation_ids"] == [_one(db, Observation, pid).id]
        # Bob is matched by name onto the same install's Bob.
        assert cfg["coder_ids"] == [701]
        assert cfg["content_source"] == f"c:{new_conv}"
        assert cfg["custom_order"] == [new_code]

    def test_an_order_over_CATEGORIES_follows_the_categories(self, source, tmp_path):
        s = source
        db = s["db"]
        # A SECOND category, so the ordered one's id differs from the code's — with
        # both at id 1 the codes table and the categories table remap alike and the
        # test cannot tell them apart (a mutant that sent this order through
        # `codes` survived the first version of this fixture).
        ordered = CodeCategory(project_id=7001, name="Ordered")
        db.add(ordered)
        db.flush()
        assert ordered.id != s["code"].id
        _save(s, {"tab": "descriptives", "code_mode": "categories", "code_ids": [s["code"].id],
                  "custom_order": [ordered.id]})
        pid = _roundtrip(db, tmp_path, 7001)
        assert _material_config(db, pid)["custom_order"] == [_one(db, CodeCategory, pid, name="Ordered").id]

    def test_a_quantitative_charts_ids(self, source, tmp_path):
        s = source
        _save(s, {
            "column_ids": [s["q1"].id], "domain_ids": [s["dom"].id],
            "compare_by": s["g"].id, "compare_by_2": s["g"].id,
            "custom_order": [s["m2"].id, s["m1"].id],
        })
        db = s["db"]
        pid = _roundtrip(db, tmp_path, 7001)
        cfg = _material_config(db, pid)
        q1 = _dataset_column(db, pid, "q1").id
        g = _dataset_column(db, pid, "g").id
        metrics = {m.name: m.id for m in db.query(MetricDefinition).filter(MetricDefinition.project_id == pid)}
        assert cfg["column_ids"] == [q1]
        assert cfg["domain_ids"] == [_one(db, AnalysisDomain, pid).id]
        assert cfg["compare_by"] == g and cfg["compare_by_2"] == g
        # METRIC ids, not codes — the old map rewrote a metric id colliding with
        # a code id into that code's new id.
        assert cfg["custom_order"] == [metrics["m2"], metrics["m1"]]

    def test_a_coder_filter_follows_the_coder_to_their_new_id(self, source, tmp_path):
        """The audit's case: on the destination install the source's coder id
        belongs to SOMEONE ELSE, so a kept id would filter to the wrong person."""
        s = source
        db = s["db"]
        _save(s, {"tab": "descriptives", "code_mode": "codes", "code_ids": [s["code"].id],
                  "coder_ids": [701]})
        docs = tmp_path / "docs"
        docs.mkdir()
        archive = tmp_path / "x.mmproject"
        archive.write_bytes(export_project(db, 7001, docs).getvalue())
        db.get(User, 701).username = "Alice"  # the destination's id 701 is Alice
        db.flush()
        pid, _ = import_project(db, archive, tmp_path / "i", media_dir=None, user_id=1,
                                import_mode="new")
        db.flush()
        bob = db.query(User).filter(User.username == "Bob").one()
        assert bob.id != 701
        assert _material_config(db, pid)["coder_ids"] == [bob.id]

    def test_a_coder_the_file_does_not_carry_is_dropped_never_kept(self, source, tmp_path):
        """🔴 A coder id is install-global: kept unresolved, it names whoever holds
        that id HERE. The file's roster is every coder with a coding, so an
        unresolved one is a coder with none — dropping it changes nothing the
        chart shows while another listed coder resolves."""
        s = source
        db = s["db"]
        db.add(User(id=702, username="Carol", password_hash="x"))  # no coding in 7001
        db.flush()
        _save(s, {"tab": "descriptives", "code_mode": "codes", "code_ids": [s["code"].id],
                  "coder_ids": [701, 702]})
        docs = tmp_path / "docs"
        docs.mkdir()
        archive = tmp_path / "x.mmproject"
        archive.write_bytes(export_project(db, 7001, docs).getvalue())
        # The destination install: Carol's id now belongs to someone else.
        db.get(User, 702).username = "Someone else"
        db.flush()
        pid, _ = import_project(db, archive, tmp_path / "i", media_dir=None, user_id=1,
                                import_mode="new")
        db.flush()
        assert _material_config(db, pid)["coder_ids"] == [701]

    def test_a_canvas_chart_embeds_OWN_copy_and_an_excerpt_embeds_link(self, source, tmp_path):
        """The embed renders from the settings copied onto its node, not from the
        material — remapping `materialId` alone left the copy on the source's ids."""
        s = source
        db = s["db"]
        cfg = {"tab": "descriptives", "code_mode": "codes", "code_ids": [s["code"].id],
               "conversation_ids": [s["conv"].id]}
        mat = Material(collection_id=s["coll"].id, material_type="chart", auto_name="x",
                       source_tab="descriptives", config=json.dumps(cfg))
        db.add(mat)
        canvas = Canvas(project_id=7001, name="Cv")
        db.add(canvas)
        db.flush()
        doc = {"type": "doc", "content": [
            {"type": "chart-embed", "attrs": {"materialId": mat.id, "config": json.dumps(cfg)}},
            {"type": "chart-embed", "attrs": {"materialId": mat.id, "config": cfg}},
            {"type": "excerpt-embed", "attrs": {"excerptId": None, "conversationId": s["conv"].id,
                                                "observationId": s["obs"].id}},
        ]}
        db.add(CanvasTheme(canvas_id=canvas.id, name="T", content=json.dumps(doc)))
        db.commit()

        pid = _roundtrip(db, tmp_path, 7001)
        theme = db.query(CanvasTheme).join(Canvas).filter(Canvas.project_id == pid).one()
        nodes = json.loads(theme.content)["content"]
        new_code, new_conv = _one(db, Code, pid).id, _one(db, Conversation, pid).id
        as_string = json.loads(nodes[0]["attrs"]["config"])
        assert as_string["code_ids"] == [new_code]
        assert as_string["conversation_ids"] == [new_conv]
        assert nodes[1]["attrs"]["config"]["code_ids"] == [new_code]
        assert nodes[2]["attrs"]["conversationId"] == new_conv
        assert nodes[2]["attrs"]["observationId"] == _one(db, Observation, pid).id


class TestTheBrokenReferenceCheckReadsTheSameKeys:
    def test_a_comparison_whose_grouping_variable_was_deleted_is_flagged(self, source):
        """#1086: the check looked for `compareBy`, a URL parameter name."""
        from app.routers.materials import _build_existence_sets, _collect_material_refs

        s = source
        db = s["db"]
        cfg = {"column_ids": [s["q1"].id], "rc_view": "comparisons", "compare_by": s["g"].id}
        mat = Material(collection_id=s["coll"].id, material_type="comparison_table",
                       auto_name="x", source_tab="comparisons", config=json.dumps(cfg))
        db.add(mat)
        db.flush()
        assert s["g"].id in _collect_material_refs(cfg)["column"]
        db.delete(s["g"])
        db.flush()
        existing = _build_existence_sets(db, 7001, [mat])
        assert s["g"].id not in existing["column"]
        assert s["q1"].id in existing["column"]
