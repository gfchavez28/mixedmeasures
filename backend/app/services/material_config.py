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
"""
from __future__ import annotations

from dataclasses import dataclass

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
