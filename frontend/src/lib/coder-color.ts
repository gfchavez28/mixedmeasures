// Coder badge colors + initials (Track J · J1).
//
// A coder's badge must be dual-encoded — color AND initials — never color alone,
// so it stays legible for colorblind users (mirrors the speaker-badge pattern).
// `coderColor` falls back to a stable palette slot by id when no display_color is set.

export const CODER_PALETTE = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#10b981', // emerald
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
]

export function coderColor(coder: { id: number; display_color?: string | null }): string {
  if (coder.display_color) return coder.display_color
  return CODER_PALETTE[coder.id % CODER_PALETTE.length]
}

export function coderInitials(username: string): string {
  const parts = username.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// Per-coder visibility predicate (Track J · J1). `hidden` is the set of coder ids
// the user has chosen to hide. Unattributed (legacy) codes are never hidden, and
// the popover never lets you add your OWN id to `hidden`, so your codes always show.
export function isCoderVisible(applierId: number | null | undefined, hidden?: Set<number>): boolean {
  if (!hidden || hidden.size === 0) return true
  if (applierId == null) return true
  return !hidden.has(applierId)
}

// #451 — archived coders who coded a source are absent from the roster `coderMap`
// (useCoders excludes archived), so their chips would render anonymous. Fold the
// per-source `extraCoders` (archived-who-coded) INTO the chip map so they render
// attributed (and flagged archived). Returns the base unchanged when there are none.
export function mergeArchivedIntoCoderMap<T extends { id: number }>(
  base: Map<number, T>,
  extras: T[],
): Map<number, T> {
  if (extras.length === 0) return base
  const m = new Map(base)
  for (const e of extras) if (!m.has(e.id)) m.set(e.id, e)
  return m
}

// #451 — archived coders' chips are hidden by DEFAULT (declutter); a "view all
// coders" toggle reveals them. Force the archived ids into the hidden set unless
// the user opted to show them. (When already revealed, the explicit set wins.)
export function chipHiddenWithArchived(
  hidden: Set<number>,
  archivedIds: Set<number>,
  showArchived: boolean,
): Set<number> {
  if (showArchived || archivedIds.size === 0) return hidden
  const s = new Set(hidden)
  for (const id of archivedIds) s.add(id)
  return s
}
