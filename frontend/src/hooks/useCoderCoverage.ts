import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { codeAnalysisApi, type Coder } from '@/lib/api'
import { isMachineCoder } from '@/lib/coding-layers'

/**
 * Track J · Group A (#3/#13) — coder coverage for ONE source (conversation /
 * document / observation / text columns). Derived from CODINGS (not the
 * instance-global roster — the #444 trap). Single fetch shared by the
 * "N coders" badge (#456) and the picklist "active here" markers (#457).
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
  observationId?: number
  textColumnIds?: number[]
}

export function useCoderCoverage(
  projectId: number,
  source: CoderCoverageSource,
  opts?: { enabled?: boolean; rosterCoderIds?: number[] },
) {
  const colIds = source.textColumnIds ?? []
  const hasSource = source.conversationId != null || source.documentId != null
    || source.observationId != null || colIds.length > 0
  const enabled = (opts?.enabled ?? true) && hasSource
  const rosterKey = (opts?.rosterCoderIds ?? []).join(',')

  const { data } = useQuery({
    queryKey: ['coder-coverage', projectId, source.conversationId ?? null, source.documentId ?? null, source.observationId ?? null, colIds.join(',')],
    queryFn: () =>
      codeAnalysisApi.coderCoverage(projectId, {
        conversation_id: source.conversationId,
        document_id: source.documentId,
        observation_id: source.observationId,
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

/**
 * #1030 / #1038 g — which KINDS of coder have coded THIS project, from coverage.
 *
 * 🔴 **Not the roster.** `GET /auth/coders` is install-wide, so a model imported
 * into project A offered the Machine layer — and would have offered the Model
 * comparison tab — in every other project, where each can only answer "nothing".
 * Coverage is derived from this project's codings and carries each coder's kind.
 *
 * - `hasMachine`: any machine coded here, ARCHIVED included — the Machine LAYER
 *   returns an archived model's codings (`only_machine_filter` has no archive arm).
 * - `hasActiveMachine`: an ACTIVE machine did — the comparison excludes archived
 *   coders on both sides (DEC-F), so only this one can fill the table.
 * - `known`: has coverage answered? Until it has, a caller must not act on
 *   `false` (a saved layer or a deep-linked tab would be reset on the first frame).
 *
 * The key is `useCoderCoverage`'s project-wide shape, so `invalidateDerivedCounts`'
 * `['coder-coverage', pid]` refreshes it after any coding — the coding import in
 * particular, which is how a model layer arrives.
 */
export function useProjectCoderKinds(projectId: number) {
  const { data } = useQuery({
    queryKey: ['coder-coverage', projectId, null, null, null, ''],
    queryFn: () => codeAnalysisApi.coderCoverage(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
  })
  return useMemo(() => {
    const coders = data?.coders ?? []
    const machines = coders.filter(isMachineCoder)
    return {
      known: data != null,
      hasMachine: machines.length > 0,
      hasActiveMachine: machines.some(c => !c.archived),
    }
  }, [data])
}
