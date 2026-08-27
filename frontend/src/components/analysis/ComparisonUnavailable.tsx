import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { domainsApi } from '@/lib/api'
import {
  describeUnavailable,
  isComputableScoreReason,
} from '@/lib/comparison-unavailable'

interface ComparisonUnavailableProps {
  pid: number
  /** The server's reason. Never derived here — see `comparison-unavailable.ts`. */
  reason: string | null | undefined
  /** The variable groups in the current selection; empty for a column comparison. */
  domainIds: number[]
}

/**
 * What a comparison with no rows says (#823c · #827).
 *
 * Replaces one hardcoded sentence — *"The selected demographic may have fewer
 * than 2 groups"* — that was right for one of four causes and wrong for both
 * the cases a real research pass met.
 *
 * ⚠️ **The fallback is the OLD sentence's honest form, not the old sentence.**
 * A server that predates `unavailable_reason` sends nothing, and an unknown
 * reason from a newer one reads the same way here; in both cases the only true
 * statement is that there is nothing to show.
 */
export default function ComparisonUnavailable({
  pid, reason, domainIds,
}: ComparisonUnavailableProps) {
  const queryClient = useQueryClient()
  const copy = describeUnavailable(reason)

  // #823(c)'s undiscoverable fix, made discoverable. The endpoint is idempotent
  // and retries the compute on a stale metric, so it covers BOTH score reasons
  // (`…_missing` creates it, `…_not_computed` recomputes it).
  //
  // ⚠️ **It computes on a POST, never on the comparison's GET.** Recompute on
  // read is the hazard this codebase already decided against (DEC-C: a GET that
  // writes races the write-side sweep on SQLite).
  //
  // ⚠️ Known gap, deliberately not chased here: a metric that is NOT stale but
  // has no `RowScore` rows (the per-record score block is error-isolated, so it
  // can fail while the main result succeeds) makes this a no-op — the message
  // simply stays, which is today's behaviour with a better sentence.
  const computeScores = useMutation({
    mutationFn: async () => {
      for (const domainId of domainIds) {
        await domainsApi.createScoreMetric(pid, domainId)
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group-comparison'] })
      queryClient.invalidateQueries({ queryKey: ['metrics', pid] })
    },
    onError: () => toast.error('Could not compute the scale score.'),
  })

  const canCompute = isComputableScoreReason(reason) && domainIds.length > 0

  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-mm-text-faint text-sm">
      <Info className="w-5 h-5 opacity-60" aria-hidden="true" />
      <p className="font-medium text-mm-text-secondary">
        {copy?.title ?? 'No comparison data available.'}
      </p>
      {copy?.detail && <p className="max-w-md text-center">{copy.detail}</p>}
      {canCompute && (
        <Button
          size="sm"
          variant="outline"
          className="mt-1 text-xs"
          disabled={computeScores.isPending}
          onClick={() => computeScores.mutate()}
        >
          {computeScores.isPending ? 'Computing…' : 'Compute the scale score'}
        </Button>
      )}
    </div>
  )
}
