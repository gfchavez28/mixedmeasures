import {
  RefreshCw,
  TriangleAlert,
  ClipboardCheck,
  Download,
  Info,
  CircleCheck,
} from 'lucide-react'
import { dataQualityApi } from '@/lib/api'
import type { MissingSummaryResponse, MissingPatternsResponse, McarTestResponse } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import SegmentedControl from '@/components/ui/segmented-control'
import ChartExportWrapper from '@/components/charts/ChartExportWrapper'
import MissingSummaryTable from '@/components/data-quality/MissingSummaryTable'
import MissingBarChart from '@/components/data-quality/MissingBarChart'
import MissingPatternMatrix from '@/components/data-quality/MissingPatternMatrix'
import McarTestPanel from '@/components/data-quality/McarTestPanel'

// ── Sidebar ──────────────────────────────────────────────────────────────────

export interface DataQualitySidebarProps {
  dqView: 'summary' | 'bar' | 'patterns'
  dqIncludeNA: boolean
  dqIncludeEmpty: boolean
  dqSort: 'pct_missing' | 'name' | 'dataset'
  dqColumnIds: number[]
  dqIsMultiDataset: boolean
  dqHasNumericVars: boolean
  mcarIsPending: boolean
  mcarResult: McarTestResponse | null
  mcarError: Error | null
  onMcarRun: () => void
  setUrlParam: (key: string, value: string) => void
}

