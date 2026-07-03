// Track J · J3-2b: pure divergent-code reconcile helpers for the merge flow.
// Kept out of the page component so the new/collapse/link decision logic that builds the
// `code_mapping` wire payload — and the provenance "merge plan" the review step renders —
// is unit-testable. Decisions are keyed by the file code's stable `uuid`.

import type { MergeCodePreview, MergeCodeCandidate, CodeMapping, CodeMappingDecision } from './api'

// Name-similarity bars (0–1, matching the backend `similarity` scale). Link is offered at
// a "close" name match; bulk Collapse uses a STRICTER "near-exact" bar because collapse is
// destructive (it removes the incoming code). These mirror the backend confident threshold.
export const MERGE_LINK_BAR = 0.70
export const MERGE_COLLAPSE_BAR = 0.95

/** A local code, the minimum shape this module needs (from `codesApi.list`). */
export interface LocalCodeLite {
  id: number
  name: string
  color: string | null
}

/**
 * Smart default per divergent code (D-2, conservative): ALWAYS `new`. A confident
 * name-match is surfaced in the UI as a ranked opt-in, never auto-selected — collapse is
 * destructive and link changes the codebook, so the researcher chooses them deliberately.
 */
export function defaultCodeDecisions(previews: MergeCodePreview[]): Record<string, CodeMappingDecision> {
  return Object.fromEntries(previews.map(p => [p.uuid, { action: 'new' } as CodeMappingDecision]))
}

export function bestCandidate(p: MergeCodePreview): MergeCodeCandidate | null {
  return p.candidates[0] ?? null
}

/** Default combined label for a link group: local name first, then the incoming name. */
export function combinedLabel(localName: string, fileName: string): string {
  return `${localName} / ${fileName}`.slice(0, 255)
}

/**
 * Apply a bulk action across all divergent codes. `new` resets every row. `collapse` /
 * `link` act ONLY on rows whose best candidate clears the bar (collapse's bar is stricter),
 * targeting that best candidate; rows below the bar are left untouched.
 */
export function applyBulkCode(
  action: 'new' | 'collapse' | 'link',
  previews: MergeCodePreview[],
  decisions: Record<string, CodeMappingDecision>,
  localNameById: Record<number, string>,
): Record<string, CodeMappingDecision> {
  const next = { ...decisions }
  const bar = action === 'collapse' ? MERGE_COLLAPSE_BAR : MERGE_LINK_BAR
  for (const p of previews) {
    if (action === 'new') { next[p.uuid] = { action: 'new' }; continue }
    const best = bestCandidate(p)
    if (best && best.similarity >= bar) {
      next[p.uuid] = action === 'collapse'
        ? { action: 'collapse', target_code_id: best.code_id }
        : {
            action: 'link',
            target_code_id: best.code_id,
            combined_label: combinedLabel(localNameById[best.code_id] ?? best.name, p.name),
          }
    }
  }
  return next
}

/**
 * Build the `code_mapping` wire payload from the per-code decisions. Keyed by the file
 * code's uuid. `combined_label` is sent only when set (else the backend defaults it).
 */
export function buildCodeMapping(
  previews: MergeCodePreview[],
  decisions: Record<string, CodeMappingDecision>,
): CodeMapping {
  const out: CodeMapping = {}
  for (const p of previews) {
    const d = decisions[p.uuid]
    if (!d) continue
    if (d.action === 'new') out[p.uuid] = { action: 'new' }
    else if (d.action === 'collapse') out[p.uuid] = { action: 'collapse', target_code_id: d.target_code_id }
    else out[p.uuid] = d.combined_label
      ? { action: 'link', target_code_id: d.target_code_id, combined_label: d.combined_label }
      : { action: 'link', target_code_id: d.target_code_id }
  }
  return out
}

/** Running tally of the decisions for the reconcile footer. */
export function codeDecisionSummary(
  decisions: Record<string, CodeMappingDecision>,
): { newCount: number; collapsed: number; linked: number } {
  let newCount = 0, collapsed = 0, linked = 0
  for (const d of Object.values(decisions)) {
    if (d.action === 'new') newCount++
    else if (d.action === 'collapse') collapsed++
    else linked++
  }
  return { newCount, collapsed, linked }
}

// ── Provenance "merge plan" for the review matrix ────────────────────────────

export interface MergeReviewSide {
  name: string
  color: string | null
}
export interface MergeReviewRow {
  kind: 'unchanged' | 'collapse-target' | 'link-group' | 'new'
  /** The merged-codebook label: the group label for a link, else the surviving code name. */
  finalName: string
  finalColor: string | null
  /** Your-codebook side (null for a brand-new incoming code). */
  local: MergeReviewSide | null
  /** Incoming-file side (null for an unchanged local code). `removed` = collapsed away. */
  incoming: (MergeReviewSide & { status: 'new' | 'removed' }) | null
}

/**
 * Compute the provenance rows the review matrix renders, purely from the local codebook +
 * the divergent-code previews + the reconcile decisions (no backend call). A local code is
 * an unchanged row unless it's the target of a collapse (it absorbs the incoming code) or a
 * link (it becomes a group with the incoming code). Each divergent code with `new` adds its
 * own row; `collapse`/`link` codes fold into their target's row.
 */
export function buildMergePlan(
  localCodes: LocalCodeLite[],
  previews: MergeCodePreview[],
  decisions: Record<string, CodeMappingDecision>,
): MergeReviewRow[] {
  // target_code_id -> the divergent codes resolving onto it (first wins for the row label).
  const byTarget = new Map<number, { p: MergeCodePreview; d: CodeMappingDecision }[]>()
  for (const p of previews) {
    const d = decisions[p.uuid]
    if (!d || d.action === 'new') continue
    const list = byTarget.get(d.target_code_id) ?? []
    list.push({ p, d })
    byTarget.set(d.target_code_id, list)
  }

  const rows: MergeReviewRow[] = localCodes.map(lc => {
    const targeting = byTarget.get(lc.id)
    if (targeting && targeting.length) {
      const linked = targeting.find(t => t.d.action === 'link')
      const first = linked ?? targeting[0]
      if (first.d.action === 'link') {
        const label = (first.d.combined_label || combinedLabel(lc.name, first.p.name))
        return {
          kind: 'link-group', finalName: label, finalColor: lc.color,
          local: { name: lc.name, color: lc.color },
          incoming: { name: first.p.name, color: first.p.color, status: 'new' },
        }
      }
      return {
        kind: 'collapse-target', finalName: lc.name, finalColor: lc.color,
        local: { name: lc.name, color: lc.color },
        incoming: { name: first.p.name, color: first.p.color, status: 'removed' },
      }
    }
    return {
      kind: 'unchanged', finalName: lc.name, finalColor: lc.color,
      local: { name: lc.name, color: lc.color }, incoming: null,
    }
  })

  for (const p of previews) {
    if (decisions[p.uuid]?.action === 'new') {
      rows.push({
        kind: 'new', finalName: p.name, finalColor: p.color,
        local: null, incoming: { name: p.name, color: p.color, status: 'new' },
      })
    }
  }
  return rows
}
