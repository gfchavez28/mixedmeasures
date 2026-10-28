"""#1315 — the Relationships & Comparisons keys a saved chart carries, and the repair.

`AnalysisView::buildCurrentChartConfig` wrote every R&C key on every tab, and a tab
switch keeps the R&C URL state, so a Descriptives chart carried them: refused on the
canvas (`rc_view: 'correlations'`), drawn as a group comparison (`rc_view:
'comparisons'` + `compare_by`), or — saved before v1.4.0 after a Spearman or scatter
toggle — refused by #831's legacy tells. The saver is fixed on the client; this is
the repair of what is already stored, `services/material_config.py::normalise_rc_keys`,
which must reach THREE stores (the material row, every canvas embed's own copy, every
canvas snapshot) because an embed renders from its copy.

Entered where the product enters it (`backend/tests/the internal design notes, #747's rule):
`run_data_repairs` — the one list the lifespan and a restore both call — and
`import_project`, because a v1.4.0–1.5.7 file carries the leak. The service is also
entered directly, so the rule can be checked before the startup wiring exists.
"""
import json
import re
from pathlib import Path

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.canvas import Canvas, CanvasSnapshot, CanvasTheme
from app.models.dataset import ColumnType, Dataset, DatasetColumn
from app.models.materials import Material, MaterialCollection
from app.models.project import Project
from app.services import material_config
from app.services.material_config import (
    COMPARISONS_TAB, CORRELATIONS_TAB, DESCRIPTIVES_TAB, DISAGREE,
    RcRepairScope, normalise_rc_keys, normalised_rc_config, rc_keys_need_repair, rc_row_tab,
)
from app.services.project_portability import export_project, import_project

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src"

SIG = {"show_05": True, "show_01": True, "show_001": True}
#: The four keys the pre-#1315 saver wrote UNCONDITIONALLY — on every quantitative
#: save, Descriptives included.
UNCONDITIONAL = {"sig_levels": SIG, "nonparametric": False, "post_hoc_expanded": True,
                 "show_reg_line": True}


def _descriptive(q1: int) -> dict:
    """What a Descriptives save holds besides its R&C keys — what must SURVIVE."""
    return {"title": "Trust by item", "sort": "none", "display": "percentage",
            "metric_type": "frequency_distribution", "chart_type": "horizontal_bar",
            "column_ids": [q1], "domain_ids": []}


def _shapes(q1: int, g: int) -> dict[str, tuple[str, str, dict, dict]]:
    """name → (source_tab, material_type, stored config, config after the repair)."""
    desc = _descriptive(q1)
    corr = {"column_ids": [q1, g], "domain_ids": [], "metric_type": "frequency_distribution"}
    cmp_ = {"column_ids": [q1], "domain_ids": [], "rc_view": "comparisons", "compare_by": g,
            "sig_levels": SIG, "nonparametric": False, "post_hoc_expanded": True}
    shapes = {
        # 1. Leaked from Correlations — refused on the canvas.
        "desc_corr": (DESCRIPTIVES_TAB, "horizontal_bar",
                      {**desc, "rc_view": "correlations", **UNCONDITIONAL}, desc),
        # 2. Leaked from Comparisons — DRAWN as a group comparison; `compare_by` also
        #    made the broken-reference check flag it when `g` was deleted.
        "desc_cmp": (DESCRIPTIVES_TAB, "horizontal_bar",
                     {**desc, "rc_view": "comparisons", "compare_by": g, **UNCONDITIONAL}, desc),
        # 3. Pre-v1.4.0: no `rc_view` (it was omitted for the default), but the
        #    Spearman and scatter toggles left #831's two legacy tells.
        "desc_legacy": (DESCRIPTIVES_TAB, "heatmap",
                        {**desc, "corr_type": "spearman", "show_scatter": True, **UNCONDITIONAL}, desc),
        # Positive controls: a genuine comparison and a genuine correlation.
        "cmp": (COMPARISONS_TAB, "comparison_table", cmp_, cmp_),
        "corr": (CORRELATIONS_TAB, "correlation_matrix",
                 {**corr, "rc_view": "correlations", **UNCONDITIONAL},
                 {**corr, "rc_view": "correlations", **UNCONDITIONAL}),
        # Legacy default-Pearson correlation: NO marker of any kind — #831's
        # accepted residual, closed by stamping `rc_view` from the row.
        "legacy_pearson": (CORRELATIONS_TAB, "correlation_matrix",
                           {**corr, **UNCONDITIONAL},
                           {**corr, **UNCONDITIONAL, "rc_view": "correlations"}),
        # The two columns disagree: one is wrong and nothing can say which.
        "disagree": (DESCRIPTIVES_TAB, "correlation_matrix",
                     {**desc, "rc_view": "correlations", **UNCONDITIONAL},
                     {**desc, "rc_view": "correlations", **UNCONDITIONAL}),
        # Qualitative: not ours. ⚠️ `sig_levels` is PLANTED — no saver writes it
        # here — so that a repair which read this row as Descriptives would
        # change it and this control could fail.
        "qual": ("qualitative_descriptives", "qual_heatmap",
                 {"tab": "descriptives", "code_mode": "codes", "code_ids": [], "sig_levels": SIG},
                 {"tab": "descriptives", "code_mode": "codes", "code_ids": [], "sig_levels": SIG}),
        # Planted too: a Descriptives row whose config is QUALITATIVE.
        "desc_qual_config": (DESCRIPTIVES_TAB, "horizontal_bar",
                             {"code_mode": "codes", "code_ids": [], "rc_view": "correlations"},
                             {"code_mode": "codes", "code_ids": [], "rc_view": "correlations"}),
    }
    return shapes


