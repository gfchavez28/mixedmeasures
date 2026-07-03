import type { ImportValidationResult } from './api'

// Track J · J3-2: hand off a colleague's .mmproject from the Dashboard import dialog
// to the full-page merge flow. A File can't ride a route param, so we stash it (plus
// the already-computed validate result, which carries `merge_coders` + `existing_project`)
// in a module-level single slot and consume it once on the merge page. Mirrors
// `pending-import-files.ts` (module singleton + 30s stale window + consume-once).

interface PendingMerge {
  file: File
  validation: ImportValidationResult
  targetProjectId: number
  timestamp: number
}

let pending: PendingMerge | null = null

export function setPendingMerge(file: File, validation: ImportValidationResult, targetProjectId: number): void {
  pending = { file, validation, targetProjectId, timestamp: Date.now() }
}

export function consumePendingMerge(targetProjectId: number): PendingMerge | null {
  if (!pending || pending.targetProjectId !== targetProjectId) return null
  // Discard if older than 30 seconds (stale safety net) — matches pending-import-files.
  if (Date.now() - pending.timestamp > 30_000) {
    pending = null
    return null
  }
  const current = pending
  pending = null
  return current
}
