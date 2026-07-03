/**
 * CrosswalkHeader — page-level header for the crosswalk view.
 *
 * Provides:
 *   - Full-grid search input (§2 item 33, sky highlight per §2 item 36)
 *   - Dataset visibility toggles (GAP 3.10, URL-synced via ?datasets=)
 *   - "Create variable group" + "Suggest Groups" action buttons (Phase 3/4)
 *
 * Phase 2 scaffolding: search and dataset toggles are functional. Create
 * and Suggest buttons are visible but disabled (wired in Phase 3/4).
 */

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Search,
  Plus,
  Sparkles,
  X,
  Inbox,
  ChevronsDownUp,
  ChevronsUpDown,
  HelpCircle,
  Eye,
  EyeOff,
  Download,
} from 'lucide-react'
// ChevronsDownUp = "collapse all" icon (chevrons pointing inward at center)
// ChevronsUpDown = "expand all"   icon (chevrons pointing outward from center)
import type { DatasetToggleState } from './useDatasetToggles'
import { cn } from '@/lib/utils'

interface DatasetOption {
  dataset_id: number
  dataset_name: string
}

interface CrosswalkHeaderProps {
  searchQuery: string
  onSearchChange: (q: string) => void
  onSearchClear: () => void
  datasets: DatasetOption[]
  toggleState: DatasetToggleState
  bracketCount: number
  /** Phase 3b — opens the "Create variable group" dialog */
  onCreateDomain?: () => void
  /** Phase 4 — kicks off Suggest Groups. Disabled when fewer than 2 datasets
   * or when the suggestions query is in flight. */
  onSuggestGroups?: () => void
  isSuggestLoading?: boolean
  datasetCount?: number
  /** Phase 3.5 — toggles the Unassigned panel visibility */
  panelOpen?: boolean
  onTogglePanel?: () => void
  /** #327 — count of currently collapsed brackets; used to disable the
   * Collapse-all / Expand-all buttons when there's nothing to do. */
  collapsedCount?: number
  onCollapseAll?: () => void
  onExpandAll?: () => void
  /** Master toggle for crosswalk dataset color dots. When `allDotsHidden`
   * is true, every column-header and cell dot renders as a faint hollow
   * ring regardless of per-dataset state. Per-dataset state is preserved
   * (not destroyed) so flipping back restores prior visibility. */
  allDotsHidden?: boolean
  onToggleAllDots?: () => void
  /** #12d-a — export the crosswalk as a CSV harmonization table. Disabled
   * when there are no variable groups to export. */
  onExportCsv?: () => void
}

