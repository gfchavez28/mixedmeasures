import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { datasetsApi, extractApiError } from '@/lib/api'
import { invalidateColumnDictionary } from '@/lib/dataset-cache'

/**
 * Recompute a computed variable — the Data view's and the Variables view's one
 * mutation (#1174).
 *
 * 🔴 **Both copies invalidated `dataset-data` + `dataset-columns` and nothing
 * else**, so the recompute — which rewrites the column's cells and marks every
 * saved statistic that reads them out of date — left `['metrics', pid]` cached:
 * the out-of-date markers it should raise appeared only once something else
 * refetched. A recompute changes the cells every statistic reads, which is the
 * blast radius `invalidateColumnDictionary` already names (metrics, scale
 * scores, comparisons, tests, data quality), so it routes through that rather
 * than a third hand-list. Two identical copies were how the gap was doubled;
 * this is the one place now.
 */
export function useRecomputeColumn(
  projectId: number,
  datasetId: number,
  failureMessage = 'Failed to recompute variable',
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (columnId: number) => datasetsApi.recomputeColumn(projectId, datasetId, columnId),
    onSuccess: () => invalidateColumnDictionary(queryClient, projectId, datasetId),
    onError: (err: unknown) => toast.error(extractApiError(err, failureMessage)),
  })
}
