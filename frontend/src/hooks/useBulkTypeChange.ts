import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { extractApiError, recodeApi } from '@/lib/api'
import { invalidateColumnDictionary } from '@/lib/dataset-cache'

/**
 * The Variables view's bulk type change (#1145).
 *
 * The selection travels as the mutation's VARIABLES, so the wait line counts
 * what was sent even if the checkboxes change while it runs.
 *
 * 🔴 A retype re-derives every selected variable's stored numbers and marks the
 * saved statistics that read them out of date — the dictionary-edit blast
 * radius, so it invalidates through `invalidateColumnDictionary`, not only
 * `dataset-columns` (the recompute's #1174 gap, same class: the markers it
 * raises appeared only once something else refetched).
 */
export function useBulkTypeChange(projectId: number, datasetId: number, onDone: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ columnIds, columnType }: { columnIds: number[]; columnType: string }) =>
      recodeApi.bulkTypeUpdate(projectId, datasetId, columnIds, columnType),
    onSuccess: () => {
      onDone()
      invalidateColumnDictionary(queryClient, projectId, datasetId)
    },
    // Without this a refused change said nothing at all: the wait line simply
    // went away and the types stayed as they were.
    onError: (err: unknown) => toast.error(extractApiError(err, 'Could not change the type')),
  })
}
