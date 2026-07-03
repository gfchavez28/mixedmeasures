import { useState, useMemo } from 'react'
import { useListKeyboardNav } from '@/hooks/useListKeyboardNav'
import { SELECTED_ROW } from '@/lib/selection'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Search, Link2, Layers, Table2 } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  metricsApi,
  AnalysisColumnItem,
  AnalysisDatasetGroup,
  AnalysisDomainItem,
  AnalysisDomainResponse,
  MetricDefinitionSummaryResponse,
} from '@/lib/api'
import DomainPickerDetail from '@/components/analysis/DomainPickerDetail'

export type PickerMode = 'columns' | 'domains'

interface ColumnPickerProps {
  projectId: number
  mode: PickerMode
  onModeChange: (mode: PickerMode) => void
  selectedColumnIds: Set<number>
  selectedDomainIds: Set<number>
  onToggleColumn: (id: number) => void
  onToggleDomain: (id: number) => void
  onSelectAllDataset: (datasetId: number, columnIds: number[], select: boolean) => void
  expandedDatasetId: number | null
  onToggleDataset: (datasetId: number) => void
  onViewAcrossDatasets?: (domainId: number) => void
  onEditColumn?: (column: AnalysisColumnItem) => void
  // Phase 4.7/4.8 — DomainPickerDetail inline expansion
  domainsFull?: AnalysisDomainResponse[]
  metrics?: MetricDefinitionSummaryResponse[]
  onCreateScoreMetric?: (domainId: number) => void
  isCreatingScoreMetric?: boolean
  selectedMetricIdHint?: number | null
  onPickMetric?: (metricId: number) => void
}

