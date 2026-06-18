/**
 * Empty state for a just-imported project with no variable groups yet.
 * Two primary CTAs: Suggest Groups and Start blank (§2 item 20).
 *
 * Phase 4 wires both buttons. When the user clicks Suggest Groups but the
 * algorithm returns no clusters, the parent (CrosswalkView) replaces this
 * component with `SuggestEmptyFallback` (three CTAs: browse, create blank,
 * drag target).
 */

import { Button } from '@/components/ui/button'
import { Sparkles, Plus } from 'lucide-react'

interface CrosswalkEmptyStateProps {
  datasetCount: number
  /** Phase 4: Suggest Groups click handler. When undefined the button is
   * disabled (e.g. while the suggestions query is still loading). */
  onSuggest?: () => void
  /** Phase 4: Start blank click handler — opens CreateDomainDialog. */
  onCreateBlank?: () => void
  /** True while the Suggest query is in flight. */
  isSuggestLoading?: boolean
}

export function CrosswalkEmptyState({
  datasetCount,
  onSuggest,
  onCreateBlank,
  isSuggestLoading = false,
}: CrosswalkEmptyStateProps) {
  return (
    <div
      data-testid="crosswalk-empty-state"
      className="flex flex-col items-center justify-center py-16 text-center"
    >
      <div className="max-w-md">
        <h2 className="text-lg font-semibold text-mm-text mb-2">
          No variable groups yet
        </h2>
        <p className="text-sm text-mm-text-secondary mb-6">
          Variable groups let you map related columns across datasets into a
          single construct — for example, "Leadership" across Board, Staff,
          and Stakeholder surveys.
        </p>
        {datasetCount >= 2 && (
          <div className="flex items-center justify-center gap-2">
            <Button
              variant="default"
              onClick={onSuggest}
              disabled={!onSuggest || isSuggestLoading}
              title="Auto-detect related variables across datasets"
            >
              <Sparkles className="w-4 h-4 mr-1.5" />
              {isSuggestLoading ? 'Analyzing…' : 'Suggest Groups'}
            </Button>
            <Button
              variant="outline"
              onClick={onCreateBlank}
              disabled={!onCreateBlank}
              title="Start with an empty variable group"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              Start blank
            </Button>
          </div>
        )}
        {datasetCount < 2 && (
          <p className="text-xs text-mm-text-muted italic">
            Import at least two datasets to start mapping variable groups.
          </p>
        )}
      </div>
    </div>
  )
}
