"""R data export endpoint and helpers — split from export.py for maintainability."""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, selectinload, joinedload
from sqlalchemy import func
import io
import csv
import json
import re
import zipfile
from datetime import datetime, timezone
from collections import defaultdict

from ..database import get_db
from ..models.user import User
from ..models.project import Project
from ..models.dataset import Dataset, DatasetColumn, DatasetRow, DatasetValue, ColumnType
from ..models.recode import RecodeDefinition
from ..models.metric import MetricDefinition
from ..models.row_score import RowScore
from ..models.analysis_domain import AnalysisDomain, AnalysisDomainMember
from ..models.equivalence_group import EquivalenceGroup
from ..models.participant import Participant
from ..models.code import Code
from ..models.code_application import CodeApplication
from ..models.code_category import CodeCategory
from ..models.statistical_test import StatisticalTest
from ..models.materials import MaterialCollection, Material
from ..services.metrics import resolve_input_source_labels
from ..services.grouping import load_grouping_values
from ..services.computed_columns import (
    parse as parse_expression,
    validate as validate_expression,
    to_r_expression,
    ColumnInfo as CCColumnInfo,
    ExpressionError,
)
from ..auth import get_current_user
from .helpers import _get_project_or_404
from .export_helpers import _build_category_tree_and_chains, csv_safe

router = APIRouter(tags=["export"])


# ── R Data Export helpers ────────────────────────────────────────────────────


def _slugify(text: str, max_len: int = 60) -> str:
    """Convert text to a valid slug: lowercase, alphanumeric + underscores."""
    s = text.lower()
    s = s.replace(" ", "_")
    s = re.sub(r"[^a-z0-9_]", "", s)
    s = re.sub(r"_+", "_", s)
    s = s.strip("_")
    return s[:max_len]


def _escape_r_string(text: str) -> str:
    """Escape a string for safe interpolation into R string literals."""
    s = text.replace("\\", "\\\\")
    s = s.replace('"', '\\"')
    s = s.replace("'", "\\'")
    s = s.replace("\n", "\\n")
    s = s.replace("\r", "")
    return s


def _make_r_identifier(name: str) -> str:
    """Make a valid R identifier from a name."""
    s = _slugify(name)
    if not s:
        return "col"
    if s[0].isdigit():
        s = "x_" + s
    return s


def _get_factor_mapping(
    col: DatasetColumn, primary_recode: RecodeDefinition | None
) -> dict | None:
    """Extract factor levels/labels from a column's metadata.
    Returns {values: [...], labels: [...]} or None if no metadata available.
    """
    # Priority 1: Primary recode mapping
    if primary_recode and primary_recode.mapping:
        try:
            mapping = (
                json.loads(primary_recode.mapping)
                if isinstance(primary_recode.mapping, str)
                else primary_recode.mapping
            )
            if mapping:
                # mapping is {label: numeric_value, ...}
                # Sort by numeric value for ordinal
                pairs = sorted(
                    mapping.items(),
                    key=lambda x: (float(x[1]) if isinstance(x[1], (int, float)) else 0),
                )
                labels = [p[0] for p in pairs]
                values = [p[1] for p in pairs]
                return {"values": values, "labels": labels}
        except (json.JSONDecodeError, TypeError):
            pass

    # Priority 2: scale_labels / scale_values
    if col.scale_labels:
        try:
            labels = (
                json.loads(col.scale_labels)
                if isinstance(col.scale_labels, str)
                else col.scale_labels
            )
            if labels:
                if col.scale_values:
                    values = (
                        json.loads(col.scale_values)
                        if isinstance(col.scale_values, str)
                        else col.scale_values
                    )
                else:
                    # Generate 1-based sequential values
                    values = list(range(1, len(labels) + 1))
                return {"values": values, "labels": labels}
        except (json.JSONDecodeError, TypeError):
            pass

    return None


def _get_observed_values(db: Session, column_id: int) -> list[str]:
    """Get distinct non-null observed value_text values for a column, sorted alphabetically."""
    results = (
        db.query(DatasetValue.value_text)
        .filter(
            DatasetValue.column_id == column_id,
            DatasetValue.value_text != None,
            DatasetValue.value_text != "",
        )
        .distinct()
        .all()
    )
    return sorted([r[0] for r in results])


# Qualifying column types for R export
_R_EXPORT_TYPES = {
    ColumnType.ORDINAL,
    ColumnType.NOMINAL,
    ColumnType.BINARY,
    ColumnType.NUMERIC,
    ColumnType.PERCENTAGE,
    ColumnType.DEMOGRAPHIC,
}


def _emit_domain_aggregate_r_lines(
    members_by_dataset: dict[str, list[str]] | None,
    r_name_for_full_set: str,
) -> list[str]:
    """Emit R lines for a domain_aggregate metric, with a #293 cross-dataset
    transparency block when members span 2+ datasets.

    For single-dataset (or unknown) domains, emit the original
    `mean(colMeans(data[, domains$X], na.rm = TRUE))` form. For cross-dataset
    domains, ALSO emit a comment explaining that the all-up aggregate
    equally-weights per-item means coming from disjoint respondent populations,
    plus per-dataset breakdowns so the researcher can read the dataset-level
    means side-by-side.

    Args:
        members_by_dataset: dataset_name → list of R column names. Empty/None
            falls back to the original behavior.
        r_name_for_full_set: the R variable already declared for the full
            flattened member list (e.g., "domains$wellness").
    """
    lines: list[str] = []
    cross_dataset = members_by_dataset is not None and len(members_by_dataset) > 1
    if not cross_dataset:
        lines.append(f"domain_means <- colMeans(.mm_num(data[, {r_name_for_full_set}]), na.rm = TRUE)")
        lines.append("mean(domain_means)")
        return lines

    # Cross-dataset: the all-up form mirrors compute_domain_aggregate
    # (mean of per-item means). Make the interpretation explicit.
    lines.append("# Cross-dataset domain. The all-up aggregation below mirrors")
    lines.append("# Mixed Measures' compute_domain_aggregate (mean of per-item means).")
    lines.append("# For cross-dataset domains the per-item means come from disjoint")
    lines.append("# respondent populations (e.g. BQ1 from Board, SQ1 from Staff), so")
    lines.append("# the final mean equally weights each item across datasets.")
    lines.append("# Per-dataset breakdowns follow for transparency.")
    lines.append(f"domain_means <- colMeans(.mm_num(data[, {r_name_for_full_set}]), na.rm = TRUE)")
    lines.append("mean(domain_means)")
    lines.append("")
    # Sort dataset names for deterministic output.
    for ds_name in sorted(members_by_dataset.keys()):
        r_names = members_by_dataset[ds_name]
        if not r_names:
            continue
        slug = _slugify(ds_name, max_len=20) or "ds"
        members_str = ", ".join(f'"{n}"' for n in r_names)
        ds_name_escaped = _escape_r_string(ds_name)
        lines.append(f"# {ds_name} subset")
        lines.append(
            f"{slug}_subset <- data[data$dataset == \"{ds_name_escaped}\", c({members_str})]"
        )
        lines.append(f"{slug}_means <- colMeans(.mm_num({slug}_subset), na.rm = TRUE)")
        lines.append(f"mean({slug}_means)")
    return lines


