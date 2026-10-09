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
  // #1135 — initials are LETTERS and DIGITS: "Priya (lead)" read "P(" on every
  // badge, the parenthesis taken for the second word's initial. A word with no
  // letter or digit in it (a lone "—") contributes nothing. Code points, not
  // UTF-16 units, so an astral letter is not split in half.
  const words = username.trim().split(/\s+/)
    .map(w => Array.from(w.matchAll(/[\p{L}\p{N}]/gu), m => m[0]))
    .filter(chars => chars.length > 0)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).join('').toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/**
 * #964 — an ALLOW-LIST lens: every attributed applier NOT in `allow` is hidden.
 *
 * Blind mode's lens is "everyone but me", and a HIDE set can only say that by
 * naming everyone — which it learns from the coder roster. While the roster has
 * not answered (or failed, or predates an import that added coders) that list
 * is empty, so a hide set built from it hides NOBODY: blind mode failed OPEN,
 * showing colleagues' coding (measured: 19 chips instead of 5; and 8 colleague
 * chips on a project imported seconds earlier). This arm says "only these" with
 * no roster at all. Build it with `onlyCoders`.
 */
export interface CoderAllowList {
  readonly allow: ReadonlySet<number>
}

/**
 * The per-coder visibility lens every chip, gauge and jump-to-uncoded reads:
 * a SET of hidden coder ids (the coder filter; blind mode once the roster is
 * known) or an ALLOW-LIST (blind mode before it is).
 */
export type CoderLens = Set<number> | CoderAllowList

export function onlyCoders(ids: Iterable<number>): CoderAllowList {
  return { allow: new Set(ids) }
}

export function isAllowList(lens: CoderLens): lens is CoderAllowList {
  return !(lens instanceof Set)
}

/** Does this lens hide anyone? (A gauge says "coded by visible coders" when it does.) */
export function lensHidesAnyCoder(lens: CoderLens | undefined): boolean {
  if (!lens) return false
  return isAllowList(lens) || lens.size > 0
}

// Per-coder visibility predicate (Track J · J1). `hidden` is the set of coder ids
// the user has chosen to hide. Unattributed (legacy) codes are never hidden, and
// the popover never lets you add your OWN id to `hidden`, so your codes always show.
// #964: an allow-list shows only its members — and still never hides unattributed.
export function isCoderVisible(applierId: number | null | undefined, hidden?: CoderLens): boolean {
  if (!hidden) return true
  if (applierId == null) return true
  if (isAllowList(hidden)) return hidden.allow.has(applierId)
  return hidden.size === 0 || !hidden.has(applierId)
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
// #964: an allow-list already hides every archived coder, so it passes through.
// ⚠️ Callers pass `showArchived && !withholding`: an archived colleague is still a
// colleague, and "View all" is a coder-FILTER choice that must not survive re-blinding.
export function chipHiddenWithArchived(
  hidden: CoderLens,
  archivedIds: Set<number>,
  showArchived: boolean,
): CoderLens {
  if (isAllowList(hidden)) return hidden
  if (showArchived || archivedIds.size === 0) return hidden
  const s = new Set(hidden)
  for (const id of archivedIds) s.add(id)
  return s
}