ORPHAN_ID = 987_654
#: Ids that name no row anywhere, so the import's id remap keeps them as they are
#: and only the repair could change this config.
ORPHAN_CONFIG = {"column_ids": [555_555], "rc_view": "comparisons", "compare_by": 555_556}
PROSE_BEFORE = {"type": "paragraph", "content": [{"type": "text", "text": "Before — ünïcödé prose."}]}
PROSE_AFTER = {"type": "paragraph", "content": [{"type": "text", "text": "After the charts."}]}


def _embed(material_id: int, title: str, config, **extra) -> dict:
    return {"type": "chart-embed",
            "attrs": {"materialId": material_id, "title": title, "config": config, **extra}}


def _doc(materials: dict[str, int], shapes) -> dict:
    """Prose, one string-config embed per shape, a DICT-config copy of `desc_cmp`
    nested in a blockquote, and an ORPHAN."""
    embeds = [_embed(mid, name, json.dumps(shapes[name][2]), figureHash="abc123")
              for name, mid in materials.items()]
    nested = {"type": "blockquote", "content": [
        _embed(materials["desc_cmp"], "desc_cmp@dict", dict(shapes["desc_cmp"][2]))]}
    orphan = _embed(ORPHAN_ID, "orphan", json.dumps(ORPHAN_CONFIG))
    return {"type": "doc", "content": [PROSE_BEFORE, *embeds, nested, orphan, PROSE_AFTER]}