def _build_r_script(
    db: Session,
    project,
    project_slug: str,
    qualifying_datasets: list[tuple],
    col_meta: dict[int, dict],
    domain_metrics: list,
    domain_score_cols: list[dict],
    domain_members_map,
    domain_members_by_dataset_map,
    n_records: int,
    n_variables: int,
    skipped_datasets: list[str],
    is_multi_dataset: bool,
    equiv_groups: list[dict],
    used_names: set[str],
    all_domain_name_map: dict[int, str],
    all_domain_members_map,
    all_domain_members_by_dataset_map,
    human_metrics: list,
    human_metric_labels: dict,
    stat_tests: list,
    quant_materials: list,
) -> str:
    """Build the R script content. Returns the full script string with UTF-8 BOM."""
    now_utc = datetime.now(timezone.utc)
    dataset_names = ", ".join(ds.name for ds, _ in qualifying_datasets)

    r_lines: list[str] = []
    toc_sections: list[str] = []

    # Header block
    r_lines.append("# ============================================================")
    r_lines.append("# Mixed Measures R Data Export")
    r_lines.append(f"# Project: {_escape_r_string(project.name)}")
    r_lines.append(f'# Export date: {now_utc.strftime("%Y-%m-%d %H:%M UTC")}')
    r_lines.append(f"# Records: {n_records}")
    r_lines.append(f"# Variables: {n_variables}")
    r_lines.append(f"# Datasets: {_escape_r_string(dataset_names)}")
    r_lines.append("# ============================================================")
    r_lines.append("# Set your working directory to the folder containing this")
    r_lines.append('# script and the CSV, or use setwd("/path/to/folder")')
    r_lines.append("# ============================================================")
    r_lines.append("")
    toc_insert_index = len(r_lines)  # TOC will be inserted here after all sections

    # Packages (package list updated after analysis sections set needs_dplyr/needs_psych)
    required_packages = ["readr"]
    needs_dplyr = False
    needs_psych = False
    needs_ggplot2 = False
    toc_sections.append("Packages")
    r_lines.append("# ---- Packages ----")
    # #363: set a CRAN mirror before install.packages — under non-interactive R
    # (`R -f` / Rscript) repos defaults to "@CRAN@" and install.packages() fails
    # with "trying to use CRAN without setting a mirror".
    r_lines.append('if (is.null(getOption("repos")) || getOption("repos")["CRAN"] == "@CRAN@") {')
    r_lines.append('  options(repos = c(CRAN = "https://cloud.r-project.org"))')
    r_lines.append("}")
    pkg_line_index = len(r_lines)  # save index for later update
    r_lines.append("required_packages <- c(\"readr\")")  # placeholder, updated later
    r_lines.append("for (pkg in required_packages) {")
    r_lines.append("  if (!requireNamespace(pkg, quietly = TRUE)) install.packages(pkg)")
    r_lines.append("  library(pkg, character.only = TRUE)")
    r_lines.append("}")
    r_lines.append("")

    # Read data
    toc_sections.append("Read data")
    r_lines.append("# ---- Read data ----")
    r_lines.append(f'data <- read_csv("{project_slug}_data.csv", na = c("", "NA"))')
    r_lines.append("")

    # Helper: coerce (ordered) factor columns back to numeric for numeric
    # analyses (#363). Ordinal items are converted to ordered factors below for
    # display/tabulation, but Cronbach's alpha, correlations, covariance and
    # scale means need numerics — passing factors to cor()/cov()/colMeans()
    # errors ("'x' must be numeric" / empty matrix). Ordered factors here use
    # consecutive integer levels, so factor codes equal the scale values; for
    # correlation (scale/shift-invariant) this is exact regardless.
    r_lines.append("# ---- Helpers ----")
    r_lines.append(".mm_num <- function(x) {")
    r_lines.append("  if (is.data.frame(x)) as.data.frame(lapply(x, .mm_num))")
    r_lines.append("  else if (is.factor(x)) as.numeric(x)")
    r_lines.append("  else x")
    r_lines.append("}")
    r_lines.append("")

    # Build factor calls, labels, reverse notes, excluded values
    ordinal_lines: list[str] = []
    nominal_lines: list[str] = []
    label_lines: list[str] = []
    reverse_lines: list[str] = []
    excluded_values_map: dict[str, list[str]] = {}
    script_notes: list[str] = []

    for cid, meta in col_meta.items():
        col = meta["col"]
        r_name = meta["r_name"]
        col_type = col.column_type

        # Variable labels (all columns including computed)
        if col.column_text:
            label_lines.append(
                f'attr(data${r_name}, "label") <- "{_escape_r_string(col.column_text)}"'
            )

        # Skip computed columns for factor/recode/reverse/excluded processing
        if col.source == "computed":
            continue

        primary_recode = None
        for rd in col.recode_definitions:
            if rd.is_primary:
                primary_recode = rd
                break

        # Excluded values
        if primary_recode and primary_recode.exclude_values:
            try:
                excl = (
                    json.loads(primary_recode.exclude_values)
                    if isinstance(primary_recode.exclude_values, str)
                    else primary_recode.exclude_values
                )
                if excl:
                    excluded_values_map[r_name] = excl
            except (json.JSONDecodeError, TypeError):
                pass

        # Reverse-scored
        if primary_recode and primary_recode.recode_type.value == "reverse":
            scale_max = None
            if primary_recode.mapping:
                try:
                    r_mapping = (
                        json.loads(primary_recode.mapping)
                        if isinstance(primary_recode.mapping, str)
                        else primary_recode.mapping
                    )
                    if r_mapping:
                        all_numeric = [
                            float(v) for v in r_mapping.values() if v is not None
                        ]
                        if all_numeric:
                            scale_max = max(all_numeric)
                except (json.JSONDecodeError, TypeError, ValueError):
                    pass

            if scale_max is not None:
                sm = int(scale_max) if scale_max == int(scale_max) else scale_max
                reverse_lines.append(f"# {r_name}: reverse-scored (original scale 1-{sm})")
                reverse_lines.append("# CSV contains pre-reversed values")
                reverse_lines.append(
                    f"# To recreate from raw: data${r_name}_R <- ({sm}+1) - data${r_name}_raw"
                )
            else:
                reverse_lines.append(
                    f"# {r_name}: reverse-scored (values in data are already reversed)"
                )
            reverse_lines.append("")

        # Factor calls by type
        if col_type == ColumnType.ORDINAL:
            mapping = _get_factor_mapping(col, primary_recode)
            if mapping:
                levels_str = ", ".join(str(v) for v in mapping["values"])
                labels_str = ", ".join(
                    f'"{_escape_r_string(str(l))}"' for l in mapping["labels"]
                )
                ordinal_lines.append(f"data${r_name} <- factor(data${r_name},")
                ordinal_lines.append(f"  levels = c({levels_str}),")
                ordinal_lines.append(f"  labels = c({labels_str}),")
                ordinal_lines.append("  ordered = TRUE)")
                ordinal_lines.append("")
            else:
                script_notes.append(
                    f"# {r_name}: ordinal type but no scale labels defined"
                    " — included as numeric"
                )

        elif col_type == ColumnType.BINARY:
            mapping = _get_factor_mapping(col, primary_recode)
            if mapping:
                levels_str = ", ".join(str(v) for v in mapping["values"])
                labels_str = ", ".join(
                    f'"{_escape_r_string(str(l))}"' for l in mapping["labels"]
                )
                nominal_lines.append(f"data${r_name} <- factor(data${r_name},")
                nominal_lines.append(f"  levels = c({levels_str}),")
                nominal_lines.append(f"  labels = c({labels_str}))")
                nominal_lines.append("")
            else:
                script_notes.append(
                    f"# {r_name}: binary type but no labels defined"
                    " — included as 0/1 numeric"
                )

        elif col_type == ColumnType.NOMINAL:
            mapping = _get_factor_mapping(col, primary_recode)
            if mapping:
                levels_str = ", ".join(str(v) for v in mapping["values"])
                labels_str = ", ".join(
                    f'"{_escape_r_string(str(l))}"' for l in mapping["labels"]
                )
                nominal_lines.append(f"data${r_name} <- factor(data${r_name},")
                nominal_lines.append(f"  levels = c({levels_str}),")
                nominal_lines.append(f"  labels = c({labels_str}))")
                nominal_lines.append("")
            else:
                # Try distinct observed values
                observed = _get_observed_values(db, col.id)
                if observed:
                    levels_str = ", ".join(
                        f'"{_escape_r_string(v)}"' for v in observed
                    )
                    nominal_lines.append(f"data${r_name} <- factor(data${r_name},")
                    nominal_lines.append(f"  levels = c({levels_str}))")
                    nominal_lines.append("")
                else:
                    script_notes.append(
                        f"# {r_name}: nominal type but no levels defined"
                        " — included as character"
                    )

        elif col_type == ColumnType.DEMOGRAPHIC:
            observed = _get_observed_values(db, col.id)
            if observed:
                levels_str = ", ".join(
                    f'"{_escape_r_string(v)}"' for v in observed
                )
                nominal_lines.append(f"data${r_name} <- factor(data${r_name},")
                nominal_lines.append(f"  levels = c({levels_str}))")
                nominal_lines.append("")

        # numeric / percentage: no factor calls needed

    # Write R script sections
    if ordinal_lines:
        toc_sections.append("Ordinal items (ordered factors)")
        r_lines.append("# ---- Ordinal items (ordered factors) ----")
        r_lines.extend(ordinal_lines)

    if nominal_lines:
        toc_sections.append("Nominal / demographic / binary items (unordered factors)")
        r_lines.append("# ---- Nominal / demographic / binary items (unordered factors) ----")
        r_lines.extend(nominal_lines)

    if label_lines:
        toc_sections.append("Variable labels")
        r_lines.append("# ---- Variable labels ----")
        r_lines.extend(label_lines)
        r_lines.append("")

    if reverse_lines:
        toc_sections.append("Reverse-scored items")
        r_lines.append("# ---- Reverse-scored items ----")
        r_lines.extend(reverse_lines)
        r_lines.append("")

    # Computed columns
    computed_col_lines: list[str] = []
    computed_col_errors: list[str] = []
    computed_cols = [
        (cid, meta) for cid, meta in col_meta.items()
        if meta["col"].source == "computed" and meta["col"].expression
    ]
    if computed_cols:
        # Topological sort by depends_on_column_ids (Kahn's algorithm)
        dep_graph: dict[int, set[int]] = {}
        for cc_id, cc_meta in computed_cols:
            cc_col = cc_meta["col"]
            deps: set[int] = set()
            if cc_col.depends_on_column_ids:
                try:
                    dep_ids = json.loads(cc_col.depends_on_column_ids)
                    deps = {d for d in dep_ids if d in col_meta}
                except (json.JSONDecodeError, TypeError):
                    pass
            dep_graph[cc_id] = deps

        computed_ids_set = {cid for cid, _ in computed_cols}
        in_degree = {cid: 0 for cid in computed_ids_set}
        for cc_id, deps in dep_graph.items():
            for d in deps:
                if d in computed_ids_set:
                    in_degree[cc_id] += 1

        sorted_ids: list[int] = []
        queue = [cid for cid, deg in in_degree.items() if deg == 0]
        while queue:
            node = queue.pop(0)
            sorted_ids.append(node)
            for cc_id, deps in dep_graph.items():
                if node in deps:
                    in_degree[cc_id] -= 1
                    if in_degree[cc_id] == 0:
                        queue.append(cc_id)

        # Any remaining nodes have cycles — append with warning
        for cid in computed_ids_set - set(sorted_ids):
            sorted_ids.append(cid)
            computed_col_errors.append(
                f"# {col_meta[cid]['r_name']}: circular dependency detected"
            )

        # Build r_names map for all columns in col_meta
        all_r_names = {cid: meta["r_name"] for cid, meta in col_meta.items()}

        # Generate R code for each computed column in dependency order
        for cc_id in sorted_ids:
            cc_meta = col_meta[cc_id]
            cc_col = cc_meta["col"]
            cc_r_name = cc_meta["r_name"]
            cc_dataset = cc_meta["dataset"]

            try:
                ast = parse_expression(cc_col.expression)

                # Build ColumnInfo list from sibling columns in same dataset
                sibling_infos = []
                for other_cid, other_meta in col_meta.items():
                    if other_cid == cc_id:
                        continue
                    if other_meta["dataset"].id != cc_dataset.id:
                        continue
                    oc = other_meta["col"]
                    ct = oc.column_type
                    sibling_infos.append(CCColumnInfo(
                        id=oc.id,
                        code=oc.column_code,
                        text=oc.column_text,
                        column_type=ct.value if hasattr(ct, "value") else str(ct),
                    ))

                result = validate_expression(ast, sibling_infos, self_column_id=cc_id)
                r_expr = to_r_expression(
                    result.resolved_ast, all_r_names, df_name="data"
                )
                computed_col_lines.append(
                    f"# {cc_r_name}: {_escape_r_string(cc_col.expression)}"
                )
                computed_col_lines.append(f"data${cc_r_name} <- {r_expr}")
                computed_col_lines.append("")

            except (ExpressionError, Exception) as exc:
                computed_col_lines.append(f"# {cc_r_name}: COULD NOT TRANSLATE")
                computed_col_lines.append(
                    f"# Expression: {_escape_r_string(cc_col.expression)}"
                )
                computed_col_lines.append(f"# Error: {_escape_r_string(str(exc))}")
                computed_col_lines.append("# (values are pre-computed in the CSV)")
                computed_col_lines.append("")
                computed_col_errors.append(
                    f"# {cc_r_name}: computed column formula could not be translated"
                    f" — {_escape_r_string(str(exc))}"
                )

    if computed_col_lines:
        toc_sections.append("Computed columns")
        r_lines.append("# ---- Computed columns ----")
        r_lines.append("# Formulas below reproduce columns already present in the CSV.")
        r_lines.append("# They are included for documentation and reproducibility.")
        r_lines.extend(computed_col_lines)

    # Add computed-column errors to script_notes
    script_notes.extend(computed_col_errors)

    # Domain groupings
    if domain_score_cols and domain_members_map:
        toc_sections.append("Domain groupings")
        r_lines.append("# ---- Domain groupings ----")
        r_lines.append("domains <- list(")
        domain_entries = []
        for dsc in domain_score_cols:
            metric = next(
                (m for m in domain_metrics if m.id == dsc["metric_id"]), None
            )
            if metric:
                dom_id = metric.input_source_id
                member_r_names = domain_members_map.get(dom_id, [])
                if member_r_names:
                    members_str = ", ".join(f'"{n}"' for n in member_r_names)
                    dom_slug = _make_r_identifier(dsc["domain_name"])
                    domain_entries.append(f"  {dom_slug} = c({members_str})")
        if domain_entries:
            r_lines.append(",\n".join(domain_entries))
        r_lines.append(")")
        r_lines.append("")
    elif not domain_score_cols:
        toc_sections.append("Domain groupings")
        r_lines.append("# ---- Domain groupings ----")
        r_lines.append(
            "# Domain scores not included: metrics have not been computed"
            " for this project"
        )
        r_lines.append("")

    # Equivalence groups
    if equiv_groups:
        toc_sections.append("Equivalence groups")
        r_lines.append("# ---- Equivalence groups ----")
        r_lines.append("equivalence_groups <- list(")
        eq_entries = []
        for eg in equiv_groups:
            eq_slug = _make_r_identifier(eg["label"])
            members_str = ", ".join(f'"{n}"' for n in eg["r_names"])
            eq_entries.append(f"  {eq_slug} = c({members_str})")
        r_lines.append(",\n".join(eq_entries))
        r_lines.append(")")
        r_lines.append("")

    # Excluded values
    if excluded_values_map:
        toc_sections.append("Excluded values")
        r_lines.append("# ---- Excluded values ----")
        r_lines.append("excluded_values <- list(")
        excl_entries = []
        for col_name, vals in excluded_values_map.items():
            vals_str = ", ".join(f'"{_escape_r_string(v)}"' for v in vals)
            excl_entries.append(f"  {col_name} = c({vals_str})")
        r_lines.append(",\n".join(excl_entries))
        r_lines.append(")")
        r_lines.append("")

    # ── Analysis sections (from materials, metrics, and tests) ────────────

    # Helper: resolve column IDs to R-names
    def _resolve_ids_to_r(id_list: list | None) -> tuple[list[str], list[int]]:
        resolved, skipped = [], []
        for cid in (id_list or []):
            if cid in col_meta:
                resolved.append(col_meta[cid]["r_name"])
            else:
                skipped.append(cid)
        return resolved, skipped

    # Helper: resolve a single column ID
    def _col_r(cid: int | None) -> str | None:
        if cid is None:
            return None
        meta = col_meta.get(cid)
        return meta["r_name"] if meta else None

    # Metric computation section
    metric_lines: list[str] = []
    emitted_analyses: set[tuple] = set()  # for deduplication

    # Process materials with source_tab="descriptives"
    for pe in quant_materials:
        if pe.source_tab != "descriptives":
            continue
        try:
            pe_cfg = json.loads(pe.config) if isinstance(pe.config, str) else pe.config
            if not isinstance(pe_cfg, dict):
                continue
        except (json.JSONDecodeError, TypeError):
            continue

        mt = pe_cfg.get("metric_type")
        if not mt:
            continue

        col_ids = pe_cfg.get("column_ids") or []
        dom_ids = pe_cfg.get("domain_ids") or []
        grp_id = pe_cfg.get("grouping_column_id")
        grp2_id = pe_cfg.get("grouping_column_id_2")
        grp_mode = pe_cfg.get("grouping_mode")
        pe_name = pe.custom_name or pe.auto_name

        # Resolve grouping
        grp_r = _col_r(grp_id)
        grp2_r = _col_r(grp2_id)
        has_grouping = bool(grp_r or grp_mode == "dataset")

        # Resolve target columns/domains
        target_r_names, skipped_ids = _resolve_ids_to_r(col_ids)
        # Track which target_r_names came from a domain ref so the
        # domain_aggregate emitter (#293) can look up the domain's
        # per-dataset member breakdown.
        r_name_to_domain_id: dict[str, int] = {}
        for did in dom_ids:
            d_members = all_domain_members_map.get(did)
            if d_members:
                d_name = all_domain_name_map.get(did, f"domain_{did}")
                r_name = f"domains${_make_r_identifier(d_name)}"
                target_r_names.append(r_name)
                r_name_to_domain_id[r_name] = did
            else:
                skipped_ids.append(did)

        if not target_r_names and not dom_ids:
            continue

        try:
            metric_lines.append(f"# {_escape_r_string(pe_name)}")
            if skipped_ids:
                metric_lines.append(
                    f"# Note: skipped deleted references: {skipped_ids}"
                )

            for r_name in target_r_names:
                is_domain_ref = r_name.startswith("domains$")
                # Dedup key
                dedup_key = (mt, r_name, grp_r, grp2_r, grp_mode)
                if dedup_key in emitted_analyses:
                    continue
                emitted_analyses.add(dedup_key)

                if mt == "frequency_distribution":
                    if has_grouping and not is_domain_ref:
                        needs_dplyr = True
                        if grp_mode == "dataset":
                            metric_lines.append(
                                f"data %>% group_by(dataset) %>% count({r_name})"
                            )
                        elif grp2_r:
                            metric_lines.append(
                                f"data %>% group_by({grp_r}, {grp2_r}) %>% count({r_name})"
                            )
                        else:
                            metric_lines.append(
                                f"data %>% group_by({grp_r}) %>% count({r_name})"
                            )
                    else:
                        metric_lines.append(f"table(data${r_name})")
                        metric_lines.append(f"prop.table(table(data${r_name}))")

                elif mt == "mean":
                    if has_grouping and not is_domain_ref:
                        needs_dplyr = True
                        grp_expr = "dataset" if grp_mode == "dataset" else grp_r
                        if grp2_r and grp_mode != "dataset":
                            grp_expr = f"{grp_r}, {grp2_r}"
                        metric_lines.append(f"data %>%")
                        metric_lines.append(f"  filter(!is.na({r_name})) %>%")
                        metric_lines.append(f"  group_by({grp_expr}) %>%")
                        metric_lines.append(f"  summarise(")
                        metric_lines.append(f"    mean = mean(.mm_num({r_name}), na.rm = TRUE),")
                        metric_lines.append(f"    sd = sd(.mm_num({r_name}), na.rm = TRUE),")
                        metric_lines.append(f"    n = sum(!is.na({r_name})),")
                        metric_lines.append(
                            f"    ci_lower = mean - qt(0.975, n-1) * sd / sqrt(n),"
                        )
                        metric_lines.append(
                            f"    ci_upper = mean + qt(0.975, n-1) * sd / sqrt(n)"
                        )
                        metric_lines.append(f"  )")
                    else:
                        metric_lines.append(
                            f"mean(.mm_num(data${r_name}), na.rm = TRUE)"
                        )
                        metric_lines.append(
                            f"sd(.mm_num(data${r_name}), na.rm = TRUE)"
                        )

                elif mt == "proportion":
                    prop_cfg = pe_cfg.get("proportion_config", {})
                    p_mode = prop_cfg.get("mode", "numeric")
                    if p_mode == "numeric":
                        op = prop_cfg.get("operator", ">=")
                        thresh = prop_cfg.get("threshold_numeric", 0)
                        cond = f"data${r_name} {op} {thresh}"
                    else:
                        vals = prop_cfg.get("threshold_values", [])
                        vals_str = ", ".join(f'"{_escape_r_string(v)}"' for v in vals)
                        cond = f"data${r_name} %in% c({vals_str})"
                    metric_lines.append(
                        f"{r_name}_valid <- data${r_name}[!is.na(data${r_name})]"
                    )
                    if p_mode == "numeric":
                        metric_lines.append(
                            f"count_meeting <- sum({r_name}_valid {op} {thresh})"
                        )
                    else:
                        metric_lines.append(
                            f"count_meeting <- sum({r_name}_valid %in% c({vals_str}))"
                        )
                    metric_lines.append(
                        f"prop.test(count_meeting, length({r_name}_valid), correct = FALSE)"
                    )

                elif mt == "domain_aggregate" and is_domain_ref:
                    # #293: emit a per-dataset breakdown + clarifying comment
                    # for cross-dataset domains; single-dataset path unchanged.
                    did_for_r = r_name_to_domain_id.get(r_name)
                    members_by_ds = (
                        all_domain_members_by_dataset_map.get(did_for_r)
                        if did_for_r is not None
                        else None
                    )
                    metric_lines.extend(
                        _emit_domain_aggregate_r_lines(members_by_ds, r_name)
                    )

                metric_lines.append("")
        except Exception as exc:
            metric_lines.append(
                f"# Error generating R code: {_escape_r_string(str(exc))}"
            )
            metric_lines.append("")

    # Supplement with human-origin MetricDefinitions not already covered
    for hm in human_metrics:
        try:
            hm_cfg = json.loads(hm.config) if isinstance(hm.config, str) else hm.config
            if not isinstance(hm_cfg, dict):
                hm_cfg = {}
        except (json.JSONDecodeError, TypeError):
            hm_cfg = {}

        # Resolve input source to R-name
        if hm.input_source_type == "dataset_column":
            hm_r = _col_r(hm.input_source_id)
            if not hm_r:
                continue
        elif hm.input_source_type == "dataset_domain":
            d_name = all_domain_name_map.get(hm.input_source_id)
            if not d_name or hm.input_source_id not in all_domain_members_map:
                continue
            hm_r = f"domains${_make_r_identifier(d_name)}"
        else:
            continue

        hm_grp_r = _col_r(hm.grouping_column_id)
        hm_grp2_r = _col_r(hm.grouping_column_id_2)
        dedup_key = (hm.metric_type, hm_r, hm_grp_r, hm_grp2_r, hm.grouping_mode)
        if dedup_key in emitted_analyses:
            continue
        emitted_analyses.add(dedup_key)

        hm_label = human_metric_labels.get(
            (hm.input_source_type, hm.input_source_id), hm.name
        )
        metric_lines.append(f"# Metric: {_escape_r_string(hm_label)}")
        if hm.metric_type == "mean":
            metric_lines.append(f"mean(.mm_num(data${hm_r}), na.rm = TRUE)")
            metric_lines.append(f"sd(.mm_num(data${hm_r}), na.rm = TRUE)")
        elif hm.metric_type == "frequency_distribution":
            metric_lines.append(f"table(data${hm_r})")
        metric_lines.append("")

    if metric_lines:
        toc_sections.append("Metric computation")
        r_lines.append("# ---- Metric computation ----")
        r_lines.append("# Reproduces saved analyses from Mixed Measures.")
        r_lines.extend(metric_lines)

    # Statistical tests section
    test_lines: list[str] = []

    for st in stat_tests:
        try:
            if st.test_type in ("cronbachs_alpha", "split_half"):
                # Target is analysis_domain
                dom_name = all_domain_name_map.get(st.target_id)
                dom_members = all_domain_members_map.get(st.target_id, [])
                if not dom_name or not dom_members:
                    test_lines.append(
                        f"# Skipped {st.test_type}: domain {st.target_id} not found"
                    )
                    test_lines.append("")
                    continue
                dom_slug = _make_r_identifier(dom_name)
                members_str = ", ".join(f'"{m}"' for m in dom_members)

                if st.test_type == "cronbachs_alpha":
                    needs_psych = True
                    test_lines.append(
                        f"# Cronbach's alpha: {_escape_r_string(dom_name)}"
                    )
                    test_lines.append(
                        f'psych::alpha(.mm_num(data[, c({members_str})]), check.keys = FALSE)'
                    )
                else:  # split_half
                    needs_psych = True
                    test_lines.append(
                        f"# Split-half reliability: {_escape_r_string(dom_name)}"
                    )
                    test_lines.append("# Odd-even split, Spearman-Brown corrected")
                    test_lines.append(
                        f"sh_items <- c({members_str})"
                    )
                    test_lines.append(
                        "sh_half1 <- sh_items[c(TRUE, FALSE)]"
                    )
                    test_lines.append(
                        "sh_half2 <- sh_items[c(FALSE, TRUE)]"
                    )
                    test_lines.append(
                        "sh_h1 <- rowMeans(.mm_num(data[, sh_half1]), na.rm = FALSE)"
                    )
                    test_lines.append(
                        "sh_h2 <- rowMeans(.mm_num(data[, sh_half2]), na.rm = FALSE)"
                    )
                    test_lines.append(
                        'sh_r <- cor(sh_h1, sh_h2, use = "complete.obs")'
                    )
                    test_lines.append(
                        "sh_sb <- (2 * sh_r) / (1 + sh_r)"
                    )
                    test_lines.append(
                        'cat("Split-half r:", sh_r, "Spearman-Brown:", sh_sb, "\\n")'
                    )
                test_lines.append("")

            elif st.test_type in ("independent_t_test", "one_way_anova"):
                # Target is metric_definition
                target_metric = db.query(MetricDefinition).get(st.target_id)
                if not target_metric:
                    test_lines.append(
                        f"# Skipped {st.test_type}: metric {st.target_id} not found"
                    )
                    test_lines.append("")
                    continue

                # Resolve metric input source to R-name
                if target_metric.input_source_type == "dataset_column":
                    tm_r = _col_r(target_metric.input_source_id)
                elif target_metric.input_source_type == "dataset_domain":
                    d_name = all_domain_name_map.get(target_metric.input_source_id)
                    if d_name and target_metric.input_source_id in all_domain_members_map:
                        tm_r = _make_r_identifier(d_name) + "_score"
                    else:
                        tm_r = None
                else:
                    tm_r = None

                tm_grp_r = _col_r(target_metric.grouping_column_id)
                if not tm_r or not tm_grp_r:
                    test_lines.append(
                        f"# Skipped {st.test_type}: could not resolve metric/grouping columns"
                    )
                    test_lines.append("")
                    continue

                if st.test_type == "independent_t_test":
                    test_lines.append(
                        f"# Independent t-test: {_escape_r_string(tm_r)} by {_escape_r_string(tm_grp_r)}"
                    )
                    test_lines.append(
                        "# Welch's t-test (same as scipy.stats.ttest_ind)"
                    )
                    test_lines.append(
                        f"t.test({tm_r} ~ {tm_grp_r}, data = data, var.equal = FALSE)"
                    )
                else:  # one_way_anova
                    test_lines.append(
                        f"# One-way ANOVA: {_escape_r_string(tm_r)} by {_escape_r_string(tm_grp_r)}"
                    )
                    test_lines.append(
                        f"aov_result <- aov({tm_r} ~ {tm_grp_r}, data = data)"
                    )
                    test_lines.append("summary(aov_result)")
                    test_lines.append("TukeyHSD(aov_result)")
                test_lines.append("")

        except Exception as exc:
            test_lines.append(
                f"# Error generating test code: {_escape_r_string(str(exc))}"
            )
            test_lines.append("")

    if test_lines:
        toc_sections.append("Statistical tests")
        r_lines.append("# ---- Statistical tests ----")
        r_lines.extend(test_lines)

    # Comparisons and correlations section
    rc_lines: list[str] = []

    for pe in quant_materials:
        if pe.source_tab not in ("comparisons", "correlations"):
            continue
        try:
            pe_cfg = json.loads(pe.config) if isinstance(pe.config, str) else pe.config
            if not isinstance(pe_cfg, dict):
                continue
        except (json.JSONDecodeError, TypeError):
            continue

        pe_name = pe.custom_name or pe.auto_name

        if pe.source_tab == "correlations":
            col_ids = pe_cfg.get("column_ids") or []
            dom_ids = pe_cfg.get("domain_ids") or []
            corr_type = pe_cfg.get("corr_type", "pearson")
            bonf = pe_cfg.get("bonferroni", False)

            var_r_names, skipped = _resolve_ids_to_r(col_ids)
            for did in dom_ids:
                d_name = all_domain_name_map.get(did)
                if d_name:
                    var_r_names.append(_make_r_identifier(d_name) + "_score")

            if len(var_r_names) < 2:
                continue

            rc_lines.append(f"# Correlation: {_escape_r_string(pe_name)}")
            vars_str = ", ".join(f'"{v}"' for v in var_r_names)
            rc_lines.append(f"cor_vars <- c({vars_str})")
            rc_lines.append(
                f'cor(.mm_num(data[, cor_vars]), use = "pairwise.complete.obs", method = "{corr_type}")'
            )
            if needs_psych:
                rc_lines.append(
                    f'psych::corr.test(.mm_num(data[, cor_vars]), method = "{corr_type}"'
                    + (', adjust = "bonferroni"' if bonf else '')
                    + ')'
                )
            else:
                rc_lines.append("# Pairwise p-values:")
                rc_lines.append("for (i in 1:(length(cor_vars)-1)) {")
                rc_lines.append("  for (j in (i+1):length(cor_vars)) {")
                rc_lines.append(
                    f'    ct <- cor.test(data[[cor_vars[i]]], data[[cor_vars[j]]], method = "{corr_type}")'
                )
                rc_lines.append(
                    '    cat(cor_vars[i], "vs", cor_vars[j], ": r =", ct$estimate, ", p =", ct$p.value, "\\n")'
                )
                rc_lines.append("  }")
                rc_lines.append("}")
                if bonf:
                    rc_lines.append(
                        f"# Bonferroni correction: multiply p-values by {len(var_r_names) * (len(var_r_names) - 1) // 2}"
                    )
            rc_lines.append("")

        elif pe.source_tab == "comparisons":
            col_ids = pe_cfg.get("column_ids") or []
            dom_ids = pe_cfg.get("domain_ids") or []
            compare_by = pe_cfg.get("compare_by")
            nonparam = pe_cfg.get("nonparametric", False)
            test_type = pe_cfg.get("test_type", "auto")
            exclude_grps = pe_cfg.get("exclude_groups") or []

            grp_r = _col_r(compare_by)
            if not grp_r:
                rc_lines.append(
                    f"# Skipped comparison: grouping column {compare_by} not found"
                )
                rc_lines.append("")
                continue

            var_r_names, skipped = _resolve_ids_to_r(col_ids)
            for did in dom_ids:
                d_name = all_domain_name_map.get(did)
                if d_name:
                    var_r_names.append(_make_r_identifier(d_name) + "_score")

            if not var_r_names:
                continue

            rc_lines.append(f"# Comparison: {_escape_r_string(pe_name)}")

            # Subset if exclude_groups
            data_ref = "data"
            if exclude_grps:
                excl_str = ", ".join(f'"{_escape_r_string(g)}"' for g in exclude_grps)
                rc_lines.append(
                    f"comp_data <- data[!(data${grp_r} %in% c({excl_str})), ]"
                )
                data_ref = "comp_data"

            # Determine the effective group count the way the tool does, so the
            # non-parametric path emits the test the user actually ran: a 2-group
            # comparison is Mann-Whitney (R `wilcox.test` defaults reproduce the
            # app's scipy.stats.mannwhitneyu exactly), 3+ is Kruskal-Wallis. Count
            # uses load_grouping_values (recognized N/A excluded, #384) minus the
            # explicitly excluded groups — a raw distinct-value count would
            # miscount N/A-class labels as a group and emit the wrong test.
            nonparam_two_group = False
            if nonparam:
                grp_col = db.get(DatasetColumn, compare_by)
                if grp_col is not None:
                    grp_row_ids = [
                        rid for (rid,) in db.query(DatasetRow.id)
                        .filter(DatasetRow.dataset_id == grp_col.dataset_id).all()
                    ]
                    grp_vals = load_grouping_values(
                        db, compare_by, grp_row_ids, project_id=project.id
                    )
                    effective_groups = set(grp_vals.values()) - set(exclude_grps)
                    nonparam_two_group = len(effective_groups) == 2

            for vr in var_r_names:
                if nonparam:
                    rc_lines.append(
                        f"# Non-parametric test: {vr} by {grp_r}"
                    )
                    if nonparam_two_group:
                        rc_lines.append(
                            "# Mann-Whitney U (wilcox.test defaults match the app's"
                            " scipy.stats.mannwhitneyu)"
                        )
                        rc_lines.append(
                            f"wilcox.test({vr} ~ {grp_r}, data = {data_ref})"
                        )
                    else:
                        rc_lines.append(
                            f"kruskal.test({vr} ~ {grp_r}, data = {data_ref})"
                        )
                else:
                    if test_type in ("t_test", "auto"):
                        rc_lines.append(
                            f"# Parametric test: {vr} by {grp_r}"
                        )
                        rc_lines.append(
                            f"t.test({vr} ~ {grp_r}, data = {data_ref}, var.equal = FALSE)"
                        )
                        rc_lines.append(
                            f"# (If 3+ groups, use: aov({vr} ~ {grp_r}, data = {data_ref}) %>% summary())"
                        )
                    else:
                        rc_lines.append(
                            f"aov_result <- aov({vr} ~ {grp_r}, data = {data_ref})"
                        )
                        rc_lines.append("summary(aov_result)")
                        rc_lines.append("TukeyHSD(aov_result)")
            rc_lines.append("")

    if rc_lines:
        toc_sections.append("Comparisons and correlations")
        r_lines.append("# ---- Comparisons and correlations ----")
        r_lines.extend(rc_lines)

    # Cross-tabulation section
    xtab_lines: list[str] = []

    for pe in quant_materials:
        try:
            pe_cfg = json.loads(pe.config) if isinstance(pe.config, str) else pe.config
            if not isinstance(pe_cfg, dict):
                continue
        except (json.JSONDecodeError, TypeError):
            continue

        xtab_col_id = pe_cfg.get("cross_tab_column_id")
        if not xtab_col_id:
            continue

        col_ids = pe_cfg.get("column_ids") or []
        if not col_ids:
            continue

        row_r = _col_r(col_ids[0])
        col_r = _col_r(xtab_col_id)
        if not row_r or not col_r:
            xtab_lines.append(
                f"# Skipped cross-tab: column IDs {col_ids[0]}/{xtab_col_id} not found"
            )
            xtab_lines.append("")
            continue

        pe_name = pe.custom_name or pe.auto_name
        xtab_lines.append(f"# Cross-tabulation: {_escape_r_string(pe_name)}")
        xtab_lines.append(f"cross_tab <- table(data${row_r}, data${col_r})")
        xtab_lines.append("print(cross_tab)")
        xtab_lines.append("chisq.test(cross_tab)")
        xtab_lines.append("# Cramer's V")
        xtab_lines.append(
            "sqrt(chisq.test(cross_tab)$statistic / (nrow(data) * (min(dim(cross_tab)) - 1)))"
        )
        xtab_lines.append("")

    if xtab_lines:
        toc_sections.append("Cross-tabulation")
        r_lines.append("# ---- Cross-tabulation ----")
        r_lines.extend(xtab_lines)

    # Charts section (ggplot2)
    _VISUAL_CHART_TYPES = {"horizontal_bar", "vertical_bar", "heatmap", "dumbbell"}
    _HEATMAP_GRADIENT_HIGH = {
        "green": "#16a34a", "blue": "#2563eb", "red": "#dc2626",
        "purple": "#7c3aed", "amber": "#d97706",
    }
    chart_lines: list[str] = []

    for pe in quant_materials:
        if pe.material_type not in _VISUAL_CHART_TYPES:
            continue
        if pe.source_tab != "descriptives":
            continue
        try:
            pe_cfg = json.loads(pe.config) if isinstance(pe.config, str) else pe.config
            if not isinstance(pe_cfg, dict):
                continue
        except (json.JSONDecodeError, TypeError):
            continue

        mt = pe_cfg.get("metric_type")
        if not mt:
            continue

        col_ids = pe_cfg.get("column_ids") or []
        dom_ids = pe_cfg.get("domain_ids") or []
        grp_id = pe_cfg.get("grouping_column_id")
        grp_r = _col_r(grp_id)
        pe_name = pe.custom_name or pe.auto_name
        chart_type = pe.material_type
        is_horiz = chart_type == "horizontal_bar"

        # Resolve target columns
        target_r_names, _ = _resolve_ids_to_r(col_ids)
        for did in dom_ids:
            d_members = all_domain_members_map.get(did)
            d_name = all_domain_name_map.get(did)
            if d_members and d_name:
                target_r_names.append(
                    ("domain", _make_r_identifier(d_name), d_members)
                )
        # Normalize: plain strings become ("column", r_name, None)
        targets = []
        for t in target_r_names:
            if isinstance(t, tuple):
                targets.append(t)
            else:
                targets.append(("column", t, None))

        if not targets:
            continue

        # Extract formatting
        fmt = pe_cfg.get("formatting") or {}
        palette_name = fmt.get("colorPalette", "default")
        title = pe_cfg.get("title")
        subtitle = pe_cfg.get("subtitle")
        footnote = pe_cfg.get("footnote")
        show_ci = pe_cfg.get("showCI", False)
        show_n = pe_cfg.get("showChartN", False)
        sort_order = pe_cfg.get("sort", "none")
        custom_order = pe_cfg.get("custom_order")
        hidden_responses = pe_cfg.get("hiddenResponseOptions") or []
        exclude_vals = pe_cfg.get("exclude_values") or []
        heatmap_preset = fmt.get("heatmapPreset", "green")
        base_size = fmt.get("axisFontSize", 12)
        title_size = fmt.get("titleFontSize", 16)
        bar_size = fmt.get("barSize", 24)
        point_size = fmt.get("pointSize", 5)
        ref_line = fmt.get("referenceLine")
        x_min = fmt.get("xAxisMin")
        x_max = fmt.get("xAxisMax")

        try:
            chart_lines.append(f"# ---- Chart: {_escape_r_string(pe_name)} ----")
            needs_ggplot2 = True
            needs_dplyr = True

            # ---------- HEATMAP ----------
            if chart_type == "heatmap" and mt == "frequency_distribution":
                col_r_list = [t[1] for t in targets if t[0] == "column"]
                if not col_r_list:
                    chart_lines.append("# Skipped: no columns resolved")
                    chart_lines.append("")
                    continue
                cols_str = ", ".join(f'"{c}"' for c in col_r_list)
                chart_lines.append(f"hm_cols <- c({cols_str})")

                # Filter hidden responses
                if hidden_responses:
                    hr_str = ", ".join(
                        f'"{_escape_r_string(v)}"' for v in hidden_responses
                    )
                    chart_lines.append(f"hm_hide <- c({hr_str})")

                chart_lines.append(
                    "hm_long <- do.call(rbind, lapply(hm_cols, function(col) {"
                )
                chart_lines.append(
                    "  tbl <- prop.table(table(data[[col]])) * 100"
                )
                chart_lines.append(
                    "  data.frame(variable = col, value = names(tbl),"
                )
                chart_lines.append(
                    "             pct = as.numeric(tbl), stringsAsFactors = FALSE)"
                )
                chart_lines.append("}))")
                if hidden_responses:
                    chart_lines.append(
                        "hm_long <- hm_long[!(hm_long$value %in% hm_hide), ]"
                    )

                # Gradient
                high_color = _HEATMAP_GRADIENT_HIGH.get(heatmap_preset, "#16a34a")
                if heatmap_preset == "diverging_blue_red":
                    fill_scale = (
                        'scale_fill_gradient2(low = "#2563eb", mid = "white",'
                        ' high = "#dc2626", midpoint = 50)'
                    )
                else:
                    fill_scale = (
                        f'scale_fill_gradient(low = "white", high = "{high_color}")'
                    )

                chart_lines.append("")
                chart_lines.append(
                    "ggplot(hm_long, aes(x = value, y = variable, fill = pct)) +"
                )
                chart_lines.append('  geom_tile(color = "white") +')
                chart_lines.append(f"  {fill_scale} +")
                chart_lines.append(
                    '  geom_text(aes(label = sprintf("%.0f%%", pct)), size = 3) +'
                )
                labs_parts = ['x = NULL', 'y = NULL', 'fill = "%"']
                if title:
                    labs_parts.insert(
                        0, f'title = "{_escape_r_string(title)}"'
                    )
                if subtitle:
                    labs_parts.append(
                        f'subtitle = "{_escape_r_string(subtitle)}"'
                    )
                if footnote:
                    labs_parts.append(
                        f'caption = "{_escape_r_string(footnote)}"'
                    )
                chart_lines.append(
                    f"  labs({', '.join(labs_parts)}) +"
                )
                chart_lines.append(
                    f"  theme_minimal(base_size = {base_size})"
                )
                slug = _slugify(pe_name, max_len=40)
                chart_lines.append(
                    f'# ggsave("{slug}.pdf", width = 10, height = 6)'
                )
                chart_lines.append("")

            # ---------- DUMBBELL ----------
            elif chart_type == "dumbbell" and grp_r and mt in ("mean", "proportion"):
                col_r_list = [t[1] for t in targets if t[0] == "column"]
                if not col_r_list:
                    chart_lines.append("# Skipped: no columns resolved")
                    chart_lines.append("")
                    continue

                for cr in col_r_list:
                    chart_lines.append(f"db_data <- data %>%")
                    chart_lines.append(f"  filter(!is.na({cr})) %>%")
                    chart_lines.append(f"  group_by({grp_r}) %>%")
                    chart_lines.append(f"  summarise(")
                    chart_lines.append(
                        f"    mean = mean({cr}, na.rm = TRUE),"
                    )
                    chart_lines.append(
                        f"    n = sum(!is.na({cr}))"
                    )
                    chart_lines.append(f"  )")
                    chart_lines.append("")
                    chart_lines.append(
                        f"ggplot(db_data, aes(x = mean, y = {grp_r})) +"
                    )
                    chart_lines.append(
                        f"  geom_point(size = {point_size},"
                        f" color = mm_default_colors[1]) +"
                    )
                    if ref_line is not None:
                        chart_lines.append(
                            f"  geom_vline(xintercept = {ref_line},"
                            ' linetype = "dashed", color = "#9ca3af") +'
                        )
                    labs_parts = [f'x = "{_escape_r_string(cr)}"', "y = NULL"]
                    if title:
                        labs_parts.insert(
                            0, f'title = "{_escape_r_string(title)}"'
                        )
                    chart_lines.append(
                        f"  labs({', '.join(labs_parts)}) +"
                    )
                    chart_lines.append(
                        f"  theme_minimal(base_size = {base_size})"
                    )
                slug = _slugify(pe_name, max_len=40)
                chart_lines.append(
                    f'# ggsave("{slug}.pdf", width = 8, height = 6)'
                )
                chart_lines.append("")

            # ---------- BAR CHARTS (horizontal_bar / vertical_bar) ----------
            elif chart_type in ("horizontal_bar", "vertical_bar"):
                for ttype, tr_name, dom_members in targets:
                    # Frequency distribution bar
                    if mt == "frequency_distribution" and ttype == "column":
                        var_name = f"ch_{_slugify(tr_name, max_len=20)}"
                        chart_lines.append(
                            f"{var_name} <- as.data.frame(table(data${tr_name}))"
                        )
                        chart_lines.append(
                            f'names({var_name}) <- c("value", "count")'
                        )
                        chart_lines.append(
                            f"{var_name}$pct <- {var_name}$count"
                            f" / sum({var_name}$count) * 100"
                        )
                        if hidden_responses:
                            hr_str = ", ".join(
                                f'"{_escape_r_string(v)}"' for v in hidden_responses
                            )
                            chart_lines.append(
                                f"{var_name} <- {var_name}[!({var_name}$value"
                                f" %in% c({hr_str})), ]"
                            )
                        if exclude_vals:
                            ev_str = ", ".join(
                                f'"{_escape_r_string(v)}"' for v in exclude_vals
                            )
                            chart_lines.append(
                                f"{var_name} <- {var_name}[!({var_name}$value"
                                f" %in% c({ev_str})), ]"
                            )

                        # Sort
                        aes_x = "value"
                        if sort_order in ("desc", "data_desc"):
                            aes_x = "reorder(value, pct)"
                        elif sort_order in ("asc", "data_asc"):
                            aes_x = "reorder(value, -pct)"
                        elif sort_order == "custom" and custom_order:
                            co_str = ", ".join(
                                f'"{_escape_r_string(v)}"' for v in custom_order
                            )
                            chart_lines.append(
                                f'{var_name}$value <- factor({var_name}$value,'
                                f' levels = c({co_str}))'
                            )

                        chart_lines.append("")
                        chart_lines.append(
                            f"ggplot({var_name},"
                            f" aes(x = {aes_x}, y = pct)) +"
                        )
                        chart_lines.append(
                            f"  geom_col(fill = mm_default_colors[1],"
                            f" width = {bar_size / 30:.2f}) +"
                        )
                        if is_horiz:
                            chart_lines.append("  coord_flip() +")
                        labs_parts = [f'x = NULL', f'y = "Percentage"']
                        if title:
                            labs_parts.insert(
                                0, f'title = "{_escape_r_string(title)}"'
                            )
                        elif len(targets) == 1:
                            labs_parts.insert(
                                0,
                                f'title = "{_escape_r_string(tr_name)}"',
                            )
                        if subtitle:
                            labs_parts.append(
                                f'subtitle = "{_escape_r_string(subtitle)}"'
                            )
                        if footnote or show_n:
                            cap = _escape_r_string(footnote) if footnote else ""
                            if show_n:
                                cap = (cap + " " if cap else "") + f"N = nrow(data)"
                            labs_parts.append(f'caption = "{cap}"')
                        chart_lines.append(
                            f"  labs({', '.join(labs_parts)}) +"
                        )
                        chart_lines.append(
                            f"  theme_minimal(base_size = {base_size})"
                        )

                    # Scalar (mean/proportion) bar
                    elif mt in ("mean", "proportion") and ttype == "column":
                        if grp_r:
                            # Grouped bar
                            chart_lines.append(f"bar_data <- data %>%")
                            chart_lines.append(f"  filter(!is.na({tr_name})) %>%")
                            chart_lines.append(f"  group_by({grp_r}) %>%")
                            chart_lines.append(f"  summarise(")
                            chart_lines.append(
                                f"    value = mean({tr_name}, na.rm = TRUE),"
                            )
                            chart_lines.append(
                                f"    sd = sd({tr_name}, na.rm = TRUE),"
                            )
                            chart_lines.append(
                                f"    n = sum(!is.na({tr_name})),"
                            )
                            chart_lines.append(
                                "    ci_lower = value - qt(0.975, n-1) * sd / sqrt(n),"
                            )
                            chart_lines.append(
                                "    ci_upper = value + qt(0.975, n-1) * sd / sqrt(n)"
                            )
                            chart_lines.append(f"  )")
                            aes_x = grp_r
                            if sort_order in ("desc", "data_desc"):
                                aes_x = f"reorder({grp_r}, value)"
                            elif sort_order in ("asc", "data_asc"):
                                aes_x = f"reorder({grp_r}, -value)"
                        else:
                            # Ungrouped multi-column bar
                            chart_lines.append(
                                f"bar_data <- data.frame("
                            )
                            chart_lines.append(
                                f'  label = "{_escape_r_string(tr_name)}",'
                            )
                            chart_lines.append(
                                f"  value = mean(data${tr_name}, na.rm = TRUE)"
                            )
                            chart_lines.append(")")
                            aes_x = "label"

                        chart_lines.append("")
                        chart_lines.append(
                            f"ggplot(bar_data, aes(x = {aes_x}, y = value)) +"
                        )
                        chart_lines.append(
                            f"  geom_col(fill = mm_default_colors[1],"
                            f" width = {bar_size / 30:.2f}) +"
                        )
                        if show_ci and grp_r:
                            chart_lines.append(
                                "  geom_errorbar(aes(ymin = ci_lower,"
                                " ymax = ci_upper), width = 0.2) +"
                            )
                        if ref_line is not None:
                            chart_lines.append(
                                f"  geom_hline(yintercept = {ref_line},"
                                ' linetype = "dashed", color = "#9ca3af") +'
                            )
                        if is_horiz:
                            chart_lines.append("  coord_flip() +")
                        if x_min is not None or x_max is not None:
                            lo = str(x_min) if x_min is not None else "NA"
                            hi = str(x_max) if x_max is not None else "NA"
                            chart_lines.append(
                                f"  scale_y_continuous(limits = c({lo}, {hi})) +"
                            )
                        labs_parts = ["x = NULL", f'y = "Mean"']
                        if title:
                            labs_parts.insert(
                                0, f'title = "{_escape_r_string(title)}"'
                            )
                        chart_lines.append(
                            f"  labs({', '.join(labs_parts)}) +"
                        )
                        chart_lines.append(
                            f"  theme_minimal(base_size = {base_size})"
                        )

                    # Domain aggregate bar
                    elif mt == "domain_aggregate" and ttype == "domain":
                        if not dom_members:
                            chart_lines.append("# Skipped: no domain members resolved")
                            continue
                        members_str = ", ".join(
                            f'"{m}"' for m in dom_members
                        )
                        chart_lines.append(
                            f"dom_means <- colMeans(.mm_num(data[,"
                            f" c({members_str})]), na.rm = TRUE)"
                        )
                        chart_lines.append(
                            "dom_df <- data.frame(item = names(dom_means),"
                            " mean = as.numeric(dom_means))"
                        )
                        chart_lines.append("")
                        chart_lines.append(
                            "ggplot(dom_df, aes(x = reorder(item, mean),"
                            " y = mean)) +"
                        )
                        chart_lines.append(
                            f"  geom_col(fill = mm_default_colors[1]) +"
                        )
                        if is_horiz:
                            chart_lines.append("  coord_flip() +")
                        labs_parts = [
                            "x = NULL",
                            f'y = "Mean"',
                        ]
                        if title:
                            labs_parts.insert(
                                0, f'title = "{_escape_r_string(title)}"'
                            )
                        chart_lines.append(
                            f"  labs({', '.join(labs_parts)}) +"
                        )
                        chart_lines.append(
                            f"  theme_minimal(base_size = {base_size})"
                        )

                slug = _slugify(pe_name, max_len=40)
                chart_lines.append(
                    f'# ggsave("{slug}.pdf", width = 8, height = 6)'
                )
                chart_lines.append("")

            else:
                chart_lines.append(
                    f"# Chart type '{chart_type}' with metric_type '{mt}'"
                    " not yet supported for R export"
                )
                chart_lines.append("")

        except Exception as exc:
            chart_lines.append(
                f"# Error generating chart: {_escape_r_string(str(exc))}"
            )
            chart_lines.append("")

    if chart_lines:
        toc_sections.append("Charts")
        r_lines.append("# ---- Charts ----")
        # Shared color palettes
        r_lines.append("# Color palettes (from Mixed Measures)")
        r_lines.append(
            'mm_default_colors <- c("#3b82f6", "#8b5cf6", "#ec4899",'
            ' "#f97316", "#14b8a6", "#eab308", "#ef4444", "#22c55e",'
            ' "#6366f1", "#06b6d4", "#f43f5e", "#a855f7", "#f59e0b",'
            ' "#0ea5e9", "#84cc16", "#78716c")'
        )
        r_lines.append("")
        r_lines.extend(chart_lines)

    # Precision notes section
    has_analysis = bool(
        metric_lines or test_lines or rc_lines or xtab_lines or chart_lines
    )
    if has_analysis:
        toc_sections.append("Precision notes")
        r_lines.append("# ---- Precision notes ----")
        r_lines.append("# Mixed Measures computes statistics using Python (scipy, numpy).")
        r_lines.append("# Minor differences (typically 4th-6th decimal place) may occur vs R:")
        r_lines.append("#   - Welch's t-test: scipy.stats.ttest_ind vs R's t.test")
        r_lines.append("#   - Cronbach's alpha: custom implementation vs psych::alpha")
        r_lines.append("#   - Split-half: Spearman-Brown formula identical; minor float diffs")
        r_lines.append("#   - MCAR test: pooled pairwise covariance vs R naniar (different algorithm)")
        r_lines.append("#   - Rounding: Python uses banker's rounding; R >= 4.0 round-to-even")
        r_lines.append("# These differences do not affect substantive conclusions.")
        r_lines.append("#")
        r_lines.append(
            "# Only analyses saved as materials or explicitly created are included."
        )
        r_lines.append("# Unsaved ad-hoc analyses are not exported.")
        r_lines.append("#")
        r_lines.append(
            f'# Data exported: {now_utc.strftime("%Y-%m-%d %H:%M UTC")}'
        )
        for ds, _ in qualifying_datasets:
            ds_ts = ds.created_at.strftime("%Y-%m-%d") if ds.created_at else "unknown"
            r_lines.append(
                f"# Dataset '{_escape_r_string(ds.name)}' created: {ds_ts}"
            )
        r_lines.append("")

    # Update required_packages based on analysis section flags
    if needs_dplyr:
        required_packages.append("dplyr")
    if needs_psych:
        required_packages.append("psych")
    if needs_ggplot2:
        required_packages.append("ggplot2")
    pkgs_str = ", ".join(f'"{p}"' for p in required_packages)
    r_lines[pkg_line_index] = f"required_packages <- c({pkgs_str})"

    # Notes
    all_notes = []
    for ds_name in skipped_datasets:
        all_notes.append(
            f"# Dataset '{_escape_r_string(ds_name)}' skipped: no qualifying columns"
        )
    all_notes.extend(script_notes)

    if all_notes:
        toc_sections.append("Notes")
        r_lines.append("# ---- Notes ----")
        r_lines.extend(all_notes)
        r_lines.append("")

    # Codebook (qualitative codes & categories)
    qual_codes = db.query(Code).filter(Code.project_id == project.id).order_by(Code.numeric_id).all()
    if qual_codes:
        r_chain_map, _, r_categories = _build_category_tree_and_chains(db, project.id)

        # Build code counts per category
        code_seg_counts: dict[int, int] = {}
        if qual_codes:
            seg_count_rows = db.query(
                CodeApplication.code_id, func.count(CodeApplication.id)
            ).filter(
                CodeApplication.code_id.in_([c.id for c in qual_codes])
            ).group_by(CodeApplication.code_id).all()
            code_seg_counts = dict(seg_count_rows)

        toc_sections.append("Codebook (qualitative codes & categories)")
        r_lines.append("# ---- Codebook (qualitative codes & categories) ----")

        if r_categories:
            # Build children map for hierarchical display
            r_children_map: dict[int | None, list] = defaultdict(list)
            for cat in r_categories:
                r_children_map[cat.parent_id].append(cat)

            # Build cat→codes map
            cat_codes_map: dict[int | None, list] = defaultdict(list)
            for code in qual_codes:
                if not code.is_universal:
                    cat_codes_map[code.category_id].append(code)

            def write_category_tree(parent_id, indent_level):
                for cat in r_children_map.get(parent_id, []):
                    indent = "#   " + "    " * indent_level
                    cat_total = sum(
                        code_seg_counts.get(c.id, 0)
                        for c in cat_codes_map.get(cat.id, [])
                    )
                    r_lines.append(f"{indent}{cat.name} ({cat_total} segments)")
                    for code in cat_codes_map.get(cat.id, []):
                        seg = code_seg_counts.get(code.id, 0)
                        r_lines.append(f"{indent}    - {code.name} ({seg} seg)")
                    write_category_tree(cat.id, indent_level + 1)

            write_category_tree(None, 0)

        # Universal codes
        universals = [c for c in qual_codes if c.is_universal]
        if universals:
            r_lines.append("#   Universal Codes:")
            for code in universals:
                seg = code_seg_counts.get(code.id, 0)
                r_lines.append(f"#       - {code.name} ({seg} seg)")

        # Uncategorized codes
        uncategorized = [c for c in qual_codes if not c.is_universal and c.category_id is None]
        if uncategorized:
            r_lines.append("#   Uncategorized:")
            for code in uncategorized:
                seg = code_seg_counts.get(code.id, 0)
                r_lines.append(f"#       - {code.name} ({seg} seg)")

        r_lines.append("")

    # Insert TOC after header block
    if toc_sections:
        toc_block = ["# Table of contents:"]
        for sec_name in toc_sections:
            toc_block.append(f"#   - {sec_name}")
        toc_block.append("#")
        toc_block.append("")
        for i, line in enumerate(toc_block):
            r_lines.insert(toc_insert_index + i, line)

    # Assemble R script. NO UTF-8 BOM (#363): a leading BOM makes R fail to
    # parse the script ("unexpected input in '\ufeff'") under `R -f script.R`
    # / Rscript. (The BOM is still written on the companion .csv, where Excel
    # benefits from it and R's read_csv strips it.)
    r_script = "\n".join(r_lines) + "\n"

    return r_script


