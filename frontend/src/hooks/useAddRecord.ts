/**
 * Adding one empty record to a dataset, owned in ONE place (queue row 47).
 *
 * ## Why a hook rather than a second copy
 *
 * The `Add ▾` menu renders on BOTH tabs of the dataset workspace, so the moment
 * *Add record* joined it there were two call sites. This is the fourth
 * extraction of this shape in the arc, after `useDeriveVariable`,
 * `useDeleteVariable` (#812) and `useCreateVariable` (#830f), and the reason is
 * the one `useDeleteVariable` recorded: **a copy does not only drift, it
 * propagates the original's defect verbatim (#733).** That is not hypothetical
 * here — extracting this is what surfaced `deleteRow` invalidating
 * `['dataset-data']` and nothing else, which a copied add would have inherited.
 *
 * ## What each surface still decides
 *
 * `onAdded`, exactly as `useCreateVariable` established. The two answers differ
 * because the two screens can show different things:
 *
 *  - the **Data view** moves to the record's page and reveals it, reusing the
 *    search deep link's own machinery;
 *  - the **Variables view** cannot display a record at all, so it NAVIGATES to
 *    the Data view deep-linked at the new row (`dataViewPath(..., {rowId})`).
 *    Adding a record on a screen that cannot show one and staying put is the
 *    "left looking at the old thing with what you just made invisible" problem.
 *
 * ## Why the response carries a position
 *
 * A new record sorts LAST (`submitted_at ASC NULLS LAST, id ASC`), so on a
 * 500-record dataset it is on page 3 while the grid shows page 1. The server
 * computes that offset with the same `row_position()` the #834 deep link uses,
 * so the two can never disagree about which page holds a row.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  datasetsApi,
  extractApiError,
  DATASET_PAGE_SIZE,
  type DatasetRowCreated,
} from '@/lib/api'
import { invalidateRowSetChanged } from '@/lib/dataset-cache'

export function useAddRecord(
  projectId: number,
  datasetId: number,
  onAdded?: (created: DatasetRowCreated) => void,
) {
  const queryClient = useQueryClient()

  const mutation = useMutation({
    // ⚠️ The page size the grid will then request, or the returned `offset`
    // addresses a boundary the grid does not use (#800's contract, shared with
    // `rowPosition`). The deep-link effect passes the same constant.
    mutationFn: () => datasetsApi.createRow(projectId, datasetId, DATASET_PAGE_SIZE),
    onSuccess: (created) => {
      invalidateRowSetChanged(queryClient, projectId, datasetId)
      toast.success(
        created.row_identifier
          ? `Record ${created.row_identifier} added`
          : 'Record added',
      )
      onAdded?.(created)
    },
    // The server's own sentence when it refuses — a managed table answers 409
    // with the reason, and that reads better than anything generic here.
    onError: (err: Error) => toast.error(extractApiError(err, 'Could not add a record')),
  })

  return {
    addRecord: () => mutation.mutate(),
    isAdding: mutation.isPending,
  }
}