def _build(db, pid: int) -> dict:
    """A project holding every shape, as a material AND as embeds in a theme, plus
    a snapshot of that theme. Committed, so a second session sees it."""
    db.add(Project(id=pid, name=f"P{pid}", user_id=1))
    db.flush()
    ds = Dataset(project_id=pid, name="S")
    db.add(ds)
    db.flush()
    q1 = DatasetColumn(dataset_id=ds.id, column_text="q1", column_type=ColumnType.NUMERIC,
                       sequence_order=0, display_order=0)
    g = DatasetColumn(dataset_id=ds.id, column_text="g", column_type=ColumnType.NOMINAL,
                      sequence_order=1, display_order=1)
    coll = MaterialCollection(project_id=pid, name="M")
    db.add_all([q1, g, coll])
    db.flush()
    shapes = _shapes(q1.id, g.id)
    materials = {}
    for name, (tab, mtype, cfg, _) in shapes.items():
        m = Material(collection_id=coll.id, material_type=mtype, auto_name=name,
                     source_tab=tab, config=json.dumps(cfg))
        db.add(m)
        db.flush()
        materials[name] = m.id
    canvas = Canvas(project_id=pid, name="Cv")
    db.add(canvas)
    db.flush()
    content = json.dumps(_doc(materials, shapes))
    theme = CanvasTheme(canvas_id=canvas.id, name="T", content=content)
    db.add(theme)
    db.flush()
    snap = CanvasSnapshot(canvas_id=canvas.id, name="S1", theme_count=1, snapshot_data=json.dumps({
        "format_version": 1, "introduction": None,
        "themes": [{"id": theme.id, "name": "T", "content": content}],
        "relationships": [], "pending_items": [],
    }))
    db.add(snap)
    db.commit()
    return {"pid": pid, "q1": q1.id, "g": g.id, "materials": materials,
            "theme": theme.id, "snapshot": snap.id, "canvas": canvas.id}


# ── Reading what is stored ───────────────────────────────────────────────────


def _materials(db, pid) -> dict[str, dict]:
    rows = (db.query(Material).join(MaterialCollection)
            .filter(MaterialCollection.project_id == pid).all())
    return {m.auto_name: json.loads(m.config) for m in rows}


def _embeds(doc: dict) -> dict[str, tuple[object, dict]]:
    """title → (raw config as stored on the node, parsed config)."""
    found = {}

    def walk(node):
        if node.get("type") == "chart-embed":
            raw = node["attrs"]["config"]
            found[node["attrs"]["title"]] = (raw, json.loads(raw) if isinstance(raw, str) else raw)
        for child in node.get("content", []):
            walk(child)
    walk(doc)
    return found


def _theme_doc(db, pid) -> dict:
    theme = db.query(CanvasTheme).join(Canvas).filter(Canvas.project_id == pid).one()
    return json.loads(theme.content)


def _snapshot_doc(db, pid) -> dict:
    snap = db.query(CanvasSnapshot).join(Canvas).filter(Canvas.project_id == pid).one()
    return json.loads(json.loads(snap.snapshot_data)["themes"][0]["content"])


def _columns(db, pid) -> tuple[int, int]:
    cols = {c.column_text: c.id for c in
            db.query(DatasetColumn).join(Dataset).filter(Dataset.project_id == pid)}
    return cols["q1"], cols["g"]


def _assert_repaired(db, pid, *, snapshot: bool) -> None:
    """Every store in project `pid` holds the post-repair shape of every case."""
    q1, g = _columns(db, pid)
    shapes = _shapes(q1, g)
    stored = _materials(db, pid)
    for name, (_, _, _, expected) in shapes.items():
        assert stored[name] == expected, f"material {name}"

    docs = [("theme", _theme_doc(db, pid))]
    if snapshot:
        docs.append(("snapshot", _snapshot_doc(db, pid)))
    for where, doc in docs:
        embeds = _embeds(doc)
        for name, (_, _, _, expected) in shapes.items():
            raw, cfg = embeds[name]
            assert cfg == expected, f"{where} embed {name}"
            assert isinstance(raw, str), f"{where} embed {name} kept its string shape"
        raw, cfg = embeds["desc_cmp@dict"]
        assert isinstance(raw, dict) and cfg == shapes["desc_cmp"][3], f"{where} dict embed"
        assert embeds["orphan"][1] == ORPHAN_CONFIG, f"{where} orphan left as it was"
        # Prose, and every other attr on the node, untouched.
        assert doc["content"][0] == PROSE_BEFORE and doc["content"][-1] == PROSE_AFTER
        node = next(n for n in doc["content"] if n.get("attrs", {}).get("title") == "desc_cmp")
        assert node["attrs"]["figureHash"] == "abc123"


def _assert_untouched(db, built) -> None:
    pid = built["pid"]
    shapes = _shapes(built["q1"], built["g"])
    stored = _materials(db, pid)
    for name, (_, _, original, _) in shapes.items():
        assert stored[name] == original, f"material {name} was changed"
    for name, (_, _, original, _) in shapes.items():
        assert _embeds(_theme_doc(db, pid))[name][1] == original, f"embed {name} was changed"