export function DataQualitySidebar(props: DataQualitySidebarProps) {
  const {
    dqView, dqIncludeNA, dqIncludeEmpty, dqSort,
    dqColumnIds, dqIsMultiDataset, dqHasNumericVars,
    mcarIsPending, mcarResult, mcarError, onMcarRun,
    setUrlParam,
  } = props

  return (
    <>
      {/* Missingness Definition */}
      <div className="px-3 py-3 border-b border-mm-border-subtle shrink-0 space-y-2">
        <div className="text-xs font-semibold text-mm-text-muted uppercase tracking-wider">Missingness Definition</div>
        <label className="flex items-center gap-2 text-xs text-mm-text cursor-pointer">
          <input
            type="checkbox"
            checked={dqIncludeEmpty}
            onChange={() => setUrlParam('dqIncludeEmpty', dqIncludeEmpty ? '0' : '')}
            className="rounded border-mm-border-medium accent-[hsl(var(--mm-accent))]"
          />
          Count blank/empty as missing
        </label>
        <label className="flex items-center gap-2 text-xs text-mm-text cursor-pointer">
          <input
            type="checkbox"
            checked={dqIncludeNA}
            onChange={() => setUrlParam('dqIncludeNA', dqIncludeNA ? '0' : '')}
            className="rounded border-mm-border-medium accent-[hsl(var(--mm-accent))]"
          />
          Count &ldquo;Don&apos;t know&rdquo; / &ldquo;N/A&rdquo; as missing
        </label>
      </div>

      {/* View Mode */}
      <div className="px-3 py-3 border-b border-mm-border-subtle shrink-0">
        <SegmentedControl
          options={[
            { value: 'summary', label: 'Summary' },
            { value: 'bar', label: 'Bar Chart' },
            { value: 'patterns', label: 'Patterns' },
          ]}
          value={dqView}
          onChange={(v) => setUrlParam('dqView', v)}
          ariaLabel="Data quality view"
          idPrefix="dqview"
        />
      </div>

      {/* Chart Options */}
      <div className="px-3 py-3 border-b border-mm-border-subtle shrink-0 space-y-2">
        <div className="text-xs font-semibold text-mm-text-muted uppercase tracking-wider">Options</div>
        {(dqView === 'summary' || dqView === 'bar') && (
          <div className="space-y-1.5">
            <div className="text-[11px] text-mm-text-muted">Sort</div>
            <Select
              value={dqSort}
              onValueChange={(v) => setUrlParam('dqSort', v === 'pct_missing' ? '' : v)}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pct_missing">% Missing</SelectItem>
                <SelectItem value="name">Variable Name</SelectItem>
                <SelectItem value="dataset">Dataset</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* MCAR Test */}
      <div className="px-3 py-3 border-b border-mm-border-subtle shrink-0">
        <McarTestPanel
          hasSelection={dqColumnIds.length > 0}
          isMultiDataset={dqIsMultiDataset}
          hasNumericVars={dqHasNumericVars}
          isPending={mcarIsPending}
          result={mcarResult}
          error={mcarError}
          onRun={onMcarRun}
        />
      </div>

      {/* Variable count */}
      <div className="px-3 py-2 text-[10px] text-mm-text-faint border-b border-mm-border-subtle">
        {dqColumnIds.length > 0
          ? `${dqColumnIds.length} variable${dqColumnIds.length !== 1 ? 's' : ''} selected`
          : 'Select variables to analyze missing data.'}
      </div>
    </>
  )
}

// ── Content ──────────────────────────────────────────────────────────────────

export interface DataQualityContentProps {
  pid: number
  hasDqSelection: boolean
  dqView: 'summary' | 'bar' | 'patterns'
  dqIncludeNA: boolean
  dqIncludeEmpty: boolean
  dqSort: 'pct_missing' | 'name' | 'dataset'
  dqColumnIds: number[]
  dqIsMultiDataset: boolean
  dqSummaryData: MissingSummaryResponse | undefined
  dqSummaryError: Error | null
  isDqSummaryFetching: boolean
  dqPatternsData: MissingPatternsResponse | undefined
  isDqPatternsFetching: boolean
  selectedDomainIds: Set<number>
  selectedColumnIds: Set<number>
  setUrlParam: (key: string, value: string) => void
}

export function DataQualityContent(props: DataQualityContentProps) {
  const {
    pid,
    hasDqSelection,
    dqView, dqIncludeNA, dqIncludeEmpty, dqSort,
    dqColumnIds, dqIsMultiDataset,
    dqSummaryData, dqSummaryError, isDqSummaryFetching,
    dqPatternsData, isDqPatternsFetching,
    selectedDomainIds, selectedColumnIds,
    setUrlParam,
  } = props

  if (!hasDqSelection) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-mm-text-faint">
        <ClipboardCheck className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm font-medium mb-1">Missing Data Diagnostics</p>
        <p className="text-xs">Select individual variables to analyze missing data patterns.</p>
        {selectedDomainIds.size > 0 && selectedColumnIds.size === 0 && (
          <p className="text-xs mt-2 text-amber-600 dark:text-amber-400">
            Select individual variables (not groups) to analyze missing data.
          </p>
        )}
      </div>
    )
  }

  if (dqSummaryError) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-red-500 dark:text-red-400">
        <TriangleAlert className="w-8 h-8 mb-2 opacity-60" />
        <p className="text-sm font-medium">Failed to load missing data summary</p>
        <p className="text-xs text-mm-text-faint mt-1">Try adjusting your variable selection or check the server logs.</p>
      </div>
    )
  }

  if (isDqSummaryFetching) {
    return (
      <div className="flex items-center justify-center py-16">
        <RefreshCw className="w-5 h-5 animate-spin text-mm-text-faint" />
      </div>
    )
  }

  if (!dqSummaryData) return null

  return (
    <>
      {/* Both toggles off hint */}
      {!dqIncludeNA && !dqIncludeEmpty && (
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-700 dark:text-amber-300">
          <TriangleAlert className="w-3.5 h-3.5 flex-shrink-0" />
          Both missingness definitions are disabled. Enable at least one to see results.
        </div>
      )}

      {/* No missing data */}
      {dqSummaryData.total_missing === 0 && (dqIncludeNA || dqIncludeEmpty) && (
        <div className="flex flex-col items-center justify-center py-12 text-emerald-600 dark:text-emerald-400">
          <CircleCheck className="w-8 h-8 mb-2 opacity-60" />
          <p className="text-sm font-medium">No missing data detected</p>
          <p className="text-xs text-mm-text-faint mt-1">
            All {dqSummaryData.total_cells} values are present across {dqSummaryData.variables.length} variables.
          </p>
        </div>
      )}

      {/* Toolbar */}
      {(dqSummaryData.total_missing > 0 || (!dqIncludeNA && !dqIncludeEmpty)) && (
        <div className="flex items-center gap-2" data-exclude-export="">
          <div className="flex-1 text-xs text-mm-text-muted">
            {dqSummaryData.overall_pct_missing.toFixed(1)}% missing overall ({dqSummaryData.total_missing.toLocaleString()} of {dqSummaryData.total_cells.toLocaleString()} cells)
          </div>
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-7"
            onClick={async () => {
              const blob = await dataQualityApi.summaryCsv(pid, {
                column_ids: dqColumnIds,
                include_na_as_missing: dqIncludeNA,
                include_empty_as_missing: dqIncludeEmpty,
              })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = 'missing_data_summary.csv'
              a.click()
              URL.revokeObjectURL(url)
            }}
          >
            <Download className="w-3 h-3 mr-1" /> CSV
          </Button>
        </div>
      )}

      {/* View content */}
      {dqView === 'summary' && dqSummaryData.variables.length > 0 && (
        <ChartExportWrapper title="Missing Data Summary">
          <MissingSummaryTable
            variables={dqSummaryData.variables}
            totalCells={dqSummaryData.total_cells}
            totalMissing={dqSummaryData.total_missing}
            overallPctMissing={dqSummaryData.overall_pct_missing}
            sortBy={dqSort}
            onSortChange={(f) => setUrlParam('dqSort', f === 'pct_missing' ? '' : f)}
          />
        </ChartExportWrapper>
      )}

      {dqView === 'bar' && dqSummaryData.variables.length > 0 && (
        <ChartExportWrapper title="Missing Data Bar Chart">
          <MissingBarChart
            variables={dqSummaryData.variables}
            sortBy={dqSort}
          />
        </ChartExportWrapper>
      )}

      {dqView === 'patterns' && (
        <>
          {dqIsMultiDataset ? (
            <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded text-xs text-blue-700 dark:text-blue-300">
              <Info className="w-3.5 h-3.5 flex-shrink-0" />
              Pattern analysis shows co-occurrence of missing values across variables. Select variables from a single dataset to view patterns.
            </div>
          ) : isDqPatternsFetching ? (
            <div className="flex items-center justify-center py-16">
              <RefreshCw className="w-5 h-5 animate-spin text-mm-text-faint" />
            </div>
          ) : dqPatternsData ? (
            <ChartExportWrapper title="Missing Data Patterns">
              <MissingPatternMatrix data={dqPatternsData} />
            </ChartExportWrapper>
          ) : null}
        </>
      )}
    </>
  )
}
