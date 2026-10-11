import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { domainsApi, extractApiError } from '@/lib/api'

/**
 * The query families that read a variable group's stored per-record scale
 * scores, plus the metrics list that carries the out-of-date markers. Prefix
 * keys: `[family, projectId]` covers every selection variant.
 */
export const SCALE_SCORE_READER_KEYS = [
  'correlation-matrix',
  'scatter-matrix',
  'group-comparison',
  'domain-scores',
  'metrics',
] as const

/**
 * Compute (or recompute) variable groups' scale scores, one request per group —
 * the one call behind `ComparisonUnavailable`'s *Compute the scale score* and
 * `StaleScaleScoresNotice`'s *Recompute scale scores* (#1168 R7).
 *
 * `create-score-metric` is idempotent: it creates a missing score and
 * recomputes a stale one, so both buttons are the same act.
 *
 * ⚠️ It computes on a POST, never on the comparison's GET. Recompute on read is
 * the hazard this codebase already decided against (DEC-C: a GET that writes
 * races the write-side sweep on SQLite) — which is exactly why a comparison can
 * serve an out-of-date score and must SAY so instead.
 *
 * ⚠️ Invalidates on SETTLE, not success: with three groups and the second
 * refused, the first is already recomputed, and the readers must not go on
 * showing its old numbers.
 */
export function useRecomputeScaleScores(projectId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (domainIds: readonly number[]) => {
      for (const domainId of domainIds) {
        await domainsApi.createScoreMetric(projectId, domainId)
      }
    },
    onSettled: () => {
      for (const family of SCALE_SCORE_READER_KEYS) {
        queryClient.invalidateQueries({ queryKey: [family, projectId] })
      }
    },
    // The server's own sentence when it refused (an unpaired cross-dataset
    // group says what to repair), never a paraphrase.
    onError: (err: unknown) => toast.error(extractApiError(err, 'Could not compute the scale score.')),
  })
}