# ── 1. The rule ──────────────────────────────────────────────────────────────


class TestTheRule:
    @pytest.mark.parametrize("source_tab, material_type, expected", [
        ("descriptives", "horizontal_bar", DESCRIPTIVES_TAB),
        ("descriptives", "cross_tab", DESCRIPTIVES_TAB),
        ("correlations", "correlation_matrix", CORRELATIONS_TAB),
        ("correlations", "scatter_matrix", CORRELATIONS_TAB),
        ("comparisons", "comparison_table", COMPARISONS_TAB),
        ("comparisons", "comparison_qq", COMPARISONS_TAB),
        # Disagreements — each column names a different tab.
        ("descriptives", "correlation_matrix", DISAGREE),
        ("descriptives", "comparison_box", DISAGREE),
        ("correlations", "comparison_table", DISAGREE),
        ("comparisons", "scatter_matrix", DISAGREE),
        ("correlations", "horizontal_bar", DISAGREE),
        ("descriptives", "qual_heatmap", DISAGREE),
        # Not a quantitative chart at all.
        ("qualitative_descriptives", "qual_heatmap", None),
        ("qualitative_comparisons", "qual_comparison_table", None),
        ("something_new", "horizontal_bar", None),
    ])
    def test_a_row_is_trusted_only_when_its_two_columns_agree(self, source_tab, material_type, expected):
        assert rc_row_tab(source_tab, material_type) == expected

    def test_descriptives_loses_every_rc_key_and_nothing_else(self):
        leaked = {"title": "t", "column_ids": [1],
                  **{k: 1 for k in material_config.RC_KEYS}, "metric_type": "mean"}
        assert normalised_rc_config(leaked, DESCRIPTIVES_TAB) == {
            "title": "t", "column_ids": [1], "metric_type": "mean"}

    def test_an_rc_row_without_rc_view_is_stamped_from_its_tab(self):
        assert normalised_rc_config({"column_ids": [1]}, CORRELATIONS_TAB) == {
            "column_ids": [1], "rc_view": "correlations"}
        assert normalised_rc_config({"compare_by": 2}, COMPARISONS_TAB) == {
            "compare_by": 2, "rc_view": "comparisons"}

    def test_nothing_to_change_is_None(self):
        assert normalised_rc_config({"column_ids": [1]}, DESCRIPTIVES_TAB) is None
        assert normalised_rc_config({"rc_view": "correlations"}, CORRELATIONS_TAB) is None


# ── 2. The repair, at each door ──────────────────────────────────────────────


def _via_service(db, built, tmp_path) -> tuple[int, bool]:
    report = normalise_rc_keys(db, scope=RcRepairScope.everything())
    db.flush()
    assert report.changed
    return built["pid"], True


def _via_startup(db, built, tmp_path) -> tuple[int, bool]:
    from app.services.data_repairs import run_data_repairs

    run_data_repairs(lambda: Session(bind=db.get_bind()))
    db.expire_all()
    return built["pid"], True


def _via_import(db, built, tmp_path) -> tuple[int, bool]:
    docs = tmp_path / "docs"
    docs.mkdir()
    archive = tmp_path / "old-build.mmproject"
    archive.write_bytes(export_project(db, built["pid"], docs).getvalue())
    new_pid, _ = import_project(db, archive, tmp_path / "i", media_dir=None, user_id=1,
                                import_mode="new")
    db.flush()
    assert new_pid != built["pid"]
    # 🔴 `inserted_ids` (#714): the project the file was EXPORTED from is not the
    # import's to repair — it keeps every leak until startup reaches it.
    _assert_untouched(db, built)
    # A .mmproject carries no snapshots, so there is none to check there.
    return new_pid, False


DOORS = {"service": _via_service, "startup": _via_startup, "import": _via_import}


