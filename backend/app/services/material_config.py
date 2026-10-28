"""Which keys of a saved chart's settings name a ROW — and of which table (#1068).

A saved chart (`Material.config`, JSON) and every canvas chart embed (the node's
own `config` attribute, a COPY of the material's settings taken when it was
embedded — `ChartEmbedView` renders from it, so it survives the material being
deleted) carry entity ids inside a text column. Two consumers need to know which
keys those are:

- the `.mmproject` import, which must rewrite each id through the import's remap
  (`project_portability._remap_material_config`) — the relational FK pass cannot
  see inside a JSON text column (the #387 class);
- the broken-reference check behind a chart's "references a deleted variable"
  warning (`routers/materials.py::_collect_material_refs`, #296).

🔴 **They were two hand-listed tables and they DISAGREED — about different keys.**
The import's table had no `coder_ids`, `observation_ids`, `compare_by`,
`compare_by_2`, `content_source`, legacy `selected_*`, and mapped `custom_order`
to codes for every chart; the reference check spelled three of its keys as URL
PARAMETER names (`compareBy`, `compareBy2`, `crossTabCol`) that no saved chart
has ever carried (#1086). Both read this declaration now.

**The key space is PINNED** — `tests/test_material_config_keys.py` reads the two
savers (`AnalysisView::buildCurrentChartConfig` + `handleAddToMaterials`,
`useQualitativeAnalysis::buildCurrentConfig`) and fails on a key that is in
neither `ID_KEYS`, `ORDER_KEY`, `TAGGED_KEYS` nor `PLAIN_KEYS`. A new setting
has to be classified before it ships.

**#1315 — which keys belong to the Relationships & Comparisons tab, and the
repair that writes that truth into every stored copy** (`normalise_rc_keys`,
at the end of this module).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Collection, Mapping

from sqlalchemy import and_, not_, or_
from sqlalchemy.orm import Session

from ..models.canvas import Canvas, CanvasSnapshot, CanvasTheme
from ..models.materials import Material, MaterialCollection
from .canvas import walk_tiptap_nodes

logger = logging.getLogger(__name__)

# The KINDS of row a key can name. Import remaps each through its own table; the
# broken-reference check asks about the project-scoped ones.
COLUMN = "column"
DOMAIN = "domain"
CODE = "code"
CATEGORY = "category"
CONVERSATION = "conversation"
DOCUMENT = "document"
OBSERVATION = "observation"
PARTICIPANT = "participant"
#: 🔴 An INSTALL-global id (`users.id`), not a project-scoped one — the #1027
#: class. An id that does not resolve names a person on THIS install.
CODER = "coder"
METRIC = "metric"


@dataclass(frozen=True)
class IdKey:
    kind: str
    is_array: bool


#: Keys whose kind is FIXED. ⚠️ `selected_columns` / `selected_domains` and
#: `comment_column_ids` are LEGACY spellings: the quantitative saver renames the
#: first two to `column_ids` / `domain_ids` before saving, and the third is an older
#: name for `text_column_ids` — both still sit in materials saved before the change.
ID_KEYS: dict[str, IdKey] = {
    # Quantitative (AnalysisView)
    "column_ids": IdKey(COLUMN, True),
    "domain_ids": IdKey(DOMAIN, True),
    "selected_columns": IdKey(COLUMN, True),
    "selected_domains": IdKey(DOMAIN, True),
    "grouping_column_id": IdKey(COLUMN, False),
    "grouping_column_id_2": IdKey(COLUMN, False),
    "cross_tab_column_id": IdKey(COLUMN, False),
    "compare_by": IdKey(COLUMN, False),
    "compare_by_2": IdKey(COLUMN, False),
    # Qualitative (useQualitativeAnalysis)
    "code_ids": IdKey(CODE, True),
    "conversation_ids": IdKey(CONVERSATION, True),
    "document_ids": IdKey(DOCUMENT, True),
    "observation_ids": IdKey(OBSERVATION, True),
    "text_column_ids": IdKey(COLUMN, True),
    "comment_column_ids": IdKey(COLUMN, True),
    "participant_ids": IdKey(PARTICIPANT, True),
    "coder_ids": IdKey(CODER, True),
    "content_code_id": IdKey(CODE, False),
}

#: 🔴 The order of the chart's own axis — and its kind is the WRITER's, which a
#: key-to-table map cannot express. The quantitative page orders METRICS; the
#: qualitative one orders codes, or CATEGORIES under `code_mode: categories` (an
#: independent id sequence — `qual-client.md` §1).
ORDER_KEY = "custom_order"

#: A single id carried as `"<tag>:<id>"` — the Content tab's chosen source.
TAGGED_KEYS: dict[str, dict[str, str]] = {
    "content_source": {"c": CONVERSATION, "cc": COLUMN, "d": DOCUMENT, "o": OBSERVATION},
}

#: Keys the two savers write that name no row — the rest of the key space, listed
#: so a NEW key has to be classified (the pin in `test_material_config_keys.py`).
#: ⚠️ `formatting.customColors` is keyed by series LABEL; `decompose` is a flag;
#: `hidden_group_values` / `exclude_groups` / `exclude_values` /
#: `hiddenResponseOptions` / `proportion_config` hold response TEXT, never ids.
PLAIN_KEYS: frozenset[str] = frozenset({
    # both
    "title", "subtitle", "footnote", "chart_type", "formatting",
    # quantitative
    "sort", "display", "scaling", "showChartN", "showGroupN", "showVariableN", "showCI",
    "metric_type", "grouping_mode", "decompose", "exclude_values", "hiddenResponseOptions",
    "scaleOrder", "label_mode", "hidden_group_values", "group_organization",
    "proportion_config", "diverging", "diverging_center", "show_error_band", "line_style",
    "line_overlay", "axis_transform", "cross_tab_display", "rc_view", "corr_type",
    "sig_levels", "bonferroni", "cell_format", "corr_colors", "test_type", "nonparametric",
    "post_hoc_expanded", "rc_chart_type", "exclude_groups", "rc_palette", "show_scatter",
    "show_reg_line", "show_jitter",
    # qualitative
    "tab", "source", "code_mode", "exclude_facilitator", "layer_scope", "value_mode",
    "denominator_mode", "sort_order", "orientation", "rel_view", "cooccurrence_level",
    "show_proportion", "cooccurrence_preset", "comparison_chart_mode", "timeline_table_mode",
    "comparison_palette", "show_effect_size", "group_by", "content_mode", "show_summary_row",
    "show_row_n", "show_chart_n",
})

#: `lib/material-kind.ts::QUALITATIVE_CONFIG_KEYS`, mirrored — ONE discriminator
#: for "which page saved this", pinned against the client's by the key-space test.
QUALITATIVE_CONFIG_KEYS: tuple[str, ...] = ("code_mode", "code_ids")


def is_qualitative(config: dict) -> bool:
    return any(key in config for key in QUALITATIVE_CONFIG_KEYS)


def order_kind(config: dict) -> str:
    """The kind of id `custom_order` holds on THIS config."""
    if not is_qualitative(config):
        return METRIC
    return CATEGORY if config.get("code_mode") == "categories" else CODE


def parse_tagged(value) -> tuple[str, int] | None:
    """`"cc:45"` → `("cc", 45)`; anything else → None."""
    if not isinstance(value, str) or ":" not in value:
        return None
    tag, _, raw = value.partition(":")
    try:
        return tag, int(raw)
    except ValueError:
        return None


# ── #1315: the Relationships & Comparisons keys, and the repair ──────────────
#
# 🔴 `AnalysisView::buildCurrentChartConfig` wrote EVERY key below on EVERY tab
# from 8bd75c68 (2026-02-24), and a tab switch keeps the R&C URL state, so a
# Descriptives chart carried them. Harmless until v1.4.0 made the canvas read two
# of them as markers (#817 `compare_by` + `rc_view`, #831 `rc_view`): a
# Descriptives chart was then REFUSED on the canvas (`rc_view: 'correlations'`)
# or DRAWN as a group comparison (`rc_view: 'comparisons'` + `compare_by`), and a
# leaked `compare_by` made the broken-reference check flag it when the R&C
# grouping column was deleted (`routers/materials.py`). The saver writes each key
# on its own sub-view now; these lists are its R&C block, pinned line by line
# against the saver's literal (each key's sub-view gate) by
# `tests/test_material_rc_key_repair.py::TestTheKeyListsAreTheSavers`.

#: Written on BOTH R&C views. `rc_view` is the canvas's R&C marker
#: (`inline-chart-params.ts::quantChartKind`).
RC_SHARED_KEYS: tuple[str, ...] = ("rc_view", "sig_levels")
#: Written only on the R&C CORRELATIONS view.
RC_CORRELATION_KEYS: tuple[str, ...] = (
    "corr_type", "bonferroni", "cell_format", "corr_colors",
    "show_scatter", "show_reg_line", "show_jitter",
)
#: Written only on the R&C COMPARISONS view.
RC_COMPARISON_KEYS: tuple[str, ...] = (
    "compare_by", "compare_by_2", "test_type", "nonparametric", "post_hoc_expanded",
    "rc_chart_type", "exclude_groups", "rc_palette",
)
RC_KEYS: frozenset[str] = frozenset(RC_SHARED_KEYS + RC_CORRELATION_KEYS + RC_COMPARISON_KEYS)

#: `Material.source_tab` for the three quantitative tabs. ⚠️ A Data Quality save
#: is `descriptives` too — it saves the Descriptives chart.
DESCRIPTIVES_TAB = "descriptives"
CORRELATIONS_TAB = "correlations"
COMPARISONS_TAB = "comparisons"
RC_TABS: tuple[str, ...] = (CORRELATIONS_TAB, COMPARISONS_TAB)

#: `Material.material_type` on an R&C save (`handleAddToMaterials`, unchanged since
#: it was written): a correlation is one of these two, a comparison is
#: `comparison_<chart>` (`lib/comparison-chart-types.ts`).
CORRELATION_MATERIAL_TYPES: frozenset[str] = frozenset({"correlation_matrix", "scatter_matrix"})
COMPARISON_MATERIAL_TYPE_PREFIX = "comparison_"
#: Every qualitative material type (`QualitativeAnalysisView::getMaterialType`).
QUALITATIVE_MATERIAL_TYPE_PREFIX = "qual_"

#: `rc_row_tab`'s answer when the row's two columns name different tabs.
DISAGREE = "disagree"


def _material_type_tab(material_type: str) -> str | None:
    """The tab a `material_type` says it was saved on; None for a qualitative type."""
    if material_type in CORRELATION_MATERIAL_TYPES:
        return CORRELATIONS_TAB
    if material_type.startswith(COMPARISON_MATERIAL_TYPE_PREFIX):
        return COMPARISONS_TAB
    if material_type.startswith(QUALITATIVE_MATERIAL_TYPE_PREFIX):
        return None
    # Every other type is a Descriptives chart type (`chartTypeParam || chartType`).
    return DESCRIPTIVES_TAB


def rc_row_tab(source_tab: str | None, material_type: str | None) -> str | None:
    """The quantitative tab a material ROW was saved on — trusted only when its two
    columns AGREE.

    → `DESCRIPTIVES_TAB` / `CORRELATIONS_TAB` / `COMPARISONS_TAB` when they agree;
    → `None` for a row that is not a quantitative chart (a `qualitative_*` tab, or a
      tab this build does not know) — left alone, silently;
    → `DISAGREE` when the two name different tabs — left alone and LOGGED: one of
      them is wrong and nothing here can say which, so neither is acted on.

    🔴 Both are read because the saver derives both from the same sub-view
    (`AnalysisView::rcSubView`), so on a real row they cannot disagree; a row where
    they do was written by something else, and "writing the truth into config"
    needs a truth.
    """
    if source_tab not in (DESCRIPTIVES_TAB, *RC_TABS):
        return None
    if not isinstance(material_type, str):
        return DISAGREE
    return source_tab if _material_type_tab(material_type) == source_tab else DISAGREE


def normalised_rc_config(config: dict, tab: str) -> dict | None:
    """The config with its R&C keys as `tab`'s saver writes them — or None when
    it already is.

    - **Descriptives** (and Data Quality): every R&C key goes. Nothing on that
      tab reads one, and two of them made the canvas refuse or mis-draw it.
    - **An R&C tab:** a missing `rc_view` is STAMPED from the tab — a correlation
      saved before #831 carried none, so a default-Pearson one was
      indistinguishable from a Descriptives chart on the canvas (#831's accepted
      residual, closed here). Nothing else is changed: `quantChartKind` reads
      `rc_view` first, so the other view's keys a pre-#1315 save carries are
      inert there, and what an R&C row holds beyond its marker is left as saved.
    """
    if tab == DESCRIPTIVES_TAB:
        if RC_KEYS.isdisjoint(config):
            return None
        return {k: v for k, v in config.items() if k not in RC_KEYS}
    if config.get("rc_view") is not None:
        return None
    return {**config, "rc_view": tab}


@dataclass(frozen=True)
class RcRepairScope:
    """Which stored copies `normalise_rc_keys` may READ and which it may WRITE.

    `project_ids` bounds what is read (None: every project); `material_ids` /
    `theme_ids` bound what is written (None: every row read). An embed is judged by
    its material's ROW, read anywhere in its own project, whether or not that row
    is writable.
    """
    project_ids: frozenset[int] | None
    material_ids: frozenset[int] | None
    theme_ids: frozenset[int] | None
    snapshots: bool

    @classmethod
    def everything(cls) -> "RcRepairScope":
        """Startup and after a restore (`data_repairs.run_data_repairs`)."""
        return cls(project_ids=None, material_ids=None, theme_ids=None, snapshots=True)

    @classmethod
    def imported(cls, project_id: int, inserted_ids: Mapping[str, Collection[int]]) -> "RcRepairScope":
        """A `.mmproject` import: only the rows THIS import inserted (#714).

        🔴 `inserted_ids`, never `remap` — a merge remaps a matched entity onto a row
        that already existed, and this repair must not edit the researcher's own
        rows behind an import. A merge blanks materials and canvases today, so both
        sets are empty there; the scoping matters if that list ever changes.
        Snapshots are not carried in a `.mmproject`, so none is written.
        """
        return cls(
            project_ids=frozenset({project_id}),
            material_ids=frozenset(inserted_ids.get("materials", ())),
            theme_ids=frozenset(inserted_ids.get("canvas_themes", ())),
            snapshots=False,
        )


@dataclass
class RcKeyRepair:
    """What one `normalise_rc_keys` run changed — and what it would not touch."""
    materials: int = 0
    embeds: int = 0
    themes: int = 0
    snapshots: int = 0
    #: Material ids whose `source_tab` and `material_type` disagree — untouched.
    disagreements: list[int] = field(default_factory=list)
    #: Rows skipped because something unexpected was in them — logged, untouched.
    failures: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.materials or self.embeds or self.snapshots)


def _like_key(key: str) -> str:
    """`"key":` as a LIKE pattern — `_` and `%` escaped (`\\`), so it names THIS key."""
    escaped = key.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f'%"{escaped}":%'


def rc_keys_need_repair(db: Session) -> bool:
    """🔴 The startup gate — ONE query over `materials`, so a settled install pays
    one query and nothing else (`data_repairs.py`: startup waits for the list).

    The SQL is a coarse prefilter (a Descriptives row whose JSON names an R&C key,
    or an R&C row whose JSON does not name `rc_view`); the rows it returns are then
    judged exactly as the repair judges them, so a false positive — or a row left
    alone on purpose, a disagreement — returns False rather than starting a pass.
    JSON writers put the colon straight after a key's closing quote (`JSON.stringify`
    and `json.dumps` alike), which is what the `"key":` patterns rely on.
    """
    leaked = or_(*(Material.config.like(_like_key(k), escape="\\") for k in sorted(RC_KEYS)))
    unmarked = not_(Material.config.like(_like_key("rc_view"), escape="\\"))
    rows = (
        db.query(Material.source_tab, Material.material_type, Material.config)
        .filter(or_(
            and_(Material.source_tab == DESCRIPTIVES_TAB, leaked),
            and_(Material.source_tab.in_(RC_TABS), unmarked),
        ))
        .all()
    )
    for source_tab, material_type, raw in rows:
        tab = rc_row_tab(source_tab, material_type)
        if tab is None or tab == DISAGREE:
            continue
        config = _parse_config(raw)
        if config is not None and not is_qualitative(config) and normalised_rc_config(config, tab) is not None:
            return True
    return False


def _parse_config(raw) -> dict | None:
    """A config as stored (a JSON string) or as a node carries it (a dict)."""
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return None
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _normalise_embeds(doc, tab_for_material, report: RcKeyRepair) -> bool:
    """Normalise every chart embed in one Tiptap document, in place. True if any changed.

    The embed is judged by ITS material's row (`tab_for_material`); an ORPHAN —
    whose material is gone, or lives in another project — has no row to judge it
    by and is left exactly as it is. Its `config` keeps its shape (a JSON string,
    as `CanvasView` writes it, or a dict), and nothing else on the node is touched —
    the #808 figure baseline included, so an embed that drew the wrong figure says
    "The figures have changed…" once it draws the right one.
    """
    changed = False

    def _one(node: dict) -> None:
        nonlocal changed
        attrs = node.get("attrs")
        if not isinstance(attrs, dict):
            return
        material_id = attrs.get("materialId")
        if not isinstance(material_id, int) or isinstance(material_id, bool):
            return
        tab = tab_for_material(material_id)
        if tab is None:
            return
        raw = attrs.get("config")
        config = _parse_config(raw)
        if config is None or is_qualitative(config):
            return
        fixed = normalised_rc_config(config, tab)
        if fixed is None:
            return
        attrs["config"] = json.dumps(fixed) if isinstance(raw, str) else fixed
        report.embeds += 1
        changed = True

    walk_tiptap_nodes(doc, {"chart-embed"}, _one)
    return changed


def _normalise_content(content, tab_for_material, report: RcKeyRepair):
    """A theme's `content` (a JSON string, or a dict inside a snapshot) with its
    chart embeds normalised — or None when nothing in it changed."""
    doc = json.loads(content) if isinstance(content, str) else content
    if not isinstance(doc, dict) or not _normalise_embeds(doc, tab_for_material, report):
        return None
    return json.dumps(doc) if isinstance(content, str) else doc


def normalise_rc_keys(db: Session, *, scope: RcRepairScope) -> RcKeyRepair:
    """🔴 #1315 — write the truth about the R&C keys into every stored copy of a
    chart's settings: the material ROW (`materials.config`), every canvas chart
    embed's own copy (`canvas_themes.content`, the node's `config` attr), and every
    canvas snapshot (`canvas_snapshots.snapshot_data`, which holds theme content).
    Repairing the row alone fixes no canvas: an embed renders from its copy.

    The truth comes from the ROW — `rc_row_tab(source_tab, material_type)` — and is
    applied by `normalised_rc_config`: a Descriptives copy loses every R&C key; an
    R&C copy without `rc_view` has it stamped. A row whose two columns disagree is
    left alone (and so are its embeds), and logged. An ORPHAN embed is left alone:
    there is no row to read.

    **Idempotent**: a second run finds nothing to change and writes nothing.
    **Never raises**: a row it cannot read is skipped and logged, and anything
    unexpected ends the run with what it had done so far, logged; the caller's
    transaction is not failed for it. **Writes ORM attributes only — the caller
    commits** (startup) or its transaction carries them (an import).

    Callers: `data_repairs.repair_material_rc_keys` (startup + after a restore,
    `RcRepairScope.everything()`, behind `rc_keys_need_repair`) and
    `project_portability.import_project` (`RcRepairScope.imported`).
    """
    report = RcKeyRepair()
    try:
        _run_rc_repair(db, scope, report)
    except Exception:
        report.failures += 1
        logger.exception("R&C key repair (#1315) stopped early; what it had changed stands")
    if report.disagreements:
        logger.warning(
            "R&C key repair (#1315): left %d material(s) untouched — their source_tab and "
            "material_type name different tabs (ids %s%s)",
            len(report.disagreements), report.disagreements[:20],
            "…" if len(report.disagreements) > 20 else "",
        )
    if report.changed:
        logger.info(
            "R&C key repair (#1315): %d material(s), %d embed(s) in %d theme(s), %d snapshot(s)",
            report.materials, report.embeds, report.themes, report.snapshots,
        )
    return report


def _run_rc_repair(db: Session, scope: RcRepairScope, report: RcKeyRepair) -> None:
    # 1. Every material row in scope: its verdict (read), and its config (written).
    q = (
        db.query(Material, MaterialCollection.project_id)
        .join(MaterialCollection, Material.collection_id == MaterialCollection.id)
    )
    if scope.project_ids is not None:
        q = q.filter(MaterialCollection.project_id.in_(scope.project_ids))
    verdict: dict[int, tuple[int, str]] = {}
    for material, project_id in q.all():
        try:
            writable = scope.material_ids is None or material.id in scope.material_ids
            tab = rc_row_tab(material.source_tab, material.material_type)
            if tab == DISAGREE:
                if writable:
                    report.disagreements.append(material.id)
                continue
            if tab is None:
                continue
            config = _parse_config(material.config)
            if config is None:
                if writable:
                    logger.warning("R&C key repair (#1315): material %s has an unreadable config; skipped", material.id)
                    report.failures += 1
                continue
            if is_qualitative(config):
                continue
            verdict[material.id] = (project_id, tab)
            if not writable:
                continue
            fixed = normalised_rc_config(config, tab)
            if fixed is not None:
                material.config = json.dumps(fixed)
                report.materials += 1
        except Exception:
            report.failures += 1
            logger.exception("R&C key repair (#1315): material %s skipped", material.id)

    def judge(project_id: int):
        def tab_for_material(material_id: int) -> str | None:
            found = verdict.get(material_id)
            # Another project's material is not this embed's row — an orphan here.
            return found[1] if found is not None and found[0] == project_id else None
        return tab_for_material

    # 2. Every theme holding a chart embed: its copies.
    tq = (
        db.query(CanvasTheme, Canvas.project_id)
        .join(Canvas, CanvasTheme.canvas_id == Canvas.id)
        .filter(CanvasTheme.content.like("%chart-embed%"))
    )
    if scope.project_ids is not None:
        tq = tq.filter(Canvas.project_id.in_(scope.project_ids))
    if scope.theme_ids is not None:
        tq = tq.filter(CanvasTheme.id.in_(scope.theme_ids))
    for theme, project_id in tq.all():
        try:
            new_content = _normalise_content(theme.content, judge(project_id), report)
            if new_content is not None:
                theme.content = new_content
                report.themes += 1
        except Exception:
            report.failures += 1
            logger.exception("R&C key repair (#1315): canvas theme %s skipped", theme.id)

    # 3. Every snapshot holding a chart embed: the theme content it would restore.
    if not scope.snapshots:
        return
    sq = (
        db.query(CanvasSnapshot, Canvas.project_id)
        .join(Canvas, CanvasSnapshot.canvas_id == Canvas.id)
        .filter(CanvasSnapshot.snapshot_data.like("%chart-embed%"))
    )
    if scope.project_ids is not None:
        sq = sq.filter(Canvas.project_id.in_(scope.project_ids))
    for snapshot, project_id in sq.all():
        try:
            data = json.loads(snapshot.snapshot_data)
            themes = data.get("themes") if isinstance(data, dict) else None
            if not isinstance(themes, list):
                continue
            changed = False
            for item in themes:
                if not isinstance(item, dict) or not item.get("content"):
                    continue
                new_content = _normalise_content(item["content"], judge(project_id), report)
                if new_content is not None:
                    item["content"] = new_content
                    changed = True
            if changed:
                snapshot.snapshot_data = json.dumps(data)
                report.snapshots += 1
        except Exception:
            report.failures += 1
            logger.exception("R&C key repair (#1315): canvas snapshot %s skipped", snapshot.id)
