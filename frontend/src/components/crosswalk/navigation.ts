/**
 * Shared navigation helpers for the crosswalk.
 *
 * `navigateToScaleScore` navigates from a bracket's Σ badge to the Analysis
 * View's quantitative tab pre-focused on the source domain. The previous
 * implementation wrote only `metric_id` (and `metricType`/`tab`) to the URL,
 * which AnalysisView's `useAnalysisUrlState` doesn't parse — landing the user
 * on a blank tab with the metric-type filter applied but no domain selected.
 * Fix (#320): also write `domains=${domainId}`. AnalysisView already parses
 * that param (`useAnalysisUrlState.ts:99-101`) and triggers `useQuickCompute`
 * to auto-resolve the domain_aggregate metric for the chosen domain.
 *
 * The `metric_id` param is retained as a forward-compatible hint for Phase 4.7's
 * `DomainPickerPopover`, which will read it to pre-select a specific metric
 * variant (ungrouped vs grouped-by-dimension) when a domain has multiple
 * `domain_aggregate` metrics. Today no consumer reads it; the URL just carries
 * it for future use. setUrlParam / setSearchParams calls in AnalysisView don't
 * strip unknown keys (verified: useAnalysisUrlState:149-159 reads `prev` and
 * only mutates the targeted key), so the hint survives subsequent filter
 * changes.
 *
 * Stale-domain edge case (deferred to Phase 4.7): if `domains=N` references a
 * domain that was deleted between the click and the page load, AnalysisView's
 * downstream queries return empty results / 404 with no error toast. Graceful
 * enough as a fallback; a URL-pruning useEffect could remove stale IDs after
 * the domains list loads — Phase 4.7 polish.
 */

import type { NavigateFunction } from 'react-router-dom'

export function navigateToScaleScore(
  navigate: NavigateFunction,
  projectId: number,
  metricId: number,
  domainId: number,
) {
  navigate(
    `/projects/${projectId}/analysis/quantitative` +
      `?tab=descriptives&metricType=domain_aggregate` +
      `&domains=${domainId}&metric_id=${metricId}`,
  )
}

/**
 * Tagged-form `?focusRow=` URL param (Phase 4.9).
 *
 * Replaces the legacy `?focusRowId=N` (which post-Path-A scrolled to a dead
 * `crosswalk-orphan-row-${id}` test id and silently no-op'd). The tagged
 * form encodes both the kind (`eg` for equivalence-group rows, `col` for
 * synthetic single-cell rows) and the id, so `useCrosswalkNavigation` can
 * pick the correct row testid without ambiguity.
 *
 * Tolerates URL-encoded colons (`eg%3A42` → `eg:42`) so deep links shared
 * via tools that aggressively encode reserved chars survive the round trip.
 */

export type FocusRowKind = 'eg' | 'col'

export interface ParsedFocusRow {
  kind: FocusRowKind
  id: number
}

export function parseFocusRow(value: string | null): ParsedFocusRow | null {
  if (!value) return null
  const decoded = decodeURIComponent(value)
  const colonIdx = decoded.indexOf(':')
  if (colonIdx <= 0) return null
  const kind = decoded.slice(0, colonIdx)
  const idStr = decoded.slice(colonIdx + 1)
  if (kind !== 'eg' && kind !== 'col') return null
  const id = Number(idStr)
  if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) return null
  return { kind, id }
}

export function formatFocusRow(kind: FocusRowKind, id: number): string {
  return `${kind}:${id}`
}
