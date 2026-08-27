/**
 * Deleting a variable, owned in ONE place (#812, 2026-08-24).
 *
 * ## Why a hook rather than a second copy
 *
 * Decision B let a researcher CREATE a variable from the Variables view, and
 * there was no way to remove one from the same surface — so the first thing they
 * did after an experimental derive was leave the page they were working on. The
 * fix is a second entry point, and a second entry point for a DESTRUCTIVE verb
 * is precisely the shape #807 found (one control on three surfaces, gated three
 * different ways, one of them not at all).
 *
 * So the confirm, the endpoint choice, the invalidation and the gate live here,
 * and every surface spends `variableDeleteEndpoint`. Mirrors
 * `useDeriveVariable` — the create half of the same asymmetry.
 *
 * ## What each surface still decides for itself
 *
 * `onDeleted` — the Variables view must move its selection off a variable that
 * no longer exists; the Data view does nothing, because the column simply leaves
 * the grid in front of them. Same act, different "you are here".
 *
 * ⚠️ **This is NOT undoable and is deliberately absent from `useHistory`.** The
 * Variables view has an undo stack (design note E, slab 4) covering header
 * edits and type changes — all of which are re-writable from data still present.
 * A deleted column's values are gone from the database, so an entry that could
 * not honour a redo is worse than no entry: `useHistory` promises reversal, and
 * a stack with one lying entry in it cannot be trusted for the others. The
 * confirm dialog is what stands in for the undo, which is why it names the
 * variable and says the word "permanently".
 */
import { useState, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { datasetsApi, extractApiError, type DatasetColumn } from '@/lib/api'
import { invalidateColumnRemoved } from '@/lib/dataset-cache'
import { variableDeleteEndpoint } from '@/lib/dataset-constants'
import { columnDisplayLabel } from '@/lib/dataset-column-label'

/** The subset a caller must supply. Deliberately narrow: the Data view holds a
 *  `DatasetColumn` and the Variables view holds the same shape, but a hook that
 *  demanded the whole payload could only serve whichever one it was lifted
 *  from — the lesson from a component that moved surfaces and inherited that
 *  surface's payload. */
export type DeletableColumn = Pick<DatasetColumn, 'id' | 'source'> &
  Parameters<typeof columnDisplayLabel>[0]

export function useDeleteVariable(
  projectId: number,
  datasetId: number,
  onDeleted?: (deletedColumnId: number) => void,
) {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<DeletableColumn | null>(null)

  /** Open the confirm. Refuses outright for a variable nothing can delete, so a
   *  surface that forgets the gate fails loudly here rather than showing a
   *  confirm the server will 403. */
  const request = useCallback((column: DeletableColumn) => {
    if (variableDeleteEndpoint(column) === null) {
      toast.error('An imported variable cannot be deleted — it is part of the file you brought in.')
      return
    }
    setTarget(column)
  }, [])

  const close = useCallback(() => setTarget(null), [])

  const mutation = useMutation({
    mutationFn: (column: DeletableColumn) =>
      variableDeleteEndpoint(column) === 'computed'
        ? datasetsApi.deleteComputedColumn(projectId, datasetId, column.id)
        : datasetsApi.deleteManualColumn(projectId, datasetId, column.id),
    onSuccess: (_res, column) => {
      // A delete cascades past the column's own readers — domain members,
      // metrics, and any equivalence group or domain it empties (#812).
      invalidateColumnRemoved(queryClient, projectId, datasetId)
      setTarget(null)
      toast.success(`Deleted ${columnDisplayLabel(column)}`)
      onDeleted?.(column.id)
    },
    onError: (err: unknown) => toast.error(extractApiError(err, 'Failed to delete variable')),
  })

  return {
    request,
    /** Props for `DeleteVariableDialog`. */
    dialogProps: {
      column: target,
      isPending: mutation.isPending,
      onCancel: close,
      onConfirm: () => { if (target) mutation.mutate(target) },
    },
    isPending: mutation.isPending,
  }
}
