import { useState, useMemo, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  textAnalysisApi,
  datasetsApi,
  type TextCodingColumn,
  type SubgroupFilter,
} from '@/lib/api'
import { CATEGORICAL_GROUPING_TYPES } from '@/lib/dataset-constants'
import { useCoders } from '@/hooks/useCoders'
import { useConsensusStatus } from '@/hooks/useConsensusStatus'
import { useAuth } from '@/lib/auth-context'
import CoderFilterPopover from './CoderFilterPopover'
import SegmentedControl from '@/components/ui/segmented-control'
import SubgroupFilterPanel from './SubgroupFilterPanel'
import FrequencyComparisonChart from './FrequencyComparisonChart'
import { useListLoad } from '@/hooks/useListLoad'
import { LoadState } from '@/components/LoadStatus'
import CrossTabTable from './CrossTabTable'
import CodeDensityPanel from './CodeDensityPanel'
import ResponseLengthPanel from './ResponseLengthPanel'
import { availableLayerScopes, layerScopeLabel, rosterHasMachineCoders, showLayerPicker, type LayerScope } from '@/lib/coding-layers'

interface CrossAnalysisPanelProps {
  projectId: number
  focalColumnIds: number[]
  textColumns: TextCodingColumn[]
}

export default function CrossAnalysisPanel({
  projectId,
  focalColumnIds,
  textColumns,
}: CrossAnalysisPanelProps) {
  const [filters, setFilters] = useState<SubgroupFilter[]>([])
  const [crossColumnId, setCrossColumnId] = useState<number | null>(null)
  const [densityGroupColumnId, setDensityGroupColumnId] = useState<number | null>(null)
  const [srAnnouncement, setSrAnnouncement] = useState('')

  // Per-coder visibility lens (Track J · J1, multi-coder only). In-memory hide-set;
  // map hide→include so default (nothing hidden) sends NOTHING (= all coders incl.
  // unattributed) and only an active filter restricts.
  const { coders, multiCoder } = useCoders()
  const { user } = useAuth()
  const [hiddenCoders, setHiddenCoders] = useState<Set<number>>(new Set())

  // Track J · J2 slab 3b — coding-layer selector (human coders vs derived consensus).
  // Offered only when a consensus layer exists for this project (DEC-A).
  const { data: consensusStatus } = useConsensusStatus(projectId)
  const consensusAvailable = !!consensusStatus?.exists
  const [layerScopePref, setLayerScopePref] = useState<LayerScope>('human')
  // #989 — the layers this panel can offer; `machine` only once one is on the roster.
  const layerAvailability = useMemo(
    () => ({ consensusAvailable, hasMachineCoders: rosterHasMachineCoders(coders) }),
    [consensusAvailable, coders],
  )
  // Derived so the consensus layer is honored ONLY while it exists (e.g. it's hidden
  // again if a coder is archived away from the ≥2 roster) — no setState-in-effect.
  const layerScope: LayerScope =
    layerScopePref === 'consensus' && consensusAvailable ? 'consensus' : 'human'
  const coderInclude = useMemo(
    () => hiddenCoders.size === 0 ? undefined : coders.filter(c => !hiddenCoders.has(c.id)).map(c => c.id),
    [coders, hiddenCoders],
  )
  const coderIncludeArr = coderInclude ?? null
  const coderIncludeCsv = coderInclude ? coderInclude.join(',') : undefined

  const columnIdsStr = focalColumnIds.join(',')

  // Debounce filters for queries
  const [debouncedFilters, setDebouncedFilters] = useState<SubgroupFilter[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedFilters(filters)
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [filters])

  const filtersJSON = JSON.stringify(debouncedFilters)

  // Only request if filters are non-empty and all have valid column_ids and values
  const filtersReady = debouncedFilters.length > 0 && debouncedFilters.every(f => {
    if (!f.column_id) return false
    if (['equals', 'in'].includes(f.operator) && (!f.values || f.values.length === 0)) return false
    if (['gte', 'lte'].includes(f.operator) && !f.value) return false
    return true
  })

  // Filtered frequencies query
  const freqQuery = useQuery({
    queryKey: ['text-filtered-freq', projectId, columnIdsStr, filtersJSON, coderIncludeCsv, layerScope],
    queryFn: () => textAnalysisApi.filteredFrequencies(projectId, {
      column_ids: focalColumnIds,
      filters: debouncedFilters,
      include_overall: true,
      coder_ids: coderIncludeArr,
      layer_scope: layerScope,
    }),
    enabled: filtersReady,
  })
  const freqData = freqQuery.data
  /**
   * #963 Tier 2 — `FrequencyComparisonChart` is handed `?? { frequencies: [] }`
   * and says *"No codes applied to matching comments."* of it, which is a claim
   * about the RESEARCHER'S FILTERS rather than about the request.
   *
   * ⚠️ Visible on ordinary use, not only on a cold load: every filter change is
   * a new query key, so the sentence reappears on each one — the shape #961
   * recorded for this page's own count.
   * ⚠️ The DISABLED case is decided by the mount below (`filtersReady`), which
   * is the same flag this query is `enabled` on.
   */
  const freqLoad = useListLoad(freqQuery)

  // Cross-tabulation query
  const crossTabQuery = useQuery({
    queryKey: ['text-crosstab', projectId, columnIdsStr, crossColumnId, coderIncludeCsv, layerScope],
    queryFn: () => textAnalysisApi.crossTabulation(projectId, {
      text_column_ids: focalColumnIds,
      cross_column_id: crossColumnId!,
      coder_ids: coderIncludeArr,
      layer_scope: layerScope,
    }),
    enabled: crossColumnId !== null,
  })
  const crossTabData = crossTabQuery.data
  /**
   * #963 Tier 3 — the child rendered `null` for three different facts (see its
   * own comment). The decision belongs here because this is where the query is,
   * and because the DISABLED case has to be answered first: with no cross-tab
   * variable chosen the query is off with nothing cached, which `listStatus`
   * reports as `loading` forever.
   */
  const crossTabLoad = useListLoad(crossTabQuery)

  // Code density query
  const { data: densityData, isLoading: densityLoading } = useQuery({
    queryKey: ['text-density', projectId, columnIdsStr, densityGroupColumnId, coderIncludeCsv, layerScope],
    queryFn: () => textAnalysisApi.codeDensity(projectId, {
      column_ids: columnIdsStr,
      group_by_column_id: densityGroupColumnId ?? undefined,
      coder_ids: coderIncludeCsv,
      layer_scope: layerScope,
    }),
    enabled: focalColumnIds.length > 0,
  })

  // Response length query
  const { data: lengthData, isLoading: lengthLoading } = useQuery({
    queryKey: ['text-length', projectId, columnIdsStr, coderIncludeCsv, layerScope],
    queryFn: () => textAnalysisApi.responseLength(projectId, {
      column_ids: columnIdsStr,
      coder_ids: coderIncludeCsv,
      layer_scope: layerScope,
    }),
    enabled: focalColumnIds.length > 0,
  })

  // Get columns for cross-tab and density group-by selectors
  const focalDatasetIds = useMemo(() => {
    const ids = new Set<number>()
    for (const cc of textColumns) {
      if (focalColumnIds.includes(cc.column_id)) ids.add(cc.dataset_id)
    }
    return Array.from(ids)
  }, [textColumns, focalColumnIds])

  const { data: allColumnsData } = useQuery({
    queryKey: ['project-columns', projectId],
    queryFn: () => datasetsApi.allColumns(projectId),
    enabled: !!projectId,
  })

  const crossTabColumns = useMemo(() => {
    if (!allColumnsData) return []
    return allColumnsData.columns.filter(q => {
      if (!focalDatasetIds.includes(q.dataset_id)) return false
      return CATEGORICAL_GROUPING_TYPES.includes(q.column_type)
    })
  }, [allColumnsData, focalDatasetIds])

  const groupByColumns = useMemo(() => {
    if (!allColumnsData) return []
    return allColumnsData.columns.filter(q => {
      if (!focalDatasetIds.includes(q.dataset_id)) return false
      return CATEGORICAL_GROUPING_TYPES.includes(q.column_type)
    })
  }, [allColumnsData, focalDatasetIds])

  // Match count for SubgroupFilterPanel
  const matchCount = freqData && filtersReady
    ? { records: freqData.filtered.row_count, comments: freqData.filtered.text_count }
    : null

  const handleExport = () => {
    textAnalysisApi.exportCrossAnalysis(projectId, {
      column_ids: columnIdsStr,
      filters: debouncedFilters.length > 0 ? JSON.stringify(debouncedFilters) : undefined,
      coder_ids: coderIncludeCsv,
      layer_scope: layerScope,
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" role="region" aria-label="Cross-analysis">
      {/* Screen reader announcements */}
      <div aria-live="polite" className="sr-only">{srAnnouncement}</div>

      {/* Subgroup filters + per-coder lens (multi-coder only) */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <SubgroupFilterPanel
            projectId={projectId}
            focalColumnIds={focalColumnIds}
            textColumns={textColumns}
            filters={filters}
            onFiltersChange={setFilters}
            matchCount={matchCount}
          />
        </div>
        {showLayerPicker(layerAvailability) && (
          <div className="pt-1 shrink-0 flex items-center gap-2">
            <SegmentedControl
              options={availableLayerScopes(layerAvailability).map(value => ({
                value,
                label: layerScopeLabel(value),
              }))}
              value={layerScope}
              onChange={setLayerScopePref}
              ariaLabel="Coding layer"
              idPrefix="text-layer"
            />
            {layerScope === 'consensus' && (consensusStatus?.stale_count ?? 0) > 0 && (
              <span
                className="inline-flex items-center gap-1 text-xs text-mm-text-muted"
                title="Recent coding changed; the consensus layer is recomputing in the background."
              >
                <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                Consensus may be out of date
              </span>
            )}
          </div>
        )}
        {/* Per-coder filter is moot on the single consensus layer (UX-2). */}
        {multiCoder && layerScope !== 'consensus' && (
          <div className="pt-1 shrink-0">
            <CoderFilterPopover
              coders={coders}
              activeCoderId={user?.id ?? null}
              hidden={hiddenCoders}
              onChange={setHiddenCoders}
            />
          </div>
        )}
      </div>

      {/* Frequency comparison (only when filters are active) */}
      {filtersReady && (
        freqLoad.status !== 'ready' ? (
          <LoadState
            load={freqLoad}
            loadingLabel="Counting codes for these filters…"
            failedTitle="The filtered code counts could not be loaded"
          />
        ) : (
          <FrequencyComparisonChart
            filtered={freqData!.filtered}
            overall={freqData!.overall ?? null}
            filterDescription={freqData!.filter_description}
          />
        )
      )}

      {/* Cross-tabulation */}
      <div className="border rounded-lg bg-mm-surface p-4">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-sm font-medium">Cross-tabulation</h3>
          <Select
            value={crossColumnId !== null ? String(crossColumnId) : undefined}
            onValueChange={v => {
              const val = Number(v)
              setCrossColumnId(val)
              const col = crossTabColumns.find(c => c.id === val)
              if (col) setSrAnnouncement(`Cross-tabulation by ${col.column_name || col.column_text}`)
            }}
          >
            <SelectTrigger className="h-8 text-sm flex-1 min-w-0" aria-label="Cross-tab variable">
              <SelectValue placeholder="Select cross-tab variable..." />
            </SelectTrigger>
            <SelectContent>
              {crossTabColumns.map(c => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.column_name || c.column_text} ({c.dataset_name})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {crossColumnId && (
          crossTabLoad.status !== 'ready' || !crossTabData ? (
            <LoadState
              load={crossTabLoad}
              loadingLabel="Loading cross-tabulation…"
              failedTitle="The cross-tabulation could not be loaded."
              size="panel"
            />
          ) : (
            <CrossTabTable data={crossTabData} />
          )
        )}
      </div>

      {/* Code density + Response length side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          {/* Density group-by selector */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-mm-text-muted">Group by:</span>
            <Select
              value={densityGroupColumnId !== null ? String(densityGroupColumnId) : '__none'}
              onValueChange={v => setDensityGroupColumnId(v === '__none' ? null : Number(v))}
            >
              <SelectTrigger className="h-7 text-xs flex-1 min-w-0" aria-label="Group density by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">None</SelectItem>
                {groupByColumns.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.column_name || c.column_text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <CodeDensityPanel data={densityData ?? null} loading={densityLoading} />
        </div>
        <ResponseLengthPanel data={lengthData ?? null} loading={lengthLoading} />
      </div>

      {/* Export */}
      <div className="flex justify-end pt-2">
        <Button variant="outline" size="sm" className="text-xs gap-1" onClick={handleExport}>
          <Download className="w-3.5 h-3.5" />
          Export Cross-Analysis (CSV)
        </Button>
      </div>
    </div>
  )
}
