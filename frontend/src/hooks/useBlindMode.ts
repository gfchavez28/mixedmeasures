import { useCallback, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/lib/auth-context'
import { useCoders } from '@/hooks/useCoders'
import { codeAnalysisApi } from '@/lib/api'

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

export interface BlindModeState {
  /** true = colleagues' coding is hidden (the independent-coding default). */
  blind: boolean
  /** All-but-self coder ids when blind; empty when revealed. Feed to the J1 hidden-set. */
  blindHiddenSet: Set<number>
  /** Flip blindness. Revealing logs the reveal (audit trail); re-hiding is silent. */
  toggleReveal: (surface?: string) => void
}

export function useBlindMode(projectId: number): BlindModeState {
  const { user } = useAuth()
  const { coders, multiCoder } = useCoders()
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

  const blind = multiCoder && !revealed

  const blindHiddenSet = useMemo(
    () => blind ? new Set(coders.filter(c => c.id !== self).map(c => c.id)) : new Set<number>(),
    [blind, coders, self],
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

  return { blind, blindHiddenSet, toggleReveal }
}