@pytest.mark.parametrize("door", list(DOORS))
class TestTheRepairAtEachDoor:
    def test_every_store_holds_the_truth(self, door, db_session, tmp_path):
        built = _build(db_session, 8100 + list(DOORS).index(door))
        pid, snapshot = DOORS[door](db_session, built, tmp_path)
        _assert_repaired(db_session, pid, snapshot=snapshot)

    def test_a_second_run_changes_nothing(self, door, db_session, tmp_path):
        built = _build(db_session, 8110 + list(DOORS).index(door))
        pid, _ = DOORS[door](db_session, built, tmp_path)
        db_session.commit()
        before = (_materials(db_session, pid), _theme_doc(db_session, pid))
        # Every row of the repaired project writable — and, through the import
        # door, ONLY that project: the one it was exported from still leaks.
        again = RcRepairScope(project_ids=frozenset({pid}), material_ids=None,
                              theme_ids=None, snapshots=True)
        report = normalise_rc_keys(db_session, scope=again)
        assert not report.changed and report.materials == report.embeds == report.snapshots == 0
        assert (_materials(db_session, pid), _theme_doc(db_session, pid)) == before
        if door != "import":
            assert not rc_keys_need_repair(db_session)


class TestTheImportScope:
    def test_a_merge_never_repairs_the_targets_own_rows(self, db_session, tmp_path):
        """🔴 #714. A merge imports codings onto a project that ALREADY holds these
        rows; the import did not write them, so its post-pass must not edit them —
        a scope by project would. (Startup repairs them, as it repairs any row.)"""
        db = db_session
        built = _build(db, 8121)
        docs = tmp_path / "docs"
        docs.mkdir()
        archive = tmp_path / "colleague.mmproject"
        archive.write_bytes(export_project(db, built["pid"], docs).getvalue())
        pid, _ = import_project(db, archive, tmp_path / "i", media_dir=None, user_id=1,
                                import_mode="merge", target_project_id=built["pid"], report={})
        db.flush()
        assert pid == built["pid"]
        _assert_untouched(db, built)

    def test_the_post_pass_is_scoped_by_inserted_ids_in_the_source(self):
        """The remap-vs-inserted distinction is unobservable while a merge blanks
        materials and canvases (both sets are then empty), so the CALL is pinned:
        `RcRepairScope.imported(pid, inserted_ids)`, never `remap`."""
        src = (Path(__file__).resolve().parents[1] / "app" / "services"
               / "project_portability.py").read_text()
        calls = re.findall(r"normalise_rc_keys\((.*?)\)\n", src, re.S)
        assert len(calls) == 1, calls
        assert "RcRepairScope.imported(pid, inserted_ids)" in calls[0]
        assert "remap" not in calls[0]


# ── 3. What it must leave alone, and how it fails ────────────────────────────


class TestWhatItLeavesAlone:
    def test_a_disagreement_is_left_and_LOGGED(self, db_session, monkeypatch):
        built = _build(db_session, 8131)
        warnings: list[str] = []
        monkeypatch.setattr(material_config.logger, "warning",
                            lambda msg, *a, **k: warnings.append(msg % a if a else msg))
        report = normalise_rc_keys(db_session, scope=RcRepairScope.everything())
        assert report.disagreements == [built["materials"]["disagree"]]
        assert any(str(built["materials"]["disagree"]) in w for w in warnings), warnings

    def test_an_embed_of_ANOTHER_projects_material_is_an_orphan_here(self, db_session):
        """The join is within the embed's own project: a materialId that names a
        row elsewhere is not this embed's row."""
        db = db_session
        other = _build(db, 8141)
        canvas = Canvas(project_id=8142, name="X")
        db.add(Project(id=8142, name="Q", user_id=1))
        db.flush()
        db.add(canvas)
        db.flush()
        leaked = _shapes(other["q1"], other["g"])["desc_cmp"][2]
        db.add(CanvasTheme(canvas_id=canvas.id, name="T", content=json.dumps(
            {"type": "doc", "content": [_embed(other["materials"]["desc_cmp"], "x", json.dumps(leaked))]})))
        db.commit()
        normalise_rc_keys(db, scope=RcRepairScope.everything())
        assert _embeds(_theme_doc(db, 8142))["x"][1] == leaked


