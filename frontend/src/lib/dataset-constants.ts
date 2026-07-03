/**
 * Shared column type constants used across DatasetView,
 * RecodeWorkbench, and the crosswalk's TypePickerPopover.
 */

export const COLUMN_TYPES = [
  'ordinal', 'nominal', 'binary', 'numeric', 'percentage',
  'open_text', 'demographic', 'multi_select', 'skip',
] as const

// ── Column-type eligibility sets — single source of truth (invariant I-D, #399) ──
// Frontend mirror of the backend concepts in models/dataset.py. Keep in sync.
//
// CATEGORICAL_GROUPING_TYPES — valid axes for group-by and cross-tab. Categorical
//   only: continuous numeric/percentage are EXCLUDED (bucketing a continuous var by
//   raw value is noise — bin it via recode first). Binary IS a category. Decided
//   2026-05-26; cardinality-aware grouping deferred to v1.x.
// FILTERABLE_TYPES — valid columns for subgroup filters. A SUPERSET: numeric is
//   included because filtering has range operators (>=, <=, above/below mean) that
//   are meaningful on a continuous variable even though grouping by it is not.
// VALUE_NUMERIC_TYPES — "has a usable value_numeric" (numeric operand); mirrors the
//   backend set of the same name. Used for data-quality / MCAR-style numeric checks.
export const CATEGORICAL_GROUPING_TYPES: readonly string[] = [
  'ordinal', 'nominal', 'binary', 'demographic',
]
export const FILTERABLE_TYPES: readonly string[] = [
  ...CATEGORICAL_GROUPING_TYPES, 'numeric',
]
export const VALUE_NUMERIC_TYPES: readonly string[] = [
  'ordinal', 'numeric', 'percentage', 'binary',
]

export const TYPE_BADGE_CLASSES: Record<string, string> = {
  // eslint-disable-next-line no-restricted-syntax -- categorical column-type color map hue (DESIGN.md §5 carve-out; siblings raw, not the mm-blue "selected" token)
  ordinal: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200',
  nominal: 'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-200',
  binary: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-200',
  numeric: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-200',
  percentage: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-200',
  open_text: 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-200',
  demographic: 'bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-200',
  multi_select: 'bg-pink-100 text-pink-700 dark:bg-pink-900/50 dark:text-pink-200',
  skip: 'bg-mm-bg text-mm-text-muted',
}
