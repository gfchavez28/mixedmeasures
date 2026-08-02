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
