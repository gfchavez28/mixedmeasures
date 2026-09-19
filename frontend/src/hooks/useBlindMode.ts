import { useCallback, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/lib/auth-context'
import { useCoders } from '@/hooks/useCoders'
import { codeAnalysisApi } from '@/lib/api'
import { onlyCoders, type CoderLens } from '@/lib/coder-color'

/**
 * Blind coding (Track J · J2-5, D4 / DEC-G). While blind, a coder does not see
 * colleagues' codes/coverage — mechanically `hidden = all-but-self` fed into the
 * existing J1 visibility lens (`isCoderVisible`), plus the comparison tabs +
 * per-coder coverage + the coder filter are hidden. ONE per-(project, coder) state:
 * a single "Reveal colleagues' work" toggle un-blinds everything at once and LOGS it
 * (honesty, not a lock). Default ON for ≥2-coder projects; single-coder ⇒ never blind.
 *
 * Persistence: localStorage stores the *override* (the coder chose to reveal), keyed
 * by `(project, coder)` so a local coder-switch re-blinds the new coder. Re-hiding
 * (revealed → blind) clears the flag and does NOT log — only breaking blindness logs.
 */
const revealKey = (projectId: number, userId: number | null) =>
  `mm-blind-revealed-${projectId}-${userId ?? 'anon'}`

/**
 * Read the per-(project, coder) reveal flag straight from storage. Exported for
 * transient surfaces (the TopRail coder switcher) that must reflect the CURRENT
 * blind state each time they open — a second `useBlindMode` instance would hold
 * stale local state and not react to a reveal/blind toggle made elsewhere.
 */
export const readRevealed = (projectId: number, userId: number | null): boolean => {
  try { return localStorage.getItem(revealKey(projectId, userId)) === '1' }
  catch { return false }
}

/**
 * #964 — blind mode is TWO facts, and they must not share a variable (#790's rule).
 *
 * - `blind` is what a surface may SAY: the roster answered, it has a colleague,
 *   and this coder has not revealed. It drives the toggle, the "Blind mode is on"
 *   notices and the gauge wording — which must not claim blindness on a
 *   single-coder install while its roster loads.
 * - `withholding` is what a surface must DO, and it fails CLOSED: true whenever
 *   `blind` is, AND while the roster has not answered (loading, failed, or reset
 *   after an import) unless this coder revealed. It drives every lens and every
 *   coder scope. Before #964 both were `blind`, so an unanswered roster — read as
 *   a one-person roster — showed colleagues' coding.
 *
 * `withholding` without `blind` only while `settled` is false.
 */
export interface BlindModeState {
  /** The claim: colleagues' coding is hidden AND we know there are colleagues. */
  blind: boolean
  /** The act (fail-closed): colleagues' coding must be hidden now. Drives lenses + scopes. */
  withholding: boolean
  /**
   * The blind state no longer depends on an unanswered roster (it answered, or
   * this coder revealed). A SERVER-scoped query waits for this rather than
   * fetching under a scope that is about to change — on a single-coder install a
   * fail-closed guess is self-only, so it would fetch twice.
   */
  settled: boolean
  /**
   * The lens to apply while `withholding`: all-but-self from the roster once it
   * has answered (archived colleagues are not on it — #451/#503 keep their coding
   * in the GAUGES), or an allow-list of self before it has, which needs no roster.
   */
  blindLens: CoderLens
  /** Flip blindness. Revealing logs the reveal (audit trail); re-hiding is silent. */
  toggleReveal: (surface?: string) => void
}

export function useBlindMode(projectId: number): BlindModeState {
  const { user } = useAuth()
  const { coders, multiCoder, status: rosterStatus } = useCoders()
  const self = user?.id ?? null

  const [revealed, setRevealed] = useState<boolean>(() => readRevealed(projectId, self))

  // Re-read the persisted flag when the project or active coder changes (the key
  // includes the coder id, so a switched-in coder starts blind again). Reset during
  // render via a key ref — the React-blessed alternative to a set-state effect; it
  // applies synchronously with no blind→revealed flash.
  const keyRef = useRef(revealKey(projectId, self))
  const currentKey = revealKey(projectId, self)
  if (currentKey !== keyRef.current) {
    keyRef.current = currentKey
    setRevealed(readRevealed(projectId, self))
  }

  const rosterKnown = rosterStatus === 'ready'
  // `multiCoder` is only ever true of an answered roster, so `blind` needs no status.
  const blind = multiCoder && !revealed
  const withholding = !revealed && (multiCoder || !rosterKnown)
  const settled = revealed || rosterKnown

  // Fail-closed on a missing self id in both arms: the set then names every
  // roster coder, and the allow-list is empty.
  const blindLens = useMemo<CoderLens>(
    () => rosterKnown
      ? new Set(coders.filter(c => c.id !== self).map(c => c.id))
      : onlyCoders(self != null ? [self] : []),
    [rosterKnown, coders, self],
  )

  // Track the live `revealed` so toggleReveal computes `next` without a stale closure
  // — AND so the side effects live OUTSIDE the setState updater. React StrictMode
  // double-invokes updater functions (dev), so a reveal-log fired from inside the
  // updater would write TWO audit rows per reveal. Keep the updater pure.
  const revealedRef = useRef(revealed)
  revealedRef.current = revealed

  const toggleReveal = useCallback((surface?: string) => {
    const next = !revealedRef.current
    try {
      if (next) localStorage.setItem(revealKey(projectId, self), '1')
      else localStorage.removeItem(revealKey(projectId, self))
    } catch { /* private mode / quota — non-fatal */ }
    // Only BREAKING blindness (blind → revealed) is logged.
    if (next) codeAnalysisApi.revealBlindMode(projectId, { surface }).catch(() => { /* best-effort */ })
    setRevealed(next)
  }, [projectId, self])

  return { blind, withholding, settled, blindLens, toggleReveal }
}
