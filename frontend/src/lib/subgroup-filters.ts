import type { SubgroupFilter } from '@/lib/api'

/**
 * #1534 D103 (1.5.9) — which subgroup filters COUNT, decided once for the Cross-analysis
 * panel's comparison and its CSV.
 *
 * The panel asked its comparison only for finished filters (`filtersReady`, inline), while
 * its export sent the raw list whenever it was non-empty — and under a parameter name the
 * route never read (`filters` against `filters_json`), so no release ever filtered the file.
 * With the name fixed, an unfinished filter would have reached the file: an all-zero
 * "comparison" for an `in` with nothing chosen, or *Filters: None* for a number not yet
 * typed (the server refuses both now, D104). Both readers take their list from here.
 */

/** A filter the researcher has finished: a column, and what its operator needs. */
export function isFilterComplete(f: SubgroupFilter): boolean {
  if (!f.column_id) return false
  if (f.operator === 'equals' || f.operator === 'in') return (f.values?.length ?? 0) > 0
  // `value` is the number input's TEXT — "0" is a finished value, "" is not.
  if (f.operator === 'gte' || f.operator === 'lte') return f.value !== undefined && f.value.trim() !== ''
  return f.operator === 'above_mean' || f.operator === 'below_mean'
}

/**
 * The list the comparison is drawn from: every filter when all are finished, else `null`
 * (no comparison is drawn, and nothing is exported as one). An empty list is `null` too —
 * no filters means no comparison.
 */
export function readyFilters(filters: SubgroupFilter[]): SubgroupFilter[] | null {
  if (filters.length === 0) return null
  return filters.every(isFilterComplete) ? filters : null
}

/** Some filter is set but not finished — the export waits and says so (D103). */
export function hasUnfinishedFilter(filters: SubgroupFilter[]): boolean {
  return filters.some(f => !isFilterComplete(f))
}

/** D103's reason, beside the export while a filter is unfinished. */
export const UNFINISHED_FILTER_REASON = 'Finish or remove the unfinished filter to export.'

/**
 * #1534 D107 — the focal datasets no filter judges are left out of the comparison (on both
 * sides) and named. Server twin: `routers/text_analysis.py::not_compared_note`.
 */
export function notComparedSentence(datasets: string[]): string | null {
  if (datasets.length === 0) return null
  const one = datasets.length === 1
  return `${datasets.join('; ')} ${one ? 'is' : 'are'} not in this comparison: none of the filters applies to ${one ? 'its' : 'their'} records.`
}

/**
 * #1534 D108 — the filters reach the frequency comparison and nothing else on the panel
 * (the cross-tabulation, code density and response length never took them). Server twin:
 * `routers/text_analysis.py::RESPONSE_LENGTH_UNFILTERED_HEADING`.
 */
export const FILTERS_REACH_NOTE = 'Filters apply to the code frequency comparison only.'