export function ColumnPicker({
  projectId,
  mode,
  onModeChange,
  selectedColumnIds,
  selectedDomainIds,
  onToggleColumn,
  onToggleDomain,
  onSelectAllDataset,
  expandedDatasetId,
  onToggleDataset,
  onViewAcrossDatasets,
  onEditColumn,
  domainsFull,
  metrics,
  onCreateScoreMetric,
  isCreatingScoreMetric,
  selectedMetricIdHint,
  onPickMetric,
}: ColumnPickerProps) {
  const [search, setSearch] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['analysis-columns', projectId],
    queryFn: () => metricsApi.analysisColumns(projectId),
    staleTime: 60_000,
  })

  // Build equivalence info: highlight set + sibling dataset names map + view-across eligibility
  const equivInfo = useMemo(() => {
    const highlighted = new Set<number>()
    const siblingDatasets = new Map<number, string[]>()
    const viewAcrossDomain = new Map<number, number>()

    if (!data) return { highlighted, siblingDatasets, viewAcrossDomain }

    const allColumns = data.datasets.flatMap(ds => ds.columns)

    // Build equiv_group_id → columns map
    const equivMap = new Map<number, AnalysisColumnItem[]>()
    for (const q of allColumns) {
      if (q.equivalence_group_id) {
        const arr = equivMap.get(q.equivalence_group_id)
        if (arr) arr.push(q)
        else equivMap.set(q.equivalence_group_id, [q])
      }
    }

    // For each equiv group with 2+ members, build sibling dataset names
    for (const [, siblings] of equivMap) {
      if (siblings.length < 2) continue

      // Check highlight: if any sibling is selected, highlight the unselected ones
      const hasSelected = siblings.some(q => selectedColumnIds.has(q.id))
      if (hasSelected) {
        for (const q of siblings) {
          if (!selectedColumnIds.has(q.id)) highlighted.add(q.id)
        }
      }

      // Build sibling dataset names for each member
      for (const q of siblings) {
        const otherDatasets = siblings
          .filter(s => s.id !== q.id)
          .map(s => s.dataset_name)
        // Deduplicate (multiple siblings could be in the same dataset)
        siblingDatasets.set(q.id, [...new Set(otherDatasets)])
      }

      // Check "View across datasets" eligibility:
      // All siblings must share exactly one domain_id
      if (siblings.length >= 2) {
        // Collect all domain_ids across siblings
        const domainSets = siblings.map(q => new Set(q.domain_ids))
        // Find intersection of all domain sets
        let commonDomains = new Set(domainSets[0])
        for (let i = 1; i < domainSets.length; i++) {
          commonDomains = new Set([...commonDomains].filter(d => domainSets[i].has(d)))
        }
        // If exactly one shared domain, mark all siblings as eligible
        if (commonDomains.size === 1) {
          const domainId = [...commonDomains][0]
          for (const q of siblings) {
            viewAcrossDomain.set(q.id, domainId)
          }
        }
      }
    }

    return { highlighted, siblingDatasets, viewAcrossDomain }
  }, [data, selectedColumnIds])

  // Filter columns by search
  const filteredDatasets = useMemo(() => {
    if (!data) return []
    if (!search.trim()) return data.datasets
    const term = search.toLowerCase()
    return data.datasets
      .map(ds => ({
        ...ds,
        columns: ds.columns.filter(q =>
          (q.column_name || '').toLowerCase().includes(term) ||
          q.column_text.toLowerCase().includes(term) ||
          (q.column_code || '').toLowerCase().includes(term)
        ),
      }))
      .filter(ds => ds.columns.length > 0)
  }, [data, search])

  const filteredDomains = useMemo(() => {
    if (!data) return []
    if (!search.trim()) return data.domains
    const term = search.toLowerCase()
    return data.domains.filter(d => d.name.toLowerCase().includes(term))
  }, [data, search])

  if (isLoading) {
    return (
      <div className="p-3 text-sm text-mm-text-muted">Loading variables...</div>
    )
  }

  return (
    // #394: Tabs is the flex container so the two TabsContent panels live inside
    // it. Both use forceMount so the inactive trigger's auto-generated
    // aria-controls still references a mounted panel (Radix unmounts inactive
    // content by default → dangling aria-controls → aria-valid-attr-value fail).
    // The heavy view renders only when active; the inactive panel stays empty.
    <Tabs
      value={mode}
      onValueChange={v => onModeChange(v as PickerMode)}
      className="flex flex-col flex-1 min-h-0"
    >
      {/* Mode toggle */}
      <div className="px-3 pt-2 shrink-0">
        <TabsList className="h-7 w-full">
          <TabsTrigger value="columns" className="text-xs flex-1 h-5 px-2">
            Variables
          </TabsTrigger>
          <TabsTrigger value="domains" className="text-xs flex-1 h-5 px-2">
            Groups
          </TabsTrigger>
        </TabsList>
      </div>

      {/* Search */}
      <div className="px-3 pt-2 pb-1 shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mm-text-faint" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={mode === 'columns' ? 'Search variables...' : 'Search groups...'}
            aria-label={mode === 'columns' ? 'Search variables by name, text, or code' : 'Search groups by name'}
            className="w-full pl-7 pr-2 py-1.5 text-xs border rounded-md bg-mm-surface text-mm-text border-mm-border-subtle focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Content */}
      <TabsContent
        value="columns"
        forceMount
        className={`mt-0 ${mode === 'columns' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}`}
      >
        {mode === 'columns' && (
          <ColumnsView
            projectId={projectId}
            datasets={filteredDatasets}
            selectedColumnIds={selectedColumnIds}
            equivInfo={equivInfo}
            expandedDatasetId={expandedDatasetId}
            onToggleColumn={onToggleColumn}
            onToggleDataset={onToggleDataset}
            onSelectAllDataset={onSelectAllDataset}
            onViewAcrossDatasets={onViewAcrossDatasets}
            onEditColumn={onEditColumn}
          />
        )}
      </TabsContent>
      <TabsContent
        value="domains"
        forceMount
        className={`mt-0 ${mode === 'domains' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}`}
      >
        {mode === 'domains' && (
          <DomainsView
            domains={filteredDomains}
            selectedDomainIds={selectedDomainIds}
            onToggleDomain={onToggleDomain}
            domainsFull={domainsFull}
            metrics={metrics}
            onCreateScoreMetric={onCreateScoreMetric}
            isCreatingScoreMetric={isCreatingScoreMetric}
            selectedMetricIdHint={selectedMetricIdHint}
            onPickMetric={onPickMetric}
          />
        )}
      </TabsContent>
    </Tabs>
  )
}

// ── Types ────────────────────────────────────────────────────────────────────

interface EquivInfo {
  highlighted: Set<number>
  siblingDatasets: Map<number, string[]>
  viewAcrossDomain: Map<number, number>
}

