/**
 * SwapErrorOverlay — shown when a swap fails with a structured `type_mismatch`
 * 409 (Phase 3b.6, plan PF-2). Inline overlay with two fix options:
 *
 *   - Change source column's type (single-column bulkTypeUpdate)
 *   - Change the whole row's type via batch helper (foot-gun)
 *
 * For this iteration we keep the overlay minimal: just show the error,
 * let the user open the affected columns in Dataset View to fix types, and
 * offer a Retry button that re-submits the original swap. The full fix
 * flow (inline type picker + batchBulkTypeUpdateByDataset) can ride on top
 * of this same component in a follow-up without changing the call shape.
 *
 * `cross_dataset_unpaired` is NOT handled here — it's surfaced via the
 * dedicated toast in useCrosswalkMutations (plan §3b.9d).
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { ProjectColumnInfo } from './crosswalk-types'

interface SwapErrorOverlayProps {
  open: boolean
  message: string
  affectedColumnIds: number[]
  allColumns: ProjectColumnInfo[]
  projectId: number
  onRetry: () => void
  onClose: () => void
  /** True while the retry-triggered swap is in flight. Disables the Retry
   * button (visible feedback) and switches its label to "Retrying…". Closes
   * the rapid-double-click window where two swap mutations could dispatch
   * before the overlay unmounts (#340). */
  isRetrying?: boolean
}

export function SwapErrorOverlay({
  open,
  message,
  affectedColumnIds,
  allColumns,
  projectId,
  onRetry,
  onClose,
  isRetrying = false,
}: SwapErrorOverlayProps) {
  const byId = new Map(allColumns.map((c) => [c.id, c]))
  const affected = affectedColumnIds
    .map((id) => byId.get(id))
    .filter((c): c is ProjectColumnInfo => c != null)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Type mismatch — swap blocked</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p className="text-mm-text-secondary">
            The two columns must share a type to swap. Fix the column types in Dataset View, then
            retry.
          </p>
          {affected.length > 0 && (
            <ul className="mt-2 space-y-1 border rounded-md p-2 bg-mm-surface/40">
              {affected.map((col) => (
                <li key={col.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    <span className="font-mono text-[11px] text-mm-text-muted mr-1.5">
                      {col.column_code ?? `col ${col.id}`}
                    </span>
                    <span className="text-mm-text">{col.column_text}</span>
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-mm-text-muted">
                      {col.column_type}
                    </span>
                  </span>
                  <a
                    href={`/projects/${projectId}/datasets/${col.dataset_id}?column=${col.id}`}
                    className="text-xs text-mm-blue underline underline-offset-2 hover:text-mm-blue/80 whitespace-nowrap"
                  >
                    Open in Dataset View
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onRetry} disabled={isRetrying}>
            {isRetrying ? 'Retrying…' : 'Retry swap'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