export function CrosswalkHeader({
  searchQuery,
  onSearchChange,
  onSearchClear,
  datasets,
  toggleState,
  bracketCount,
  onCreateDomain,
  onSuggestGroups,
  isSuggestLoading = false,
  datasetCount,
  panelOpen,
  onTogglePanel,
  collapsedCount = 0,
  onCollapseAll,
  onExpandAll,
  allDotsHidden = false,
  onToggleAllDots,
  onExportCsv,
}: CrosswalkHeaderProps) {
  const effectiveDatasetCount = datasetCount ?? datasets.length
  const suggestEnabled = !!onSuggestGroups && effectiveDatasetCount >= 2 && !isSuggestLoading
  const suggestTitle = effectiveDatasetCount < 2
    ? 'Add at least 2 datasets to use Suggest Groups'
    : isSuggestLoading
      ? 'Analyzing…'
      : 'Auto-detect related variables across datasets'
  const allCollapsed = bracketCount > 0 && collapsedCount >= bracketCount
  const showCollapseControls = bracketCount > 0 && (onCollapseAll || onExpandAll)
  return (
    <header className="flex flex-col gap-3 pb-4 mb-4 border-b border-mm-border-subtle shrink-0">
      {/* Top row: title + primary actions */}
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-lg font-semibold text-mm-text">Variable Groups</h1>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="What are variable groups?"
                  className="p-0.5 rounded text-mm-text-muted hover:text-mm-text hover:bg-mm-bg focus-visible:ring-2 focus-visible:ring-ring focus:outline-none transition-colors"
                  data-testid="crosswalk-help-trigger"
                >
                  <HelpCircle className="w-4 h-4" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-[360px] p-4"
                align="start"
                role="dialog"
                aria-label="How variable groups work"
              >
                <h2 className="text-sm font-semibold text-mm-text mb-2">
                  How variable groups work
                </h2>
                <p className="text-xs text-mm-text-muted mb-3">
                  Each row is one variable.
                </p>
                <div className="space-y-2.5 text-xs leading-snug">
                  <div>
                    <p className="text-mm-text font-medium mb-0.5">
                      Side-by-side cells in a row
                    </p>
                    <p className="text-mm-text-muted">
                      The <em>same variable</em>, recorded in different datasets.
                      Use this when the same measurement was collected from
                      different sources you want to harmonize.
                    </p>
                  </div>
                  <div>
                    <p className="text-mm-text font-medium mb-0.5">
                      Rows stacked in a group
                    </p>
                    <p className="text-mm-text-muted">
                      <em>Different variables</em> combined into a single
                      composite. Use this when you want to average items into a
                      scale score.
                    </p>
                  </div>
                  <div className="pt-1.5 border-t border-mm-border-subtle">
                    <p className="text-mm-text font-medium mb-0.5">
                      Dataset color dots
                    </p>
                    <p className="text-mm-text-muted">
                      Click any dot to hide its dataset's color across the
                      crosswalk; right-click a column-header dot to change the
                      color. The eye toggle next to <span className="font-medium">Datasets</span> hides all dots at once.
                    </p>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          {/* Zero-state copy lives in CrosswalkEmptyState's headline; repeating
            * it here read as a duplicate (#428d). */}
          {bracketCount > 0 && (
            <p className="text-xs text-mm-text-secondary">
              {bracketCount} variable group{bracketCount === 1 ? '' : 's'}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onSuggestGroups}
          disabled={!suggestEnabled}
          title={suggestTitle}
          data-testid="suggest-groups-button"
        >
          <Sparkles className="w-4 h-4 mr-1.5" />
          {isSuggestLoading ? 'Analyzing…' : 'Suggest Groups'}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onCreateDomain}
          disabled={!onCreateDomain}
          title="Create a new variable group"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          New variable group
        </Button>
        {onExportCsv && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onExportCsv}
            disabled={bracketCount === 0}
            title={
              bracketCount === 0
                ? 'Create a variable group to export'
                : 'Export the crosswalk as a CSV harmonization table'
            }
            data-testid="crosswalk-export-csv"
          >
            <Download className="w-4 h-4 mr-1.5" />
            Export CSV
          </Button>
        )}
        {showCollapseControls && (
          // Single-button toggle: when anything is expanded the action is
          // "Collapse all"; when everything is already collapsed the action
          // flips to "Expand all". Replaces two icon-only buttons that
          // weren't discoverable (researchers scanning for textual labels
          // missed the chevrons entirely).
          <Button
            variant="ghost"
            size="sm"
            onClick={allCollapsed ? onExpandAll : onCollapseAll}
            aria-label={
              allCollapsed
                ? 'Expand all variable groups'
                : 'Collapse all variable groups'
            }
            data-testid="collapse-toggle"
          >
            {allCollapsed ? (
              <ChevronsUpDown className="w-4 h-4 mr-1.5" />
            ) : (
              <ChevronsDownUp className="w-4 h-4 mr-1.5" />
            )}
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </Button>
        )}
        {onTogglePanel && (
          <button
            type="button"
            onClick={onTogglePanel}
            aria-pressed={panelOpen}
            aria-label={panelOpen ? 'Close Unassigned panel' : 'Open Unassigned panel'}
            title={panelOpen ? 'Close Unassigned panel' : 'Open Unassigned panel'}
            className={cn(
              'p-1.5 rounded transition-colors focus-visible:ring-2 focus-visible:ring-ring focus:outline-none',
              panelOpen
                ? 'bg-[hsl(var(--mm-blue)/0.1)] text-[hsl(var(--mm-blue-text))]'
                : 'text-mm-text-muted hover:text-mm-text hover:bg-mm-bg',
            )}
          >
            <Inbox className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Bottom row: search + dataset toggles */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-mm-text-muted pointer-events-none" />
          <Input
            type="text"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search columns by code or text…"
            aria-label="Search columns by code or text"
            className="pl-8 pr-8"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={onSearchClear}
              className="absolute right-2 top-2 text-mm-text-muted hover:text-mm-text focus-visible:ring-2 focus-visible:ring-ring focus:outline-none rounded"
              aria-label="Clear search"
              title="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Dataset toggles */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-mm-text-muted">Datasets:</span>
          {onToggleAllDots && (
            <button
              type="button"
              onClick={onToggleAllDots}
              aria-pressed={allDotsHidden}
              aria-label={
                allDotsHidden
                  ? 'Show dataset color dots across the crosswalk'
                  : 'Hide all dataset color dots across the crosswalk'
              }
              title={
                allDotsHidden
                  ? 'Show all dataset color dots'
                  : 'Hide all dataset color dots'
              }
              className="p-1 rounded transition-colors text-mm-text-muted hover:text-mm-text hover:bg-mm-bg focus-visible:ring-2 focus-visible:ring-ring focus:outline-none"
              data-testid="crosswalk-dot-master-toggle"
            >
              {allDotsHidden ? (
                <EyeOff className="w-3.5 h-3.5" aria-hidden />
              ) : (
                <Eye className="w-3.5 h-3.5" aria-hidden />
              )}
            </button>
          )}
          {datasets.map(ds => {
            const active = toggleState.isActive(ds.dataset_id)
            return (
              <button
                key={ds.dataset_id}
                type="button"
                onClick={() => toggleState.toggle(ds.dataset_id)}
                aria-pressed={active}
                aria-label={`Toggle ${ds.dataset_name} dataset visibility`}
                className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus:outline-none ${
                  active
                    ? 'bg-mm-blue/15 text-mm-blue border-mm-blue/30'
                    : 'bg-mm-surface text-mm-text-muted border-mm-border-subtle hover:text-mm-text hover:border-mm-border-medium'
                }`}
              >
                {ds.dataset_name}
              </button>
            )
          })}
        </div>
      </div>
    </header>
  )
}
