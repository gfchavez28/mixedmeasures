/**
 * Shared column type constants used across DatasetView,
 * RecodeWorkbench, and the crosswalk's TypePickerPopover.
 */

export const COLUMN_TYPES = [
  'ordinal', 'nominal', 'binary', 'numeric', 'percentage',
  'open_text', 'demographic', 'identifier', 'multi_select', 'skip',
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
// CONTINUOUS_TYPES — "a histogram is the right picture for this" (#522). A FOURTH
// set, and it differs from VALUE_NUMERIC_TYPES by exactly `ordinal` + `binary`,
// deliberately: those are discrete ordered categories with a handful of levels,
// where one bar per level IS the honest chart and binning would merge response
// options a researcher chose. Do not merge the two sets — the same reasoning
// that keeps VALUE_NUMERIC_TYPES and SCALE_SCORE_ELIGIBLE_TYPES apart (#399).
//
// Frontend-only on purpose: the binning is display-side over counts the server
// already sends, so there is no server gate to mirror and no backend twin.
export const CONTINUOUS_TYPES: readonly string[] = ['numeric', 'percentage']

// CROSSWALK_INELIGIBLE_TYPES — types that can never be an equivalence-group /
// variable-group member (#556b). Mirror of the backend frozenset of the same name
// in models/dataset.py, which gates the suggest pools server-side; this is the
// client half, which rejects the drag/dialog gestures before they round-trip.
//   skip       — discarded data.
//   identifier — holds row IDENTITY, not a measurement (#414): no value_numeric,
//                so the group's scale score can't compute.
// Identifier columns stay VISIBLE in the Unassigned panel on purpose (hiding them
// would remove the only place a mis-typed identity column is discoverable) — they
// are rejected at the point of ASSIGNMENT, not hidden. The crosswalk type picker
// is likewise unchanged; retyping a column TO identifier is a supported #414 move.
export const CROSSWALK_INELIGIBLE_TYPES: readonly string[] = ['skip', 'identifier']

export function isCrosswalkEligible(columnType: string): boolean {
  return !CROSSWALK_INELIGIBLE_TYPES.includes(columnType)
}

// VARIABLE_RULES_INELIGIBLE_TYPES — types that can never carry a value-label
// dictionary, a declared missing-value rule, or a recode definition. Mirror of
// the backend's `VALUE_LABEL_INELIGIBLE_TYPES` (models/dataset.py), which the
// SERVICE enforces because the import post-pass never passes a router (#589).
//   open_text  — free-form prose; there are no codes to label.
//   identifier — holds row IDENTITY, not a measurement (#414).
//
// 🔴 **SOURCE is a SECOND gate and it is NOT a type.** A COMPUTED column is
// refused by THREE separate endpoints — value labels 403 (`routers/recode.py`
// :889), missing values 403 (:958), recode definitions 403 (:431) — whatever
// its type is. The old "Value labels & missing…" modal never met this because
// it lived inside the popover's `manual || imported` block; folding the editor
// into the Variables view (design note E, slab 3) dropped that half of the
// gate, so a computed variable was offered a seeded 25-row dictionary, a
// missing-value tri-state and a rule editor, all of which 403 on save.
//
// Both questions are asked HERE so no surface can ask only one of them, and the
// answer names WHICH refusal applies — the two need different words on screen,
// and a bare boolean cannot say "this variable is defined by its formula".
export const VARIABLE_RULES_INELIGIBLE_TYPES: readonly string[] = ['open_text', 'identifier']

/** Why this variable cannot carry labels / missing rules / recodes, or `null`. */
export type VariableRulesRefusal = 'computed' | 'ineligible_type'

export function variableRulesRefusal(
  column: { column_type: string; source?: string | null },
): VariableRulesRefusal | null {
  if (column.source === 'computed') return 'computed'
  if (VARIABLE_RULES_INELIGIBLE_TYPES.includes(column.column_type)) return 'ineligible_type'
  return null
}

/**
 * How many distinct observed values still read as "this is plausibly a scale".
 *
 * Mirror of the import preview's `dataset_import.VALUE_LABEL_SEED_MAX_CODES`.
 * Above it, a column is continuous-ish (a score, an age, an income) and the
 * things that treat its values as a short code list stop being useful: seeding
 * one blank-label row per value is noise rather than a starting point, and a
 * frequency table becomes a wall rather than a summary.
 *
 * ⚠️ **Hoisted here from `ColumnDictionaryEditor` (#809) so the two surfaces
 * that make this judgement make the SAME one.** The dictionary editor's seed cap
 * and the frequency panel's collapse threshold are one question — *are these
 * values a code list?* — and two numbers answering it would drift, leaving a
 * column whose codes seed into the editor while the panel that shows them is
 * folded shut, or the reverse.
 */
export const VALUE_LABEL_SEED_MAX_CODES = 30

/**
 * Which endpoint deletes this variable, or `null` when nothing can.
 *
 * 🔴 **The backend has two delete endpoints and refuses a third case outright.**
 * `DELETE …/columns/{id}/manual` 403s anything whose `source` is not `"manual"`
 * (`routers/dataset.py::delete_manual_column`, "Only manual columns can be
 * deleted"); computed columns have their own endpoint; an IMPORTED column
 * cannot be deleted at all — it is part of the file the researcher brought in,
 * and removing one would silently disagree with their source data.
 *
 * ⚠️ **This predicate exists because the gate HAD ALREADY DRIFTED, in exactly
 * #807's shape.** `ColumnEditorPopover` offered "Delete column" only inside its
 * `manual` and `computed` branches, while `DatasetGridComponents`' column-header
 * context menu offered it with **no source gate at all** — so on an imported
 * corpus (every column of a real survey) right-clicking a header opened a
 * confirm dialog promising to *"permanently delete the column and all its
 * data"*, and the server then answered 403. A confirmed destructive action that
 * cannot happen is worse than an absent one: the researcher has already decided
 * to lose the data by the time they learn they cannot.
 *
 * ⚠️ A DERIVED column (Decision B) is `source="manual"` by force, so it deletes
 * through the manual endpoint like any hand-made column — deliberately, since a
 * derived variable is a snapshot the researcher can regenerate in two clicks.
 *
 * Guarded by a population scan (`components/variable-delete-one-gate.test.ts`):
 * every surface that offers the words must spend this predicate.
 */
export type VariableDeleteEndpoint = 'manual' | 'computed'

export function variableDeleteEndpoint(
  column: { source?: string | null },
): VariableDeleteEndpoint | null {
  if (column.source === 'computed') return 'computed'
  if (column.source === 'manual') return 'manual'
  return null
}

export const TYPE_BADGE_CLASSES: Record<string, string> = {
  // eslint-disable-next-line no-restricted-syntax -- categorical column-type color map hue (the internal design notes carve-out; siblings raw, not the mm-blue "selected" token)
  ordinal: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200',
  nominal: 'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-200',
  binary: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-200',
  numeric: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200',
  percentage: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200',
  open_text: 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-200',
  demographic: 'bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-200',
  identifier: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-200',
  multi_select: 'bg-pink-100 text-pink-700 dark:bg-pink-900/50 dark:text-pink-200',
  skip: 'bg-mm-bg text-mm-text-muted',
}
