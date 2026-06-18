/**
 * BulkAssignPickerDialog — keyboard / accessibility fallback for adding
 * unassigned columns to a variable group. Reachable from:
 *
 *   - Unassigned panel toolbar "Add…" button when multi-checkbox selection
 *     is active
 *   - Unassigned card right-click "Add to variable group…"
 *
 * The per-bracket "+ Add variable row" button no longer routes here; that
 * path is now drag-first (see useCrosswalkDnD's add-row drop branch).
 *
 * Path A note: every domain member renders as a row regardless of whether
 * it has an EG, so the prior placement radio (`row_per_column` vs
 * `as_additional`) is vestigial — both produced visually identical
 * results, differing only in whether an EG was created. The dialog now
 * always uses `row_per_column` (one EG per column, each becomes a row).
 *
 * A9 mitigation: never autoFocus the Confirm button. autoFocus goes on the
 * first radio in the bracket list, and Enter on the bracket list does not
 * commit (only Tab→Confirm and clicking confirms). Bracket list uses
 * native radios; pressing Enter on a radio only selects the radio.
 */

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { BracketData } from './crosswalk-types'
import { BRACKET_DOT_CLASS, resolveBracketColor } from './bracket-color'

interface BulkAssignPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  brackets: BracketData[]
  columnIds: number[]
  onConfirm: (bracketId: number) => void
  loading?: boolean
  /** Path A #333: when set, the dialog opens with this bracket pre-selected
   * (instead of defaulting to the first sequence-ordered bracket). Used by
   * the unassigned card's right-click "Add to variable group…" entry so
   * the researcher's intent carries through. */
  preselectedBracketId?: number | null
}

export function BulkAssignPickerDialog({
  open,
  onOpenChange,
  brackets,
  columnIds,
  onConfirm,
  loading = false,
  preselectedBracketId = null,
}: BulkAssignPickerDialogProps) {
  const [bracketId, setBracketId] = useState<number | null>(null)

  useEffect(() => {
    if (open) {
      if (preselectedBracketId != null) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initialize selected bracket from props when the dialog opens
        setBracketId(preselectedBracketId)
      } else {
        const first = brackets.find((b) => b.sequence_order != null) ?? brackets[0]
        setBracketId(first?.domain_id ?? null)
      }
    }
  }, [open, brackets, preselectedBracketId])

  const canConfirm = bracketId != null && !loading

  return (
    <Dialog open={open} onOpenChange={loading ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Add {columnIds.length} column{columnIds.length === 1 ? '' : 's'} to variable group
          </DialogTitle>
          <DialogDescription>
            Pick a variable group. Each column becomes a new row.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-1 max-h-60 overflow-y-auto">
          <legend className="text-xs font-medium text-mm-text-secondary mb-1">Variable group</legend>
          {brackets.length === 0 ? (
            <p className="text-sm text-mm-text-muted italic">No variable groups yet.</p>
          ) : (
            brackets.map((b, idx) => (
              <label
                key={b.domain_id}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-mm-surface-hover cursor-pointer"
              >
                <input
                  type="radio"
                  name="bulk-assign-bracket"
                  value={b.domain_id}
                  checked={bracketId === b.domain_id}
                  onChange={() => setBracketId(b.domain_id)}
                  autoFocus={idx === 0}
                />
                <span
                  className={BRACKET_DOT_CLASS}
                  style={{ backgroundColor: resolveBracketColor(b.color) }}
                  aria-hidden
                />
                <span className="text-sm font-medium text-mm-text">{b.name}</span>
                <span className="text-xs text-mm-text-muted">
                  · {b.rows.length} row{b.rows.length === 1 ? '' : 's'}
                </span>
                {b.is_cross_dataset && (
                  <span className="text-[10px] uppercase tracking-wide text-violet-600 dark:text-violet-300">
                    cross-dataset
                  </span>
                )}
              </label>
            ))
          )}
        </fieldset>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            disabled={!canConfirm}
            onClick={() => bracketId != null && onConfirm(bracketId)}
          >
            {loading ? 'Adding...' : `Add ${columnIds.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
