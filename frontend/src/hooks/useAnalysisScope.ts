import { useMemo } from 'react'
import { useAuth } from '@/lib/auth-context'
import { useBlindMode } from '@/hooks/useBlindMode'
import { analysisScope, UNSENT_SCOPE, type AnalysisScope } from '@/lib/analysis-scope'

/**
 * #1615 — the coder scope every QUANTITATIVE read sends: the viewer alone while `withholding`,
 * every coder otherwise (`lib/analysis-scope.ts`).
 *
 * `scopeReady` is false until the blind state is `settled`, and stays false while withholding
 * with no self id (D96 — fail closed). A query that sends the scope puts `scopeKey` in its KEY
 * and waits on `scopeReady` (`multicoder.md` *Blind-scope cache correctness*); before it is
 * ready the scope is `UNSENT_SCOPE`, whose key never matches a sent one.
 *
 * The same rule as `useBlindScope` (#1608), in the two spellings these doors need — a JSON
 * body's `coder_ids: number[]` and a query string's `coder_ids`.
 */
export function useAnalysisScope(projectId: number): AnalysisScope & { scopeReady: boolean } {
  const { user } = useAuth()
  const { withholding, settled } = useBlindMode(projectId)
  const self = user?.id ?? null
  return useMemo(() => {
    const scope = settled ? analysisScope(withholding, self) : null
    return scope ? { ...scope, scopeReady: true } : { ...UNSENT_SCOPE, scopeReady: false }
  }, [settled, withholding, self])
}
