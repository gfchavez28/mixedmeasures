export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  const diffDays = Math.floor(diffHrs / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * User-facing count phrasing — ONE source.
 *
 * Hand-rolled `n === 1 ? 'thing' : 'things'` ternaries were scattered across the
 * project card, the import previews and the wizard headings, and one of them
 * shipped as **"Preview (1 rows)"** (#640) — not an edge case, but what a
 * one-person recording shows by default, since same-speaker cue merging
 * collapses such a transcript to a single turn.
 *
 * `plural` picks the word; `countLabel` renders the whole phrase. Prefer
 * `countLabel` — it is the form that cannot be assembled wrongly.
 */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

export function countLabel(n: number, one: string, many: string): string {
  return `${n} ${plural(n, one, many)}`
}

/**
 * Names in a sentence — `A`, `A and B`, `A, B and C` — and past `max`, the
 * first `max` and how many more: `A, B, C and 2 more`. For the confirmations
 * and notices that must name what they touch without growing a dialog without
 * bound (#1175, #1139: the dialogs have no height limit).
 */
export function listNames(names: readonly string[], max = 3): string {
  if (names.length > max) {
    return `${names.slice(0, max).join(', ')} and ${names.length - max} more`
  }
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
