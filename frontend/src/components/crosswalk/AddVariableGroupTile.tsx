/**
 * AddVariableGroupTile — inline "+ New variable group" tile rendered after
 * the last bracket in CrosswalkGrid. Two interaction modes:
 *
 *   1. Click — opens CreateDomainDialog with no preselected columns. Uses
 *      whatever multi-select is already active in the Unassigned panel
 *      (handled by CrosswalkView's existing selectedUnassignedIds wiring).
 *   2. Drop — drag a column (or multi-select) onto the tile to open the
 *      dialog with those column IDs pre-seeded via initialSelectedColumnIds
 *      (#322 plumbing).
 *
 * Why an inline tile in addition to the top-toolbar "+ New variable group"
 * button: distance signals scope. Toolbar = corpus-level / discoverable;
 * inline = repeat workflow / proximity. Researchers building a harmonization
 * create many groups in succession; the inline tile cuts the round-trip.
 *
 * Visual: matches Bracket's `mb-5 flex items-stretch gap-[10px]` rhythm so
 * it reads as the "next slot" in the bracket list. Dashed-outline, muted
 * styling so it sits behind real brackets visually until interacted with.
 *
 * The tile is hidden in the empty state — CrosswalkGrid returns null when
 * `grid.brackets.length === 0`, and the empty state has its own canonical
 * "Start blank" CTA (Phase 4 wires that). Don't move the tile into the
 * empty-state path; the duplication isn't worth the visual confusion.
 *
 * Drop-target wiring: registers a useDroppable with `NEW_BRACKET_TILE_DROP_ID`.
 * The drop branch in `useCrosswalkDnD::handleDragEnd` calls back through
 * `onNewBracketDrop(columnIds)` so the parent (CrosswalkView) can open the
 * create dialog. No mutation fires from this component directly.
 */

import { useDroppable } from '@dnd-kit/core'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NEW_BRACKET_TILE_DROP_ID } from './drop-ids'

interface AddVariableGroupTileProps {
  onCreate: () => void
  /** True when any cell drag is in progress. Used to highlight the tile as
   * a valid drop target even before the drag enters its hit-test region. */
  dragActive?: boolean
}

export function AddVariableGroupTile({
  onCreate,
  dragActive = false,
}: AddVariableGroupTileProps) {
  const { setNodeRef, isOver } = useDroppable({ id: NEW_BRACKET_TILE_DROP_ID })

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onCreate}
      data-testid="add-variable-group-tile"
      aria-label="Create a new variable group"
      className={cn(
        // Match Bracket's outer rhythm so the tile reads as the next slot
        'mb-5 flex items-stretch gap-[10px] w-full text-left rounded-md',
        'transition-colors focus-visible:ring-2 focus-visible:ring-ring focus:outline-none',
      )}
    >
      <div
        className={cn(
          // Mirror Bracket's 210px label gutter with dashed outline
          'w-[210px] flex-none flex flex-col items-center justify-center px-3 py-3',
          'border-2 border-dashed rounded-l-md transition-colors',
          isOver
            ? 'border-mm-blue bg-[hsl(var(--mm-blue)/0.08)] text-mm-blue'
            : dragActive
              ? 'border-mm-blue/40 text-mm-text-muted'
              : 'border-mm-border-subtle text-mm-text-muted hover:border-mm-border-medium hover:text-mm-text',
        )}
      >
        <Plus className="w-4 h-4 mb-1" aria-hidden />
        <span className="text-xs font-medium">New variable group</span>
      </div>
      <div
        className={cn(
          // Frame side — matches Bracket's flex-1 frame with dashed border
          'flex-1 min-w-0 flex items-center justify-center px-4 py-4',
          'border-2 border-dashed rounded-r-md transition-colors',
          isOver
            ? 'border-mm-blue bg-[hsl(var(--mm-blue)/0.06)]'
            : dragActive
              ? 'border-mm-blue/40 text-mm-text-muted'
              : 'border-mm-border-subtle text-mm-text-muted',
        )}
      >
        <span className="text-xs italic">
          {isOver
            ? 'Drop to create with these columns'
            : dragActive
              ? 'Drop a column here to start a new group'
              : 'Click to create — or drop a column here to seed it'}
        </span>
      </div>
    </button>
  )
}
