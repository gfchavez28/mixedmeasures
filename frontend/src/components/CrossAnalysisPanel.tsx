import { useState, useMemo, useRef, useEffect, useId } from 'react'
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
import { availableLayerScopes, effectiveLayerScope, layerScopeLabel, showLayerPicker, type LayerScope } from '@/lib/coding-layers'
import { useProjectCoderKinds } from '@/hooks/useCoderCoverage'
import { useBlindMode } from '@/hooks/useBlindMode'
import BlindScopeNotice from '@/components/qualitative-analysis/BlindScopeNotice'
import { MODE_DISABLED_CLASS } from '@/lib/mode-disabled'
import {
  readyFilters,
  hasUnfinishedFilter,
  notComparedSentence,
  UNFINISHED_FILTER_REASON,
  FILTERS_REACH_NOTE,
} from '@/lib/subgroup-filters'

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
  // #989 / #1038 g — the layers this panel can offer; `machine` only once a model
  // has coded THIS project. It read the install-wide roster, so a model imported
  // into another project offered a Machine layer here that could return nothing.
  // No roster fallback while coverage loads: the preference lives in memory and
  // starts at `human`, so there is no saved choice to protect.
  const projectKinds = useProjectCoderKinds(projectId)
  const layerAvailability = useMemo(
    () => ({ consensusAvailable, hasMachineCoders: projectKinds.hasMachine }),
    [consensusAvailable, projectKinds.hasMachine],
  )
  // Derived so a layer is honoured ONLY while it is offered (consensus can stop
  // existing, a model can be archived) — no setState-in-effect. 🔴 It dropped the
  // Machine layer outright (#1038 g): choosing it sent `human`.
  const layerScope: LayerScope = effectiveLayerScope(layerScopePref, layerAvailability)
  // #1531 D99 (1.5.9) — the panel follows blind mode, as the analysis page does (DEC-G): while
  // it WITHHOLDS (the act, #964 — never the claim `blind`) every request, and so every count
  // and the CSV, is the viewer's own coding (the page's effective scope, #499), the coder
  // filter is not rendered, and the queries wait for `settled`. Before, the filter listed
  // colleagues BY NAME on a blind coder's screen and the counts were every coder's.
  const { blind, withholding, settled, toggleReveal } = useBlindMode(projectId)
  const self = user?.id ?? null
  const coderInclude = useMemo(
    () => withholding && self != null
      ? [self]
      : hiddenCoders.size === 0 ? undefined : coders.filter(c => !hiddenCoders.has(c.id)).map(c => c.id),
    [withholding, self, coders, hiddenCoders],
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

  // #1534 D103 — ONE decision of which filters count, for the comparison AND its CSV
  // (`lib/subgroup-filters.ts`): every filter when all are finished, else none.
  const comparedFilters = readyFilters(debouncedFilters)
  const filtersReady = comparedFilters !== null
  const unfinishedFilter = hasUnfinishedFilter(filters)

  // Filtered frequencies query
  const freqQuery = useQuery({
    queryKey: ['text-filtered-freq', projectId, columnIdsStr, filtersJSON, coderIncludeCsv, layerScope],
    queryFn: () => textAnalysisApi.filteredFrequencies(projectId, {
      column_ids: focalColumnIds,
      // Enabled only when `comparedFilters` is a list (D103's one decision).
      filters: comparedFilters ?? [],
      include_overall: true,
      coder_ids: coderIncludeArr,
      layer_scope: layerScope,
    }),
    // The four reads are server-scoped by the blind state: each waits for it (#964), and each
    // key carries the EFFECTIVE scope (`coderIncludeCsv`), so a reveal is a new key (#454).
    enabled: filtersReady && settled,
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
    enabled: crossColumnId !== null && settled,
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
    enabled: focalColumnIds.length > 0 && settled,
  })

  // Response length query
  const { data: lengthData, isLoading: lengthLoading } = useQuery({
    queryKey: ['text-length', projectId, columnIdsStr, coderIncludeCsv, layerScope],
    queryFn: () => textAnalysisApi.responseLength(projectId, {
      column_ids: columnIdsStr,
      coder_ids: coderIncludeCsv,
      layer_scope: layerScope,
    }),
    enabled: focalColumnIds.length > 0 && settled,
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

  // #1534 D103 — the export waits while a filter is unfinished: a file reading
  // "Filters: None" beside a visible filter is the claim the fix exists to stop.
  // Read off the LIVE list (the pills), not the debounced one, so the reason appears
  // as the filter does.
  const exportBlocked = !settled || unfinishedFilter
  const handleExport = () => {
    // #1531: the file follows the panel, so it waits for the same scope (`aria-disabled`
    // below says so; this refusal is what it does — #754).
    if (exportBlocked) return
    textAnalysisApi.exportCrossAnalysis(projectId, {
      column_ids: columnIdsStr,
      // 🔴 #1534: `filters_json` is the route's name. This sent `filters` from the day it
      // was written, which FastAPI dropped silently — the file never held the comparison.
      filters_json: comparedFilters ? JSON.stringify(comparedFilters) : undefined,
      coder_ids: coderIncludeCsv,
      layer_scope: layerScope,
    })
  }
  const exportReasonId = useId()
  const notCompared = freqData ? notComparedSentence(freqData.filter_scope.unfiltered_datasets) : null

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" role="region" aria-label="Cross-analysis">
      {/* Screen reader announcements */}
      <div aria-live="polite" className="sr-only">{srAnnouncement}</div>

      {/* #1531 D99 — the scope said once, with the logged reveal. Not under the consensus
          layer: one synthetic coder, viewable while blind (DEC-H), and no coder scope applies. */}
      <BlindScopeNotice blind={blind && layerScope !== 'consensus'} onReveal={toggleReveal} surface="cross_analysis">
        Blind mode is on — these counts and the CSV hold only your own coding.
      </BlindScopeNotice>

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
          {/* #1534 D108 — the filters reach the comparison only; nothing said so. */}
          {filters.length > 0 && (
            <p className="text-xs text-mm-text-muted mt-1">{FILTERS_REACH_NOTE}</p>
          )}
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
        {/* Per-coder filter is moot on the single consensus layer (UX-2), and not rendered
            while blind mode withholds (DEC-G, #1531 D99): it lists colleagues by name. */}
        {multiCoder && layerScope !== 'consensus' && !withholding && (
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
            notCompared={notCompared}
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
      <div className="flex justify-end items-center gap-3 pt-2">
        {unfinishedFilter && (
          <p id={exportReasonId} className="text-xs text-mm-text-muted min-w-0">{UNFINISHED_FILTER_REASON}</p>
        )}
        <Button
          variant="outline"
          size="sm"
          className={`text-xs gap-1 shrink-0 ${exportBlocked ? MODE_DISABLED_CLASS : ''}`}
          aria-disabled={exportBlocked || undefined}
          aria-describedby={unfinishedFilter ? exportReasonId : undefined}
          onClick={handleExport}
        >
          <Download className="w-3.5 h-3.5" />
          Export Cross-Analysis (CSV)
        </Button>
      </div>
    </div>
  )
}
