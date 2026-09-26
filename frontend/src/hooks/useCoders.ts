import { useMemo } from 'react'
import { useQuery, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import { authApi, type Coder } from '@/lib/api'
import { isMachineCoder } from '@/lib/coding-layers'
import { listStatus, type ListStatus } from '@/lib/list-status'

export const CODERS_QUERY_KEY = ['coders'] as const

export interface CoderContext {
  coders: Coder[]
  /** user_id → Coder. Stable identity across renders (safe to pass to memoized rows). */
  coderMap: Map<number, Coder>
  /**
   * ≥2 roster coders OF ANY KIND → surface attribution badges + the per-coder
   * visibility filter. A machine coder counts here: its codings sit beside a
   * person's and must be attributable and filterable, or they read as yours.
   */
  multiCoder: boolean
  /**
   * 🔴 ≥2 HUMAN roster coders → surface RELIABILITY (#989). Reconciliation, the
   * IRR tab, consensus and blind mode all ask THIS, never `multiCoder`.
   *
   * The two are different claims and were one variable until #989. One person
   * plus one machine is genuinely multi-coder for attribution and is NOT two
   * raters: the server refuses to let a machine vote or enter an agreement
   * coefficient, so a UI gated on `multiCoder` would have offered a Reliability
   * tab whose table can only ever hold one column, and a *Reveal colleagues'
   * work* toggle for a colleague that is a model.
   *
   * Same split, same reason, as #964's `blind` / `withholding`: a surface asks
   * the question it actually depends on.
   */
  multiHumanCoder: boolean
  /** The roster's machine coders (#989) — attributed and filterable, never raters. */
  machineCoders: Coder[]
  /**
   * 🔴 Coders a session may be re-pointed AT (#989) — the roster minus machines.
   *
   * **Every switcher LIST reads this, never `coders`.** `GET /auth/coders` returns
   * the roster (machines included, because their codings must be attributable), and
   * `POST /auth/switch-coder` refuses a machine with a 404 — so a list built from
   * `coders` offers an act the server will not perform. Driven live: the TopRail
   * menu listed the machine and raised *"Code as GPT-4o? This changes who your
   * codings are attributed to"* before failing. That is the #806 shape.
   */
  selectableCoders: Coder[]
  /**
   * #964 — has the roster ANSWERED? `coders` is `[]` both before the server
   * answers and after the request fails, and an empty roster reads as a
   * one-person one: `multiCoder` false, so blind mode off. Anything whose
   * correctness depends on WHO the other coders are asks this, never `coders`.
   */
  status: ListStatus
  /** The roster query itself — for a page gate's `useListLoad` (its Retry). */
  query: UseQueryResult<Coder[]>
}

/**
 * Shared coder-roster lens (Track J · J1). Reuses the instance-global ['coders']
 * query (also driven by the TopRail switcher). The returned `coderMap` is memoized
 * on the query data so passing it into React.memo'd rows (SegmentRow) doesn't bust
 * their comparator every render.
 *
 * `multiCoder` gates all attribution UI: a single-researcher project (the default)
 * sees zero change — no badges, no filter — so the chrome only appears once a
 * second coder exists.
 */
export function useCoders(): CoderContext {
  const query = useQuery({
    queryKey: CODERS_QUERY_KEY,
    queryFn: () => authApi.listCoders(),
    staleTime: 60_000,
  })
  const { data } = query
  const roster = useMemo(() => {
    const coders = data ?? []
    const machineCoders = coders.filter(isMachineCoder)
    return {
      coders,
      coderMap: new Map(coders.map(c => [c.id, c])),
      multiCoder: coders.length > 1,
      // Counted by SUBTRACTION so the two facts can never disagree about the
      // roster they describe, and so a kind this build does not know still
      // counts as a person (`isMachineCoder` is exact — see its note on why
      // unknown must read as human here).
      multiHumanCoder: coders.length - machineCoders.length > 1,
      machineCoders,
      // By SUBTRACTION, like `multiHumanCoder`: the two subsets cannot then
      // disagree about the roster, and an unknown kind stays selectable rather
      // than silently vanishing from the switcher.
      selectableCoders: coders.filter(c => !isMachineCoder(c)),
    }
  }, [data])
  return { ...roster, status: listStatus(query), query }
}

/**
 * #964 — call after anything that may have ADDED coders to this install (a
 * project import creates the file's coders; a merge can create them too).
 *
 * RESET, not invalidate: an invalidated query keeps serving the old roster as
 * an answer until the refetch lands, and a stale one-coder roster turns blind
 * mode off. Measured: importing a colleague's project and opening a
 * conversation showed 8 of their chips with no blind toggle, still there a
 * minute later, because nothing refetched the roster while the page stayed
 * open. A reset makes the roster honestly unknown, which the blind lens treats
 * as blind. Prefix-matched, so Settings' `['coders', 'all']` resets too.
 */
export function resetCoderRoster(queryClient: QueryClient): Promise<void> {
  return queryClient.resetQueries({ queryKey: CODERS_QUERY_KEY })
}
