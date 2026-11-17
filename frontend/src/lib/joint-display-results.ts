/**
 * The joint display's DIFFERENT-UNIT strand (D165's third kind, ROADMAP row 56): a saved result
 * whose rows are not the display's participants — e.g. a comparison of post-test scores by
 * school, beside teachers grouped by gain. It stands BESIDE its construct: drawn once across
 * the group columns, labelled with its unit, never split by group or merged into a group's cell
 * (a school-level result cannot be put into teacher groups without the many-to-one join #827 (3)
 * declined).
 *
 * 🔴 **The unit is DERIVED, never typed** (D165): it is read from the result's own settings —
 * the datasets its variables come from, and the variable(s) it groups by — so the label checks
 * something. MM does not know a dataset's rows are "students"; it says "rows of <dataset>".
 *
 * What a row binds is a Material id (`row.result_material_ids`, remapped by
 * `joint_display_node.py`); the Material ROW is read live, as the Materials drawer reads it, so a
 * deleted result reads as missing rather than as a stale copy. Its numbers are its own table,
 * shaped by the chart export's own `shapeChartTable` — the table a chart embed of the same result
 * prints — so the display and the embed cannot disagree about it.
 *
 * Slice 1 offers QUANTITATIVE results only (a comparison, a cross-tabulation, a descriptive
 * summary). A correlation is refused on the Canvas (#831), so it is not offered; a qualitative
 * result counts passages or sources, and its unit statement waits for slice 2 with observation
 * strands.
 */
import type { AnalysisColumnsResponse, MaterialResponse } from '@/lib/api'
import { columnsWithDemographics } from '@/lib/analysis-column-lists'
import { isQualitativeMaterialConfig } from '@/lib/material-kind'
import {
  extractComputeParams, extractCrossTabParams, quantChartKind, type QuantChartKind,
} from '@/components/canvas/inline-chart-params'

/** The kinds a display may stand beside a construct, and how a sentence names each. */
const KIND_TEXT: Partial<Record<QuantChartKind, string>> = {
  comparison: 'a saved comparison',
  cross_tab: 'a saved cross-tabulation',
  metric: 'a saved summary',
}

export interface DisplayResult {
  materialId: number
  /** The researcher's name for it, else the app's. */
  name: string
  kind: QuantChartKind
  /** "a saved comparison" — for a sentence. */
  kindText: string
  /**
   * "rows of Student post-test, by School" — derived from its source (D165). Null for a result
   * slice 1 cannot place (a qualitative or correlation result bound by an import or an older
   * build): its unit is not stated rather than guessed.
   */
  unit: string | null
}

export function materialName(m: Pick<MaterialResponse, 'custom_name' | 'auto_name'>): string {
  return (m.custom_name ?? '').trim() || m.auto_name
}

/** Whether a saved result can stand beside a construct (slice 1: quantitative, drawable). */
export function isDisplayResult(m: Pick<MaterialResponse, 'config'>): boolean {
  const config = m.config ?? {}
  if (isQualitativeMaterialConfig(config)) return false
  return KIND_TEXT[quantChartKind(config)] != null
}

function list(names: string[]): string {
  const u = [...new Set(names.filter(Boolean))]
  if (u.length <= 1) return u[0] ?? ''
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`
}

/**
 * The unit a saved result counts, from its own settings and the project's variables.
 * The grouping keys are each kind's own (`compare_by` for a comparison, `grouping_column_id`
 * for a summary — `inline-chart-params.ts` reads the same ones; a cross-tab's two axes).
 */
export function resultUnit(config: Record<string, unknown>, columns: AnalysisColumnsResponse): string {
  // #1638: demographic columns too — the Quantitative page's *Compare by* offers exactly those,
  // and from `datasets[].columns` alone a comparison by one read "a variable no longer in this project".
  const byId = columnsWithDemographics(columns)
  const name = (id: number | null | undefined) => {
    if (id == null) return null
    const c = byId.get(id)
    return c ? (c.column_name || c.column_text || `Column ${id}`) : 'a variable no longer in this project'
  }
  const kind = quantChartKind(config)
  const { columnIds, domainIds, groupingColumnId, groupingColumnId2 } = extractComputeParams(config)
  const datasets = [
    ...columnIds.map(id => byId.get(id)?.dataset_name ?? ''),
    ...domainIds.flatMap(id => columns.domains.find(d => d.id === id)?.datasets ?? []),
  ]
  const where = list(datasets) ? `rows of ${list(datasets)}` : 'rows of a dataset no longer in this project'

  if (kind === 'cross_tab') {
    const ct = extractCrossTabParams(config).request
    return ct ? `${where}, ${name(ct.row_column_id)} by ${name(ct.col_column_id)}` : where
  }
  const by = kind === 'comparison'
    ? [name(config.compare_by as number | undefined), name(config.compare_by_2 as number | undefined)]
    : [name(groupingColumnId), name(groupingColumnId2)]
  const groups = by.filter((x): x is string => x != null)
  return groups.length ? `${where}, by ${list(groups)}` : where
}

export function describeResult(m: MaterialResponse, columns: AnalysisColumnsResponse): DisplayResult {
  const config = m.config ?? {}
  const kind = quantChartKind(config)
  return {
    materialId: m.id,
    name: materialName(m),
    kind,
    kindText: KIND_TEXT[kind] ?? 'a saved result',
    unit: isDisplayResult(m) ? resultUnit(config, columns) : null,
  }
}

/** The bound ids a row holds, in order, once each (an import may leave a null — D202). */
export function boundResultIds(ids_: (number | null)[]): (number | null)[] {
  const seen = new Set<number>()
  const out: (number | null)[] = []
  for (const id of ids_) {
    if (id == null) { out.push(null); continue }
    if (!seen.has(id)) { seen.add(id); out.push(id) }
  }
  return out
}
