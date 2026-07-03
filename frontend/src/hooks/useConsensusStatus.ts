import { useQuery } from '@tanstack/react-query'
import { codeAnalysisApi, type ConsensusStatus } from '@/lib/api'

/**
 * Consensus-layer status for a project (Track J · J2-5 M-2). Drives the
 * qualitative-analysis layer selector: the consensus option is offered only when
 * `exists` is true (DEC-A), and `stale_count > 0` flags "consensus may be out of
 * date". `enabled` is the GLOBAL roster gate (≥2 selectable coders) — usually
 * redundant with `useCoders().multiCoder`, but kept for a self-contained signal.
 *
 * Mirrors `useCoders`'s lightweight query shape; safe to call on any analysis
 * surface. Disabled until `projectId` resolves.
 */
export function useConsensusStatus(projectId: number) {
  return useQuery<ConsensusStatus>({
    queryKey: ['consensus-status', projectId],
    queryFn: () => codeAnalysisApi.consensusStatus(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
  })
}