// ── Columns View ───────────────────────────────────────────────────────────

function ColumnsView({
  projectId,
  datasets,
  selectedColumnIds,
  equivInfo,
  expandedDatasetId,
  onToggleColumn,
  onToggleDataset,
  onSelectAllDataset,
  onViewAcrossDatasets,
  onEditColumn,
}: {
  projectId: number
  datasets: AnalysisDatasetGroup[]
  selectedColumnIds: Set<number>
  equivInfo: EquivInfo
  expandedDatasetId: number | null
  onToggleColumn: (id: number) => void
  onToggleDataset: (dsId: number) => void
  onSelectAllDataset: (datasetId: number, columnIds: number[], select: boolean) => void
  onViewAcrossDatasets?: (domainId: number) => void
  onEditColumn?: (column: AnalysisColumnItem) => void
}) {
  if (datasets.length === 0) {
    return <div className="px-3 py-2 text-xs text-mm-text-faint italic">No variables found</div>
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {datasets.map(ds => {
        const isExpanded = ds.id === expandedDatasetId
        const dsColumnIds = ds.columns.map(q => q.id)
        const selectedCount = dsColumnIds.filter(id => selectedColumnIds.has(id)).length
        const allSelected = selectedCount === dsColumnIds.length && dsColumnIds.length > 0
        const someSelected = selectedCount > 0 && !allSelected

        return (
          <div
            key={ds.id}
            role="group"
            aria-label={`${ds.name}, ${ds.columns.length} items`}
            className={`flex flex-col ${isExpanded ? 'flex-1 min-h-0' : 'shrink-0'}`}
          >
            {/* Dataset header */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-mm-surface-hover cursor-pointer select-none shrink-0">
              <Checkbox
                checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                onCheckedChange={() => onSelectAllDataset(ds.id, dsColumnIds, !allSelected)}
                aria-label={`Select all variables in ${ds.name}`}
                className="shrink-0"
                onClick={e => e.stopPropagation()}
              />
              <button
                onClick={() => onToggleDataset(ds.id)}
                className="flex items-center gap-1 flex-1 min-w-0 text-left"
                aria-expanded={isExpanded}
              >
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-mm-text-faint shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-mm-text-faint shrink-0" />
                )}
                <span className="text-xs font-medium text-mm-text truncate">{ds.name}</span>
                <span className="text-xs text-mm-text-faint shrink-0">
                  ({ds.columns.length})
                  {selectedCount > 0 && (
                    <span className="text-primary font-medium ml-1">{selectedCount} sel.</span>
                  )}
                </span>
              </button>
              <a
                href={`/projects/${projectId}/datasets/${ds.id}`}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open ${ds.name} in Dataset View`}
                className="p-0.5 rounded hover:bg-mm-surface-hover transition-colors shrink-0"
                onClick={e => e.stopPropagation()}
              >
                <Table2 className="w-3 h-3 text-mm-text-faint" />
              </a>
            </div>

            {/* Column list — scrollable within constrained flex area */}
            {isExpanded && (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <ColumnListbox
                  projectId={projectId}
                  columns={ds.columns}
                  datasetName={ds.name}
                  selectedColumnIds={selectedColumnIds}
                  equivInfo={equivInfo}
                  onToggleColumn={onToggleColumn}
                  onViewAcrossDatasets={onViewAcrossDatasets}
                  onEditColumn={onEditColumn}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ColumnListbox({
  projectId,
  columns,
  datasetName,
  selectedColumnIds,
  equivInfo,
  onToggleColumn,
  onViewAcrossDatasets,
  onEditColumn,
}: {
  projectId: number
  columns: AnalysisColumnItem[]
  datasetName: string
  selectedColumnIds: Set<number>
  equivInfo: EquivInfo
  onToggleColumn: (id: number) => void
  onViewAcrossDatasets?: (domainId: number) => void
  onEditColumn?: (column: AnalysisColumnItem) => void
}) {
  const { focusedIndex, getItemProps, listProps } = useListKeyboardNav({
    itemCount: columns.length,
    onSelect: (i) => onToggleColumn(columns[i].id),
  })

  return (
    <div
      {...listProps}
      aria-label={`Variables in ${datasetName}`}
      className="outline-none"
    >
      {columns.map((q, i) => {
        const isSelected = selectedColumnIds.has(q.id)
        const isEquivHighlighted = equivInfo.highlighted.has(q.id)
        const siblingDatasetNames = equivInfo.siblingDatasets.get(q.id)
        const viewAcrossDomainId = isSelected ? equivInfo.viewAcrossDomain.get(q.id) : undefined
        const itemProps = getItemProps(i)

        return (
          <ColumnRow
            key={q.id}
            projectId={projectId}
            column={q}
            datasetName={datasetName}
            isSelected={isSelected}
            isEquivHighlighted={isEquivHighlighted}
            siblingDatasetNames={siblingDatasetNames}
            viewAcrossDomainId={viewAcrossDomainId}
            isFocused={focusedIndex === i}
            onToggle={() => onToggleColumn(q.id)}
            onMouseEnter={itemProps.onMouseEnter}
            onViewAcrossDatasets={onViewAcrossDatasets}
            onEditColumn={onEditColumn}
            dataFocused={itemProps['data-focused']}
          />
        )
      })}
    </div>
  )
}

function ColumnRow({
  projectId,
  column: q,
  datasetName,
  isSelected,
  isEquivHighlighted,
  siblingDatasetNames,
  viewAcrossDomainId,
  isFocused,
  onToggle,
  onMouseEnter,
  onViewAcrossDatasets,
  onEditColumn,
  dataFocused,
}: {
  projectId: number
  column: AnalysisColumnItem
  datasetName: string
  isSelected: boolean
  isEquivHighlighted: boolean
  siblingDatasetNames?: string[]
  viewAcrossDomainId?: number
  isFocused: boolean
  onToggle: () => void
  onMouseEnter: () => void
  onViewAcrossDatasets?: (domainId: number) => void
  onEditColumn?: (column: AnalysisColumnItem) => void
  dataFocused?: boolean
}) {
  const label = q.column_name || q.column_text
  const tooltip = `${datasetName}: ${q.column_text}`

  const equivTooltip = siblingDatasetNames?.length
    ? `This variable also appears in: ${siblingDatasetNames.join(', ')}`
    : undefined

  const showViewAcross = viewAcrossDomainId != null && onViewAcrossDatasets != null

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="option"
          aria-selected={isSelected}
          data-focused={dataFocused}
          className={`flex items-center gap-1.5 pl-8 pr-3 py-1 cursor-pointer hover:bg-mm-surface-hover ${
            isSelected ? SELECTED_ROW : ''
          } ${isEquivHighlighted ? 'bg-violet-50/50 dark:bg-violet-950/30' : ''} ${
            isFocused ? 'ring-1 ring-inset ring-primary/50' : ''
          }`}
          onClick={onToggle}
          onMouseEnter={onMouseEnter}
        >
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggle()}
            className="shrink-0"
            onClick={e => e.stopPropagation()}
            aria-label={label}
          />
          <div className="flex-1 min-w-0">
            <span
              className="text-xs text-mm-text line-clamp-2"
              title={tooltip}
            >
              {label}
            </span>
            {q.scale_labels && q.scale_labels.length > 0 && (
              <span
                className="text-[10px] text-mm-text-faint truncate block"
                title={q.scale_labels.join(' · ')}
              >
                {q.scale_labels.length}-pt: {q.scale_labels.join(' · ')}
              </span>
            )}
          </div>
          {(isEquivHighlighted || (isSelected && siblingDatasetNames?.length)) && (
            <span
              title={equivTooltip}
              aria-label={equivTooltip}
            >
              <Link2 className="w-3 h-3 text-violet-400 shrink-0" />
            </span>
          )}
          {showViewAcross && (
            <button
              title="View across datasets"
              aria-label={`View ${label} across all datasets as a variable group analysis`}
              className="p-0.5 rounded hover:bg-violet-100 dark:hover:bg-violet-900/40 transition-colors shrink-0"
              onClick={e => {
                e.stopPropagation()
                onViewAcrossDatasets!(viewAcrossDomainId!)
              }}
            >
              <Layers className="w-3 h-3 text-violet-500" />
            </button>
          )}
          <span className="text-[11px] text-mm-text-faint shrink-0">{q.column_type}</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onEditColumn && (
          <ContextMenuItem onClick={() => onEditColumn(q)}>
            Column Details...
          </ContextMenuItem>
        )}
        <ContextMenuItem asChild>
          <a
            href={`/projects/${projectId}/datasets/${q.dataset_id}/recode?column=${q.id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Edit in Recode Workbench
          </a>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ── Groups View ─────────────────────────────────────────────────────────────

function DomainsView({
  domains,
  selectedDomainIds,
  onToggleDomain,
  domainsFull,
  metrics,
  onCreateScoreMetric,
  isCreatingScoreMetric,
  selectedMetricIdHint,
  onPickMetric,
}: {
  domains: AnalysisDomainItem[]
  selectedDomainIds: Set<number>
  onToggleDomain: (id: number) => void
  domainsFull?: AnalysisDomainResponse[]
  metrics?: MetricDefinitionSummaryResponse[]
  onCreateScoreMetric?: (domainId: number) => void
  isCreatingScoreMetric?: boolean
  selectedMetricIdHint?: number | null
  onPickMetric?: (metricId: number) => void
}) {
  const { focusedIndex, getItemProps, listProps } = useListKeyboardNav({
    itemCount: domains.length,
    onSelect: (i) => onToggleDomain(domains[i].id),
  })

  // Index domainsFull by id so we can show inline detail without an O(n*m) scan
  // per render. Memo on the full list, not the filtered one — domainsFull is
  // stable while the user types into the search box.
  const fullById = useMemo(() => {
    const map = new Map<number, AnalysisDomainResponse>()
    for (const d of domainsFull ?? []) map.set(d.id, d)
    return map
  }, [domainsFull])

  // Pre-bucket metrics by their domain (`input_source_id` when type is
  // 'dataset_domain'). Avoids re-filtering inside each DomainPickerDetail mount.
  const metricsByDomain = useMemo(() => {
    const map = new Map<number, MetricDefinitionSummaryResponse[]>()
    for (const m of metrics ?? []) {
      if (m.input_source_type !== 'dataset_domain') continue
      const arr = map.get(m.input_source_id)
      if (arr) arr.push(m)
      else map.set(m.input_source_id, [m])
    }
    return map
  }, [metrics])

  if (domains.length === 0) {
    return <div className="px-3 py-2 text-xs text-mm-text-faint italic">No groups defined</div>
  }

  return (
    <div
      {...listProps}
      className="flex-1 min-h-0 overflow-y-auto pb-2 outline-none"
      aria-label="Variable groups"
    >
      {domains.map((d, i) => {
        const itemProps = getItemProps(i)
        const isSelected = selectedDomainIds.has(d.id)
        const fullDomain = fullById.get(d.id)
        const showDetail = isSelected && fullDomain != null && onCreateScoreMetric != null
        return (
        <div key={d.id}>
          <div
            role="option"
            aria-selected={isSelected}
            data-focused={itemProps['data-focused']}
            className={`flex items-start gap-1.5 px-3 py-1.5 cursor-pointer hover:bg-mm-surface-hover ${
              isSelected ? SELECTED_ROW : ''
            } ${focusedIndex === i ? 'ring-1 ring-inset ring-primary/50' : ''}`}
            onClick={() => onToggleDomain(d.id)}
            onMouseEnter={itemProps.onMouseEnter}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleDomain(d.id)}
              className="shrink-0 mt-0.5"
              onClick={e => e.stopPropagation()}
            />
            <div className="flex-1 min-w-0">
              <span className="text-xs text-mm-text leading-tight" title={d.name}>
                {d.name}
              </span>
              <div className="text-[11px] text-mm-text-faint leading-tight mt-0.5">
                {d.member_count} {d.member_count === 1 ? 'variable' : 'variables'} · {d.datasets.length} {d.datasets.length === 1 ? 'dataset' : 'datasets'}
              </div>
            </div>
          </div>
          {showDetail && (
            <DomainPickerDetail
              domain={fullDomain}
              domainMetrics={metricsByDomain.get(d.id) ?? []}
              selectedMetricIdHint={selectedMetricIdHint}
              onCreateScoreMetric={onCreateScoreMetric}
              isCreatingMetric={isCreatingScoreMetric ?? false}
              onPickMetric={onPickMetric}
            />
          )}
        </div>
        )
      })}
    </div>
  )
}
