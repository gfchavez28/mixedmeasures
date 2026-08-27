/**
 * Canonical display label for a dataset column (#575).
 *
 * A `DatasetColumn` carries two human-facing fields: `column_name` (a short,
 * often-NULL display name) and `column_text` (the label / question text, always
 * set). Historically ~5 ad-hoc precedence chains shipped, several of which
 * rendered BLANK when `column_name` was NULL (the search subtitle, the single-
 * column picker, a status-bar branch). This is the ONE place that decision lives.
 *
 * Precedence mirrors the dominant existing convention (`column_name || column_text`,
 * 38 sites): short name first, then the descriptive label, then the machine code,
 * then a last-resort `Column {id}`. New display surfaces MUST route through this
 * rather than hand-rolling a fallback chain.
 *
 * Deliberately NOT routed here (separate, intentional policies): R/Excel exports
 * use `column_text` as the variable label; the crosswalk shows `column_code`
 * (the machine identifier) + `column_text`.
 */

export interface ColumnLabelFields {
  id: number
  column_name?: string | null
  column_text?: string | null
  column_code?: string | null
}

export function columnDisplayLabel(
  col: ColumnLabelFields,
  opts?: { maxLength?: number },
): string {
  const raw =
    (col.column_name && col.column_name.trim()) ||
    (col.column_text && col.column_text.trim()) ||
    (col.column_code && col.column_code.trim()) ||
    `Column ${col.id}`
  const max = opts?.maxLength
  return max && raw.length > max ? raw.slice(0, max) : raw
}

/**
 * `columnDisplayLabel` for a space-constrained chip, with the truncation MARKED.
 *
 * ⚠️ `columnDisplayLabel`'s own `maxLength` slices SILENTLY, which is right for
 * an accessible name (a trailing "…" read aloud is noise) and wrong for a
 * visible chip, where an unmarked cut reads as the variable's actual name. Three
 * call sites wanted the ellipsis and exactly one had it, so it lives here now
 * rather than being re-inlined per chip.
 */
export function truncatedColumnLabel(col: ColumnLabelFields, maxLength: number): string {
  const full = columnDisplayLabel(col)
  return full.length > maxLength ? `${full.slice(0, maxLength)}…` : full
}

// ── Swapping the two fields (#575) ───────────────────────────────────────────
//
// The other half of the same relationship, so it lives beside the precedence
// rule rather than in the component that renders the button. (It also keeps
// `VariableActions.tsx` from exporting non-components, which the lint ceiling
// flags — the same call this project has made three times before.)

/**
 * Swap `column_name` ↔ `column_text`, or PROMOTE the label into the name when
 * there is no short name yet.
 *
 * ⚠️ `column_text` is NOT NULL, so a true swap on a name-less column would
 * blank it — and `columnDisplayLabel` above would then fall through to the
 * machine code, leaving the variable unidentifiable on every surface.
 * Promotion (leaving the label in place) is what prevents that, and it is why
 * the button's own words change with the state.
 *
 * Returns `null` when the swap would be a no-op, so the caller records nothing
 * in the undo stack for a press that changes nothing.
 */
export function swapNameLabelValues(
  column: { column_name?: string | null; column_text: string },
): { newName: string; newText: string } | null {
  const name = (column.column_name || '').trim()
  const text = (column.column_text || '').trim()
  if (!text) return null
  const newName = text
  const newText = name || text // promote when no short name (never empty column_text)
  if (newName === (column.column_name ?? '') && newText === column.column_text) return null
  return { newName, newText }
}

export function swapNameLabelWords(column: { column_name?: string | null }): string {
  return column.column_name ? 'Swap name ↔ label' : 'Use label as short name'
}
