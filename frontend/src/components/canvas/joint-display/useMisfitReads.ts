/**
 * Joint display slice 2, round 2 (r5-7) — the COUNT-ONLY case read of each row with a misfit:
 * the open construct's line and the Report view's note ask it here, with one key per row, so
 * they share one cache entry (the export makes the same read itself, `canvas-export.ts`).
 *
 * The scope is the compute's (D175 — `displayCoderScope(withholding, self)`), so a blind coder's
 * count follows their own coding and a rule over a rating score is refused by the server with the
 * column named (r3-3). States, never a "0" before an answer (`list-load-state.md` §1):
 * `idle` (not asked: the view does not need it yet) · `loading` · `failed` · `ready` ·
 * `no-viewer` (D96: blind with no viewer to scope to — no read is made).
 */
import { useQueries } from '@tanstack/react-query'
import { jointDisplayApi, type JointDisplayCasesResponse } from '@/lib/api'
import { listStatus } from '@/lib/list-status'
import type { DisplayCoderScope, JointDisplay } from '@/lib/joint-display'
import { caseCountRequest, hasMisfit } from '@/lib/joint-display-cases'

export type MisfitRead =
  | { status: 'idle' }
  | { status: 'no-viewer' }
  | { status: 'loading' }
  | { status: 'failed'; error: unknown; retry: () => void }
  | { status: 'ready'; data: JointDisplayCasesResponse }

export function useMisfitReads(
  projectId: number,
  display: JointDisplay,
  rowKeys: readonly string[],
  scope: DisplayCoderScope,
  /** `useBlindMode().settled` and whether the surface needs the count now. */
  enabled: boolean,
  /** Withholding with no viewer id (D96) — never read. */
  noViewer: boolean,
): Map<string, MisfitRead> {
  const rows = display.rows.filter(r => rowKeys.includes(r.key) && hasMisfit(r))
  const requests = rows.map(r => ({ key: r.key, request: caseCountRequest(display, r.key, scope) }))
  const queries = useQueries({
    queries: requests.map(({ request }) => ({
      // The dialog's root: a coding or a rating moves both (`coding-cache.ts`).
      queryKey: ['joint-display-cases', projectId, request],
      queryFn: () => jointDisplayApi.cases(projectId, request!),
      enabled: enabled && !noViewer && request != null,
      staleTime: 60_000,
    })),
  })
  const out = new Map<string, MisfitRead>()
  requests.forEach(({ key, request }, i) => {
    const q = queries[i]
    // The disabled cases are decided BEFORE the status (`list-load-state.md` §7's trap).
    if (noViewer) out.set(key, { status: 'no-viewer' })
    else if (!enabled || request == null) out.set(key, { status: 'idle' })
    else {
      const s = listStatus(q)
      out.set(key, s === 'ready' ? { status: 'ready', data: q.data! }
        : s === 'failed' ? { status: 'failed', error: q.error, retry: () => { void q.refetch() } }
          : { status: 'loading' })
    }
  })
  return out
}