class TestItNeverRaises:
    def test_an_unreadable_row_is_skipped_and_the_rest_repaired(self, db_session):
        db = db_session
        built = _build(db, 8151)
        coll = db.query(MaterialCollection).filter(MaterialCollection.project_id == 8151).one()
        db.add(Material(collection_id=coll.id, material_type="horizontal_bar", auto_name="broken",
                        source_tab="descriptives", config="{not json"))
        db.add(CanvasTheme(canvas_id=built["canvas"], name="Broken",
                           content='{"chart-embed": ['))
        db.commit()
        report = normalise_rc_keys(db, scope=RcRepairScope.everything())
        assert report.failures == 2
        db.flush()
        assert _materials_except(db, 8151, "broken")["desc_cmp"] == _shapes(built["q1"], built["g"])["desc_cmp"][3]

    def test_an_unexpected_error_ends_the_run_without_raising(self, db_session, monkeypatch):
        _build(db_session, 8152)

        def boom(*_a, **_k):
            raise RuntimeError("planted")
        monkeypatch.setattr(material_config, "_run_rc_repair", boom)
        report = normalise_rc_keys(db_session, scope=RcRepairScope.everything())
        assert report.failures == 1 and not report.changed


def _materials_except(db, pid, skip):
    rows = (db.query(Material).join(MaterialCollection)
            .filter(MaterialCollection.project_id == pid, Material.auto_name != skip).all())
    return {m.auto_name: json.loads(m.config) for m in rows}


# ── 4. The startup gate: a settled install pays one query ────────────────────


def _statements(db, fn):
    seen: list[str] = []
    engine = db.get_bind()

    def _record(conn, cursor, statement, params, context, executemany):
        seen.append(statement)
    event.listen(engine, "before_cursor_execute", _record)
    try:
        result = fn()
    finally:
        event.remove(engine, "before_cursor_execute", _record)
    return result, seen


class TestTheGate:
    def test_a_leaked_install_opens_the_gate(self, db_session):
        _build(db_session, 8161)
        assert rc_keys_need_repair(db_session)

    def test_a_settled_install_pays_ONE_query(self, db_session):
        db = db_session
        _build(db, 8162)
        normalise_rc_keys(db, scope=RcRepairScope.everything())
        db.commit()
        # The settled install still holds the rows the repair leaves on purpose —
        # a disagreement and an orphan — which must not hold the gate open.
        answer, statements = _statements(db, lambda: rc_keys_need_repair(db))
        assert answer is False
        assert len(statements) == 1, statements
        assert "materials" in statements[0]

    def test_each_kind_of_leak_opens_it_alone(self, db_session):
        """One case per arm of the gate's SQL, so neither arm can be dropped."""
        db = db_session
        db.add(Project(id=8163, name="G", user_id=1))
        db.flush()
        coll = MaterialCollection(project_id=8163, name="M")
        db.add(coll)
        db.flush()
        m = Material(collection_id=coll.id, material_type="horizontal_bar", auto_name="a",
                     source_tab="descriptives", config=json.dumps({"column_ids": [1]}))
        db.add(m)
        db.commit()
        assert not rc_keys_need_repair(db)
        m.config = json.dumps({"column_ids": [1], "compare_by": 3})
        db.commit()
        assert rc_keys_need_repair(db)
        m.config = json.dumps({"column_ids": [1]})
        m.source_tab, m.material_type = "correlations", "correlation_matrix"
        db.commit()
        assert rc_keys_need_repair(db), "an unmarked correlation"
        m.config = json.dumps({"column_ids": [1], "rc_view": "correlations"})
        db.commit()
        assert not rc_keys_need_repair(db)

    def test_the_startup_wrapper_pays_one_query_when_settled(self, db_session):
        from app.services.data_repairs import repair_material_rc_keys

        db = db_session
        _build(db, 8164)
        normalise_rc_keys(db, scope=RcRepairScope.everything())
        db.commit()
        _, statements = _statements(db, lambda: repair_material_rc_keys(
            lambda: Session(bind=db.get_bind())))
        assert len(statements) == 1, statements


