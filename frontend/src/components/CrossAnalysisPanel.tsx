import { useState, useMemo, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
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
import SubgroupFilterPanel from './SubgroupFilterPanel'
import FrequencyComparisonChart from './FrequencyComparisonChart'
import CrossTabTable from './CrossTabTable'
import CodeDensityPanel from './CodeDensityPanel'
import ResponseLengthPanel from './ResponseLengthPanel'

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
  const { data: freqData } = useQuery({
    queryKey: ['text-filtered-freq', projectId, columnIdsStr, filtersJSON],
    queryFn: () => textAnalysisApi.filteredFrequencies(projectId, {
      column_ids: focalColumnIds,
      filters: debouncedFilters,
      include_overall: true,
    }),
    enabled: filtersReady,
  })

  // Cross-tabulation query
  const { data: crossTabData, isLoading: crossTabLoading } = useQuery({
    queryKey: ['text-crosstab', projectId, columnIdsStr, crossColumnId],
    queryFn: () => textAnalysisApi.crossTabulation(projectId, {
      text_column_ids: focalColumnIds,
      cross_column_id: crossColumnId!,
    }),
    enabled: crossColumnId !== null,
  })

  // Code density query
  const { data: densityData, isLoading: densityLoading } = useQuery({
    queryKey: ['text-density', projectId, columnIdsStr, densityGroupColumnId],
    queryFn: () => textAnalysisApi.codeDensity(projectId, {
      column_ids: columnIdsStr,
      group_by_column_id: densityGroupColumnId ?? undefined,
    }),
    enabled: focalColumnIds.length > 0,
  })

  // Response length query
  const { data: lengthData, isLoading: lengthLoading } = useQuery({
    queryKey: ['text-length', projectId, columnIdsStr],
    queryFn: () => textAnalysisApi.responseLength(projectId, {
      column_ids: columnIdsStr,
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
      cross_column_id: crossColumnId ?? undefined,
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" role="region" aria-label="Cross-analysis">
      {/* Screen reader announcements */}
      <div aria-live="polite" className="sr-only">{srAnnouncement}</div>

      {/* Subgroup filters */}
      <SubgroupFilterPanel
        projectId={projectId}
        focalColumnIds={focalColumnIds}
        textColumns={textColumns}
        filters={filters}
        onFiltersChange={setFilters}
        matchCount={matchCount}
      />

      {/* Frequency comparison (only when filters are active) */}
      {filtersReady && (
        <FrequencyComparisonChart
          filtered={freqData?.filtered ?? { row_count: 0, text_count: 0, frequencies: [] }}
          overall={freqData?.overall ?? null}
          filterDescription={freqData?.filter_description ?? ''}
        />
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
          <CrossTabTable data={crossTabData ?? null} loading={crossTabLoading} />
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
