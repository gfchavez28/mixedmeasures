/**
 * The comparison panel's output types — declared ONCE (#525b).
 *
 * Before this they were declared three times: the union and its runtime
 * sanitiser in `useAnalysisUrlState.ts`, the prop type in
 * `CorrelationsComparisonsContent.tsx`, and the picker array beside it. Only
 * two of the three were types, so adding a fourth output meant one edit
 * TypeScript could not check — and the sanitiser is a runtime `||` chain, which
 * silently rewrites an unknown value to the table rather than failing.
 *
 * The enumeration-debt remedy from the internal design notes: derive the consumers from the one
 * artifact a new variant must touch, rather than asking each to remember.
 */

export const COMPARISON_CHART_TYPES = [
  'comparison_table',
  'comparison_dumbbell',
  'comparison_grouped_bar',
  'comparison_box',
  'comparison_qq',
] as const

export type ComparisonChartType = (typeof COMPARISON_CHART_TYPES)[number]

export const DEFAULT_COMPARISON_CHART_TYPE: ComparisonChartType = 'comparison_table'

/**
 * Sanitise rather than cast: stale deep links may still carry retired values
 * (e.g. `forest_plot`, removed with #426), and a URL is user-editable input.
 */
export function isComparisonChartType(v: string | null): v is ComparisonChartType {
  return v != null && (COMPARISON_CHART_TYPES as readonly string[]).includes(v)
}

export function toComparisonChartType(v: string | null): ComparisonChartType {
  return isComparisonChartType(v) ? v : DEFAULT_COMPARISON_CHART_TYPE
}

/**
 * ⚠️ `satisfies Record<…>` so a type added above without a label here is a
 * COMPILE error — the `ci-label.ts` lesson (#42), where a ternary let an
 * unknown value fall through to a bare wrong label.
 */
export const COMPARISON_CHART_LABELS = {
  comparison_table: 'Table',
  comparison_dumbbell: 'Dumbbell',
  comparison_grouped_bar: 'Grouped',
  comparison_box: 'Box Plot',
  comparison_qq: 'Q–Q Plot',
} satisfies Record<ComparisonChartType, string>
