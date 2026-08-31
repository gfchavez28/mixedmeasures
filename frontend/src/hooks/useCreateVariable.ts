/**
 * Creating a variable, owned in ONE place (#830f, 2026-08-31).
 *
 * ## Why a hook rather than a second copy
 *
 * `Add ▾` lived on the Data view alone, so the Variables view — the screen
 * where recode rules are authored, and the screen `PickRuleToDeriveDialog`'s
 * own empty state sends people to — had no way to create a variable at all.
 * Putting the menu on both surfaces means the two create mutations stop being
 * single-call-site code.
 *
 * This is the third extraction of this shape in the same arc, after
 * `useDeriveVariable` (Decision B Stage 3) and `useDeleteVariable` (#812), and
 * the reason is the one `useDeleteVariable` recorded: **a copy does not only
 * drift, it propagates the original's defect verbatim (#733).** Which is what
 * happened here — see the invalidation note below.
 *
 * ## 🔴 The defect the extraction surfaced
 *
 * Both mutations hand-listed `['dataset-data']` + `['dataset-columns']`. A new
 * variable also has to appear in `['project-columns']` (the crosswalk's
 * Unassigned panel) and `['analysis-columns']` (the analysis picker) — and the
 * global `staleTime` is **60 s** (`main.tsx`), with `ColumnPicker` setting its
 * own 60 s on top. So a researcher who created a variable and walked to either
 * screen inside a minute was served a cached list without it.
 *
 * `invalidateColumnDictionary` is the existing single source for that key set
 * (#608/#450) and covers all four. Creating a variable is strictly less than
 * deleting one (no group or domain can be dissolved by an addition), so this
 * takes the dictionary helper rather than `invalidateColumnRemoved`.
 *
 * ## What each surface still decides for itself
 *
 * `onCreated` — exactly as `useDeriveVariable` established. The Variables view
 * SELECTS the new variable (otherwise the researcher is left looking at the old
 * one with the thing they just made invisible); the Data view does nothing,
 * because the new column is already in the grid in front of them.
 */
import { useCallback, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  datasetsApi,
  extractApiError,
  type ComputedColumnCreate,
  type DatasetColumn,
  type ManualColumnCreate,
} from '@/lib/api'
import { invalidateColumnDictionary } from '@/lib/dataset-cache'

/** Which of the three kinds of new variable a surface has open. */
export type VariableKind = 'manual' | 'computed' | 'recoded'

export function useCreateVariable(
  projectId: number,
  datasetId: number,
  onCreated?: (newColumnId: number) => void,
) {
  const queryClient = useQueryClient()
  const [openKind, setOpenKind] = useState<VariableKind | null>(null)
  const [manualError, setManualError] = useState<string | null>(null)
  const [computedError, setComputedError] = useState<string | null>(null)

  const close = useCallback(() => {
    setOpenKind(null)
    setManualError(null)
    setComputedError(null)
  }, [])

  const open = useCallback((kind: VariableKind) => {
    setManualError(null)
    setComputedError(null)
    setOpenKind(kind)
  }, [])

  const settle = useCallback((column: DatasetColumn, message: string) => {
    invalidateColumnDictionary(queryClient, projectId, datasetId)
    setOpenKind(null)
    setManualError(null)
    setComputedError(null)
    toast.success(message)
    onCreated?.(column.id)
  }, [queryClient, projectId, datasetId, onCreated])

  const manualMutation = useMutation({
    mutationFn: (data: ManualColumnCreate) =>
      datasetsApi.createManualColumn(projectId, datasetId, data),
    onSuccess: (column) => settle(column, 'Variable added'),
    onError: (err: Error) => setManualError(extractApiError(err, 'Failed to create variable')),
  })

  const computedMutation = useMutation({
    mutationFn: (data: ComputedColumnCreate) =>
      datasetsApi.createComputedColumn(projectId, datasetId, data),
    onSuccess: (column) => settle(column, 'Computed variable added'),
    onError: (err: Error) =>
      setComputedError(extractApiError(err, 'Failed to create computed variable')),
  })

  return {
    open,
    close,
    openKind,
    /** Props for the manual `ColumnFormDialog`, minus its title. */
    manualDialogProps: {
      open: openKind === 'manual',
      onOpenChange: (o: boolean) => { if (!o) close() },
      onSubmit: (data: unknown) => manualMutation.mutate(data as ManualColumnCreate),
      isSubmitting: manualMutation.isPending,
      submitError: manualError,
    },
    /** Props for the computed `ColumnFormDialog`, minus its title and columns. */
    computedDialogProps: {
      open: openKind === 'computed',
      onOpenChange: (o: boolean) => { if (!o) close() },
      onSubmit: (data: unknown) => computedMutation.mutate(data as ComputedColumnCreate),
      isSubmitting: computedMutation.isPending,
      submitError: computedError,
    },
    /** The third kind runs through `useDeriveVariable`; this only opens it. */
    isRecodedPickerOpen: openKind === 'recoded',
  }
}