@router.get("/r-data")
async def export_r_data(
    project_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export analysis-ready data as a ZIP containing a CSV data matrix and
    a companion R script with factor levels, variable labels, and domain groupings."""

    # ── Step 1: Validate & load metadata ─────────────────────────────────
    project = _get_project_or_404(db, project_id, user.id)

    datasets = (
        db.query(Dataset)
        .filter(Dataset.project_id == project_id)
        .options(
            selectinload(Dataset.columns).selectinload(DatasetColumn.recode_definitions),
            selectinload(Dataset.columns).joinedload(DatasetColumn.equivalence_group),
        )
        .order_by(Dataset.name)
        .all()
    )

    if not datasets:
        raise HTTPException(status_code=400, detail="No datasets found for this project.")

    # Filter qualifying columns per dataset
    qualifying_datasets: list[tuple] = []
    skipped_datasets: list[str] = []
    for ds in datasets:
        qual_cols = [c for c in ds.columns if c.column_type in _R_EXPORT_TYPES]
        if qual_cols:
            qual_cols.sort(key=lambda c: (c.display_order or 999999, c.sequence_order))
            qualifying_datasets.append((ds, qual_cols))
        else:
            skipped_datasets.append(ds.name)

    if not qualifying_datasets:
        raise HTTPException(
            status_code=400,
            detail="No exportable data found. Project must have at least one dataset "
                   "with ordinal, nominal, binary, numeric, percentage, or demographic columns.",
        )

    # ── Step 2: Detect participant linkage ────────────────────────────────
    has_participants = (
        db.query(DatasetRow.id)
        .join(Dataset, DatasetRow.dataset_id == Dataset.id)
        .filter(Dataset.project_id == project_id, DatasetRow.participant_id != None)
        .limit(1)
        .first()
    ) is not None

    # ── Step 3: Build column name map ────────────────────────────────────
    is_multi_dataset = len(qualifying_datasets) > 1
    used_names: set[str] = set()

    col_meta: dict[int, dict] = {}  # col_id → {r_name, col, dataset, is_demographic}
    demographic_col_ids: list[int] = []
    item_col_ids: list[int] = []

    for ds, cols in qualifying_datasets:
        ds_slug = _slugify(ds.name, max_len=20)
        for col in cols:
            if col.column_code:
                base = _make_r_identifier(col.column_code)
            elif col.column_name:
                base = _make_r_identifier(col.column_name)
            else:
                base = _make_r_identifier(col.column_text)

            if is_multi_dataset:
                r_name = f"{ds_slug}__{base}"
            else:
                r_name = base

            # Ensure uniqueness
            candidate = r_name
            counter = 2
            while candidate in used_names:
                candidate = f"{r_name}_{counter}"
                counter += 1
            r_name = candidate
            used_names.add(r_name)

            is_demo = col.column_type == ColumnType.DEMOGRAPHIC
            col_meta[col.id] = {
                "r_name": r_name,
                "col": col,
                "dataset": ds,
                "is_demographic": is_demo,
            }
            if is_demo:
                demographic_col_ids.append(col.id)
            else:
                item_col_ids.append(col.id)

    all_qualifying_col_ids = demographic_col_ids + item_col_ids

    # ── Step 4: Load domain metrics & scores ─────────────────────────────
    domain_metrics = (
        db.query(MetricDefinition)
        .filter(
            MetricDefinition.project_id == project_id,
            MetricDefinition.metric_type == "domain_aggregate",
            MetricDefinition.input_source_type == "dataset_domain",
            MetricDefinition.grouping_column_id == None,
            MetricDefinition.grouping_column_id_2 == None,
            (MetricDefinition.grouping_mode == None)
            | (MetricDefinition.grouping_mode != "dataset"),
        )
        .all()
    )

    domain_score_cols: list[dict] = []
    domain_metric_ids: list[int] = []

    if domain_metrics:
        domain_ids = [m.input_source_id for m in domain_metrics]
        domain_rows = (
            db.query(AnalysisDomain.id, AnalysisDomain.name)
            .filter(AnalysisDomain.id.in_(domain_ids))
            .all()
        )
        domain_name_map = {did: dname for did, dname in domain_rows}

        for m in domain_metrics:
            dname = domain_name_map.get(m.input_source_id, f"domain_{m.input_source_id}")
            r_name = _slugify(dname, max_len=40) + "_score"
            if r_name[0].isdigit():
                r_name = "x_" + r_name
            candidate = r_name
            counter = 2
            while candidate in used_names:
                candidate = f"{r_name}_{counter}"
                counter += 1
            r_name = candidate
            used_names.add(r_name)

            domain_score_cols.append({
                "metric_id": m.id,
                "r_name": r_name,
                "domain_name": dname,
            })
            domain_metric_ids.append(m.id)

    # Batch-load row scores
    score_pivot: dict[int, dict[int, float | None]] = defaultdict(dict)
    if domain_metric_ids:
        scores = (
            db.query(
                RowScore.dataset_row_id,
                RowScore.metric_definition_id,
                RowScore.score,
            )
            .filter(RowScore.metric_definition_id.in_(domain_metric_ids))
            .all()
        )
        for row_id, metric_id, score in scores:
            score_pivot[row_id][metric_id] = score

    # ── Step 5: Load row data ────────────────────────────────────────────
    qualifying_ds_ids = [ds.id for ds, _ in qualifying_datasets]

    if has_participants:
        rows = (
            db.query(DatasetRow, Participant.identifier, Participant.role)
            .outerjoin(Participant, DatasetRow.participant_id == Participant.id)
            .filter(DatasetRow.dataset_id.in_(qualifying_ds_ids))
            .order_by(DatasetRow.dataset_id, DatasetRow.id)
            .all()
        )
        row_data = [(r, pid, prole) for r, pid, prole in rows]
    else:
        rows_q = (
            db.query(DatasetRow)
            .filter(DatasetRow.dataset_id.in_(qualifying_ds_ids))
            .order_by(DatasetRow.dataset_id, DatasetRow.id)
            .all()
        )
        row_data = [(r, None, None) for r in rows_q]

    ds_by_id = {ds.id: ds for ds, _ in qualifying_datasets}

    # Batch-load all values for qualifying columns
    value_pivot: dict[int, dict[int, tuple]] = defaultdict(dict)
    if all_qualifying_col_ids:
        values = (
            db.query(
                DatasetValue.row_id,
                DatasetValue.column_id,
                DatasetValue.value_text,
                DatasetValue.value_numeric,
            )
            .filter(DatasetValue.column_id.in_(all_qualifying_col_ids))
            .all()
        )
        for resp_id, col_id, vtext, vnum in values:
            value_pivot[resp_id][col_id] = (vtext, vnum)

    # ── Step 6: Load domain member mappings ──────────────────────────────
    # `domain_members_map` is the flat list (dom_id → [r_name, ...]) used by
    # the all-up colMeans aggregation. `domain_members_by_dataset_map` (#293)
    # is a parallel structure grouped by dataset name so cross-dataset
    # aggregations can emit a per-dataset breakdown alongside the all-up
    # aggregate. Single-dataset domains have a single entry in the grouped map.
    domain_members_map: dict[int, list[str]] = defaultdict(list)
    domain_members_by_dataset_map: dict[int, dict[str, list[str]]] = defaultdict(
        lambda: defaultdict(list)
    )
    if domain_metrics:
        metric_domain_ids = [m.input_source_id for m in domain_metrics]
        if metric_domain_ids:
            members = (
                db.query(AnalysisDomainMember.domain_id, AnalysisDomainMember.member_id)
                .filter(
                    AnalysisDomainMember.domain_id.in_(metric_domain_ids),
                    AnalysisDomainMember.member_type == "column",
                )
                .all()
            )
            for dom_id, member_id in members:
                if member_id in col_meta:
                    meta = col_meta[member_id]
                    domain_members_map[dom_id].append(meta["r_name"])
                    domain_members_by_dataset_map[dom_id][meta["dataset"].name].append(
                        meta["r_name"]
                    )

    # ── Step 7: Load equivalence group data (multi-dataset only) ─────────
    equiv_groups: list[dict] = []
    if is_multi_dataset:
        eq_groups = (
            db.query(EquivalenceGroup)
            .filter(EquivalenceGroup.project_id == project_id)
            .options(selectinload(EquivalenceGroup.columns))
            .all()
        )
        for eg in eq_groups:
            r_names = []
            for q in eg.columns:
                if q.id in col_meta:
                    r_names.append(col_meta[q.id]["r_name"])
            if len(r_names) > 1:
                equiv_groups.append({"label": eg.label, "r_names": r_names})

    # ── Step 7.5: Load analysis data for R export ──────────────────────
    # Broaden domain lookup to all domains (not just metric-referenced)
    all_domain_rows = (
        db.query(AnalysisDomain.id, AnalysisDomain.name)
        .filter(AnalysisDomain.project_id == project_id)
        .all()
    )
    all_domain_name_map: dict[int, str] = {did: dname for did, dname in all_domain_rows}
    all_domain_ids = [did for did, _ in all_domain_rows]

    all_domain_members_map: dict[int, list[str]] = defaultdict(list)
    all_domain_members_by_dataset_map: dict[int, dict[str, list[str]]] = defaultdict(
        lambda: defaultdict(list)
    )
    if all_domain_ids:
        all_dom_member_rows = (
            db.query(AnalysisDomainMember.domain_id, AnalysisDomainMember.member_id)
            .filter(
                AnalysisDomainMember.domain_id.in_(all_domain_ids),
                AnalysisDomainMember.member_type == "column",
            )
            .all()
        )
        for adm_dom_id, adm_member_id in all_dom_member_rows:
            if adm_member_id in col_meta:
                meta = col_meta[adm_member_id]
                all_domain_members_map[adm_dom_id].append(meta["r_name"])
                all_domain_members_by_dataset_map[adm_dom_id][meta["dataset"].name].append(
                    meta["r_name"]
                )

    # Human-origin metrics (explicitly created, not auto quick-compute)
    human_metrics = (
        db.query(MetricDefinition)
        .filter(
            MetricDefinition.project_id == project_id,
            MetricDefinition.origin == "human",
        )
        .all()
    )
    human_metric_labels = (
        resolve_input_source_labels(db, human_metrics) if human_metrics else {}
    )

    # Statistical tests with computed results
    stat_tests = (
        db.query(StatisticalTest)
        .filter(
            StatisticalTest.project_id == project_id,
            StatisticalTest.result_data != None,  # noqa: E711
        )
        .all()
    )

    # Quantitative materials (skip qual_ prefixed)
    r_materials = (
        db.query(Material)
        .join(MaterialCollection, Material.collection_id == MaterialCollection.id)
        .filter(MaterialCollection.project_id == project_id)
        .order_by(Material.display_order)
        .all()
    )
    quant_materials = [
        m for m in r_materials if not m.material_type.startswith("qual_")
    ]

    # ── Step 8: Assemble CSV ─────────────────────────────────────────────
    csv_output = io.StringIO()
    csv_output.write("\ufeff")  # UTF-8 BOM

    demo_cols = [col_meta[cid] for cid in demographic_col_ids]
    item_cols = [col_meta[cid] for cid in item_col_ids]

    header = ["record_id", "dataset"]
    if has_participants:
        header += ["participant_id", "participant_role"]
    header += [m["r_name"] for m in demo_cols]
    header += [m["r_name"] for m in item_cols]
    header += [d["r_name"] for d in domain_score_cols]

    writer = csv.writer(csv_output, lineterminator="\n")
    writer.writerow(header)

    n_records = 0
    fallback_counters: dict[int, int] = defaultdict(int)

    for row_obj, p_identifier, p_role in row_data:
        n_records += 1
        ds = ds_by_id.get(row_obj.dataset_id)
        if ds is None:
            continue

        resp_id = row_obj.row_identifier
        if not resp_id:
            ds_slug = _slugify(ds.name, max_len=20)
            fallback_counters[row_obj.dataset_id] += 1
            resp_id = f"{ds_slug}_{fallback_counters[row_obj.dataset_id]}"

        csv_row: list = [csv_safe(resp_id), csv_safe(ds.name)]
        if has_participants:
            csv_row += [csv_safe(p_identifier or ""), csv_safe(p_role or "")]

        row_values = value_pivot.get(row_obj.id, {})
        for m in demo_cols:
            vals = row_values.get(m["col"].id)
            # Demographic value_text is free-form respondent input; defang.
            csv_row.append(csv_safe(vals[0]) if vals and vals[0] is not None else "")

        for m in item_cols:
            vals = row_values.get(m["col"].id)
            if vals and vals[1] is not None:
                csv_row.append(vals[1])
            else:
                csv_row.append("")

        row_scores = score_pivot.get(row_obj.id, {})
        for d in domain_score_cols:
            score = row_scores.get(d["metric_id"])
            if score is not None:
                csv_row.append(round(score, 4))
            else:
                csv_row.append("")

        writer.writerow(csv_row)

    # ── Step 9: Generate R script ────────────────────────────────────────
    project_slug = _slugify(project.name, max_len=40)
    n_variables = len(header) - 2  # exclude record_id and dataset
    r_script = _build_r_script(
        db=db,
        project=project,
        project_slug=project_slug,
        qualifying_datasets=qualifying_datasets,
        col_meta=col_meta,
        domain_metrics=domain_metrics,
        domain_score_cols=domain_score_cols,
        domain_members_map=domain_members_map,
        domain_members_by_dataset_map=domain_members_by_dataset_map,
        n_records=n_records,
        n_variables=n_variables,
        skipped_datasets=skipped_datasets,
        is_multi_dataset=is_multi_dataset,
        equiv_groups=equiv_groups,
        used_names=used_names,
        all_domain_name_map=all_domain_name_map,
        all_domain_members_map=all_domain_members_map,
        all_domain_members_by_dataset_map=all_domain_members_by_dataset_map,
        human_metrics=human_metrics,
        human_metric_labels=human_metric_labels,
        stat_tests=stat_tests,
        quant_materials=quant_materials,
    )

    # ── Step 10: ZIP & stream ────────────────────────────────────────────
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{project_slug}_data.csv", csv_output.getvalue())
        zf.writestr(f"{project_slug}_setup.R", r_script)
    zip_buffer.seek(0)

    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"{project_slug}_r_export_{date_str}.zip".replace('"', "_")

    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
