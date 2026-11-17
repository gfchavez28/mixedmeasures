/**
 * The saved results a joint display's rows stand beside their constructs (D165's different-unit
 * strand) — what each one is, its unit, and (when asked for) its own table — for the Compact and
 * Report views. The export reads the same three things in `canvas-export.ts::fetchDisplayReports`.
 *
 * - The Material ROWS come from `['materials-all', pid]`, the key the chart embeds and the
 *   Materials drawer read, and the variables from `['analysis-columns', pid]` — the chart embed's
 *   unscoped key (NAMES only, #1615: the builder and the variable picker read the viewer's
 *   marked list under `['analysis-columns', pid, scopeKey]`) — so an open canvas makes these
 *   cache reads. Neither runs when no row binds a result.
 * - A result's TABLE is `shapeChartTable`'s, the table a chart embed of the same Material
 *   exports, read only while something shows it (`wantTables`).
 * - 🔴 A list that has not answered is never read as "no longer in this project"
 *   (`list-load-state.md` §1): the state says `loading` / `failed`, and the report's
 *   `resultsUnread` carries a failure into the sentence.
 */
import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { materialsApi, metricsApi } from '@/lib/api'
import { shapeChartTable, type ExportTable, type TimelineExportLens } from '@/lib/canvas-export'
import { describeResult } from '@/lib/joint-display-results'
import type { JointDisplay } from '@/lib/joint-display'
import type { ReportResult } from '@/lib/joint-display-report'

export type ResultsStatus = 'none' | 'loading' | 'failed' | 'ready'

export interface DisplayResultsState {
  /** `none` = no row binds a result; `ready` = every bound one is described. */
  status: ResultsStatus
  /** Described results by Material id; a table still loading is `null` here (see `tables`). */
  results: Map<number, ReportResult>
  /** Per result's table: still loading, failed, or answered (its table may be null: none shaped). */
  tables: Map<number, 'loading' | 'failed' | 'ready'>
}

export function useDisplayResults(
  projectId: number,
  display: JointDisplay,
  lens: TimelineExportLens,
  wantTables: boolean,
): DisplayResultsState {
  const bound = useMemo(
    () => [...new Set(display.rows.flatMap(r => r.result_material_ids).filter((x): x is number => x != null))]
      .sort((a, b) => a - b),
    [display.rows],
  )
  const enabled = bound.length > 0
  const materialsQuery = useQuery({
    queryKey: ['materials-all', projectId],
    queryFn: () => materialsApi.listAllMaterials(projectId),
    enabled,
  })
  const columnsQuery = useQuery({
    queryKey: ['analysis-columns', projectId],
    queryFn: () => metricsApi.analysisColumns(projectId),
    staleTime: 60_000,
    enabled,
  })
  const materials = materialsQuery.data
  const columns = columnsQuery.data

  const described = useMemo(() => {
    if (!materials || !columns) return null
    const out: { result: ReturnType<typeof describeResult>; config: Record<string, unknown> }[] = []
    for (const id of bound) {
      const m = materials.find(x => x.id === id)
      if (m) out.push({ result: describeResult(m, columns), config: m.config ?? {} })
    }
    return out
  }, [materials, columns, bound])

  const placeable = (described ?? []).filter(d => d.result.unit != null)
  const tableQueries = useQueries({
    queries: placeable.map(d => ({
      queryKey: ['joint-display-result', projectId, d.result.materialId, lens.blind, lens.self],
      queryFn: (): Promise<ExportTable | null> =>
        shapeChartTable(projectId, { materialId: d.result.materialId, config: d.config }, lens).then(s => s.table ?? null),
      enabled: wantTables,
      staleTime: 60_000,
    })),
  })

  // Built each render: cheap, and `useQueries` hands back a new array every time anyway.
  if (!enabled) return { status: 'none', results: new Map(), tables: new Map() }
  const failed = (materials === undefined && materialsQuery.isError) || (columns === undefined && columnsQuery.isError)
  if (failed) return { status: 'failed', results: new Map(), tables: new Map() }
  if (!described) return { status: 'loading', results: new Map(), tables: new Map() }
  const results = new Map<number, ReportResult>()
  const tables = new Map<number, 'loading' | 'failed' | 'ready'>()
  const byId = new Map(placeable.map((d, i) => [d.result.materialId, tableQueries[i]]))
  for (const d of described) {
    const q = byId.get(d.result.materialId)
    results.set(d.result.materialId, { ...d.result, table: q?.data ?? null })
    if (q) tables.set(d.result.materialId, q.data !== undefined ? 'ready' : q.isError ? 'failed' : 'loading')
  }
  return { status: 'ready', results, tables }
}
