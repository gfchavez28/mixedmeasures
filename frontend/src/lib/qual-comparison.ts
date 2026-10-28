import type { CodeComparisonEntry, DemographicComparisonResponse } from '@/lib/api'
import type { ChartDataRow } from '@/lib/chart-types'

/** A comparison group whose share the server declined to compute, and why. */
export interface UndefinedComparisonGroup {
  group: string
  reason: string | null
}

/**
 * #1421 — the groups of a qualitative comparison that have no share to report.
 *
 * A group with no segments in the material compared used to arrive as `0.0`, so
 * the table printed "0.0%", the difference read as the other group's whole share,
 * and every code was ranked by it. The server now sends `proportion: null` with an
 * `undefined_reason`, keyed on the group's segment total, so it is the same for
 * every code of that group.
 *
 * ⚠️ Read from the cells the server marked, never re-derived from
 * `group_totals[g].total_segments === 0` here: the reason is the server's to give
 * (`statistics.md` §1), and a second derivation is how a table and its note start
 * to disagree.
 */
export function undefinedComparisonGroups(data: DemographicComparisonResponse): UndefinedComparisonGroup[] {
  const out: UndefinedComparisonGroup[] = []
  for (const group of data.groups) {
    const cell = data.codes.find(e => e.by_group[group] != null)?.by_group[group]
    if (cell && cell.proportion == null) out.push({ group, reason: cell.undefined_reason })
  }
  return out
}

/**
 * The comparison bar chart's rows: one per code, the bar per group is the COUNT
 * (a real 0 for a group with no segments), and `_prop_<group>` feeds the tooltip.
 *
 * 🔴 #1421: `_prop_<group>` is `null` when the server sent no share — never `?? 0`.
 * This line was `stats?.proportion ?? 0`, which the compiler cannot flag (it accepts
 * the new `null` silently) and which printed "(0.0%)" for a group with no segments.
 */
export function comparisonBarRows(entries: CodeComparisonEntry[], groups: string[]): ChartDataRow[] {
  return entries.map(entry => {
    const row: ChartDataRow = {
      label: entry.code_name.length > 28
        ? entry.code_name.slice(0, 25) + '…'
        : entry.code_name,
      _fullLabel: entry.code_name,
      _codeId: entry.code_id,
    }
    for (const g of groups) {
      const stats = entry.by_group[g]
      row[g] = stats?.count ?? 0
      row[`_prop_${g}`] = stats?.proportion ?? null
    }
    return row
  })
}