# ── 5. (d) — the broken-reference check reads the repaired config ────────────


class TestTheReferenceCheck:
    def test_a_leaked_compare_by_no_longer_flags_a_descriptives_chart(self, db_session):
        from app.routers.materials import _build_existence_sets, _build_material_response

        db = db_session
        built = _build(db, 8171)
        mat = db.get(Material, built["materials"]["desc_cmp"])
        db.delete(db.get(DatasetColumn, built["g"]))  # the R&C grouping column
        db.flush()
        flagged = _build_material_response(mat, _build_existence_sets(db, 8171, [mat]))
        assert flagged.has_missing_refs  # the defect, before the repair

        normalise_rc_keys(db, scope=RcRepairScope.everything())
        db.flush()
        after = _build_material_response(mat, _build_existence_sets(db, 8171, [mat]))
        assert not after.has_missing_refs
        # Positive control: the comparison that DOES use `g` is still flagged.
        cmp_ = db.get(Material, built["materials"]["cmp"])
        assert _build_material_response(cmp_, _build_existence_sets(db, 8171, [cmp_])).has_missing_refs


# ── 6. The cross-language pin: the backend's lists ARE the saver's R&C block ──


def _saver_rc_block() -> list[str]:
    src = (FRONTEND / "pages" / "AnalysisView.tsx").read_text()
    start = src.index("const buildCurrentChartConfig = useCallback(() => ({")
    literal = src[start:src.index("}), [", start)]
    marker = literal.index("// R&C tab params")
    before, block = literal[:marker], literal[marker:]
    assert not set(re.findall(r"^ {4}(\w+):", before, re.M)) & material_config.RC_KEYS, (
        "an R&C key is written OUTSIDE the saver's R&C block, so no sub-view gates it")
    return re.findall(r"^ {4}(\w+: .+),$", block, re.M)


#: The gate each R&C line must open with, by the sub-view that owns the key.
GATES = {"rcSubView": "shared", "savingCorrelations": "correlations",
         "savingComparisons": "comparisons"}


def _gate(line: str) -> str | None:
    value = line.split(": ", 1)[1]
    head = re.match(r"(\w+)", value)
    return GATES.get(head.group(1)) if head else None


class TestTheKeyListsAreTheSavers:
    def test_the_scan_sees_the_block(self):
        lines = _saver_rc_block()
        assert len(lines) >= 17
        keys = {ln.split(":", 1)[0] for ln in lines}
        assert {"rc_view", "compare_by", "show_scatter"} <= keys

    def test_every_key_is_gated_by_its_own_sub_view(self):
        by_view: dict[str, set[str]] = {"shared": set(), "correlations": set(), "comparisons": set()}
        for line in _saver_rc_block():
            key = line.split(":", 1)[0]
            view = _gate(line)
            assert view, f"`{line}` is not gated by a sub-view — it would be saved on every tab"
            by_view[view].add(key)
        assert by_view["shared"] == set(material_config.RC_SHARED_KEYS)
        assert by_view["correlations"] == set(material_config.RC_CORRELATION_KEYS)
        assert by_view["comparisons"] == set(material_config.RC_COMPARISON_KEYS)

    def test_the_gate_reader_can_fail(self):
        # The pre-#1315 line shape, ungated.
        assert _gate("compare_by: compareBy || undefined") is None
        assert _gate("rc_view: rcView") is None
        assert _gate("show_scatter: savingCorrelations && showScatter ? true : undefined") == "correlations"

    def test_the_lists_are_disjoint_and_complete(self):
        lists = (material_config.RC_SHARED_KEYS, material_config.RC_CORRELATION_KEYS,
                 material_config.RC_COMPARISON_KEYS)
        assert sum(len(x) for x in lists) == len(material_config.RC_KEYS)
        assert material_config.RC_KEYS <= material_config.PLAIN_KEYS | set(material_config.ID_KEYS)
