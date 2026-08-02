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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
