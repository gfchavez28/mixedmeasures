/**
 * SuggestEmptyFallback — three-CTA empty state shown when Suggest Groups
 * returns no clusters AND the project has no variable groups yet.
 *
 * The directive's three CTAs (§2 item 42):
 *   1. Browse unassigned columns — opens the Unassigned panel
 *   2. Create your first variable group — opens CreateDomainDialog
 *   3. Drag a column here — real dnd-kit droppable that pre-fills
 *      CreateDomainDialog with the dropped column ID(s)
 *
 * Why three: when Suggest returns nothing, the researcher needs an
 * obvious next action. Each CTA targets a different mental model:
 * (1) "let me look at what I have"; (2) "I know what I want"; (3)
 * "show me a starting point with this column."
 *
 * Reuses NEW_BRACKET_TILE_DROP_ID — the empty fallback and
 * AddVariableGroupTile never co-render (CrosswalkGrid early-returns
 * when no brackets exist), so the singleton drop ID is safe to share.
 *
 * The "Suggest works best when datasets use similar naming" tip is the
 * one-sentence text the directive mandates — points researchers toward
 * manual building when their data doesn't match the algorithm.
 */

import { useDroppable } from '@dnd-kit/core'
import { Button } from '@/components/ui/button'
import { Inbox, Plus, MoveDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NEW_BRACKET_TILE_DROP_ID } from './drop-ids'

interface SuggestEmptyFallbackProps {
  /** Click on "Browse unassigned columns" — opens the Unassigned panel. */
  onBrowseUnassigned: () => void
  /** Click on "Create your first variable group" — opens CreateDomainDialog. */
  onCreateBlank: () => void
  /** True when any cell drag is in progress. Highlights the drop CTA. */
  dragActive?: boolean
}

export function SuggestEmptyFallback({
  onBrowseUnassigned,
  onCreateBlank,
  dragActive = false,
}: SuggestEmptyFallbackProps) {
  const { setNodeRef, isOver } = useDroppable({ id: NEW_BRACKET_TILE_DROP_ID })

  return (
    <div
      data-testid="suggest-empty-fallback"
      className="flex flex-col items-center justify-center py-12 text-center"
    >
      <div className="max-w-xl w-full">
        <h2 className="text-lg font-semibold text-mm-text mb-2">
          No suggestions to show
        </h2>
        <p className="text-sm text-mm-text-secondary mb-6">
          Suggest Groups works best when datasets use similar column naming
          conventions. With manually-named columns, building by hand is
          usually faster.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-2">
          {/* CTA 1 — Browse unassigned */}
          <Button
            variant="outline"
            onClick={onBrowseUnassigned}
            className="h-auto py-3 flex flex-col items-center gap-1.5"
          >
            <Inbox className="w-5 h-5 text-mm-text-muted" aria-hidden />
            <span className="text-sm font-medium">Browse unassigned</span>
            <span className="text-[11px] text-mm-text-muted leading-snug">
              See your columns first
            </span>
          </Button>

          {/* CTA 2 — Create blank */}
          <Button
            variant="default"
            onClick={onCreateBlank}
            className="h-auto py-3 flex flex-col items-center gap-1.5"
          >
            <Plus className="w-5 h-5" aria-hidden />
            <span className="text-sm font-medium">Create variable group</span>
            <span className="text-[11px] opacity-80 leading-snug">
              Start with an empty group
            </span>
          </Button>

          {/* CTA 3 — Drop target */}
          <div
            ref={setNodeRef}
            data-testid="empty-fallback-droptarget"
            className={cn(
              'h-auto py-3 px-3 flex flex-col items-center justify-center gap-1.5',
              'rounded-md border-2 border-dashed transition-colors',
              isOver
                ? 'border-mm-blue bg-[hsl(var(--mm-blue)/0.08)] text-mm-blue'
                : dragActive
                  ? 'border-mm-blue/40 text-mm-text-muted'
                  : 'border-mm-border-subtle text-mm-text-muted',
            )}
            aria-label="Drop a column here to start a new variable group"
          >
            <MoveDown className="w-5 h-5" aria-hidden />
            <span className="text-sm font-medium">Drag a column here</span>
            <span className="text-[11px] leading-snug">
              {isOver
                ? 'Drop to seed a new group'
                : 'Drag from the Unassigned panel'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
