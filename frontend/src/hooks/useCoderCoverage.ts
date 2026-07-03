import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { codeAnalysisApi, type Coder } from '@/lib/api'

/**
 * Track J · Group A (#3/#13) — coder coverage for ONE source (conversation /
 * document / text columns). Derived from CODINGS (not the instance-global roster —
 * the #444 trap). Single fetch shared by the "N coders" badge (#456) and the
 * picklist "active here" markers (#457).
 *
 * Returns:
 *  - `coders` — raw coverage items (incl. archived, flagged)
 *  - `count`  — distinct coders on the source
 *  - `activeCoderIds` — set of coder ids with ≥1 coding here (drives the markers)
 *  - `extraCoders` — archived coders who coded here but are absent from the
 *    (non-archived) roster, mapped to `Coder` so the picklist can list them
 *    labeled "(archived)" (also the #451 surface).
 */
export interface CoderCoverageSource {
  conversationId?: number
  documentId?: number
  textColumnIds?: number[]
}

export function useCoderCoverage(
  projectId: number,
  source: CoderCoverageSource,
  opts?: { enabled?: boolean; rosterCoderIds?: number[] },
) {
  const colIds = source.textColumnIds ?? []
  const hasSource = source.conversationId != null || source.documentId != null || colIds.length > 0
  const enabled = (opts?.enabled ?? true) && hasSource
  const rosterKey = (opts?.rosterCoderIds ?? []).join(',')

  const { data } = useQuery({
    queryKey: ['coder-coverage', projectId, source.conversationId ?? null, source.documentId ?? null, colIds.join(',')],
    queryFn: () =>
      codeAnalysisApi.coderCoverage(projectId, {
        conversation_id: source.conversationId,
        document_id: source.documentId,
        text_column_ids: colIds.length ? colIds.join(',') : undefined,
      }),
    enabled,
    staleTime: 60_000,
  })

  return useMemo(() => {
    const coders = data?.coders ?? []
    const rosterSet = new Set(rosterKey ? rosterKey.split(',').map(Number) : [])
    const activeCoderIds = new Set(coders.map(c => c.user_id))
    const extraCoders: Coder[] = coders
      .filter(c => c.archived && !rosterSet.has(c.user_id))
      .map(c => ({ id: c.user_id, username: c.username, display_color: c.display_color, archived: true }))
    return { coders, count: data?.count ?? 0, activeCoderIds, extraCoders, isLoaded: data != null }
  }, [data, rosterKey])
}
