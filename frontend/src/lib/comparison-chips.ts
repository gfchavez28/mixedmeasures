/**
 * Sidebar comparison group-chip derivation (#510, corrected #830b).
 *
 * The comparison response carries per-VARIABLE per-group valid n's — there is
 * no single "group n" when 2+ variables are selected (East can be n=4 for
 * Hours but n=5 for Satisfaction). The chips read one row's n's; with
 * multiple variables that claim must be attributed to the variable it
 * reflects, not presented as THE group size.
 *
 * 🔴 **#830(b): the row it read was `rows[0]`, whatever that row contained.**
 * A nominal variable holds no `value_numeric`, so its groups all come back
 * n=0 — and a selection whose FIRST variable was nominal (`School`, which is a
 * legitimate metric input per #371) made every chip read `(n=0)` directly above
 * a table reporting n=6 for the same groups. The label was honest about which
 * variable it used; the number was still wrong, and the two halves of the
 * screen contradicted each other.
 *
 * ⚠️ The fix is deliberately NOT "sum the rows" or "show a range" — that would
 * re-litigate #510, which decided that one variable's n is quotable as long as
 * it is ATTRIBUTED. It is: **skip rows that contribute no values at all**,
 * because such a row is not a measurement of the group's size in the first
 * place.
 */
export interface ComparisonChipRow {
  label: string
  group_stats: { group: string; n: number }[]
}

/** Did this variable contribute any values to any group? */
function hasAnyValues(row: ComparisonChipRow): boolean {
  return row.group_stats.some(s => s.n > 0)
}

export function comparisonGroupChips(
  groups: string[],
  rows: ComparisonChipRow[],
): { chips: { group: string; n: number | null }[]; nVariableLabel: string | null } {
  // The first row that actually measured something. Falling back to `rows[0]`
  // when NONE did keeps the old behaviour for the genuinely-all-empty case,
  // where every n is 0 and saying so is correct.
  const source: ComparisonChipRow | undefined = rows.find(hasAnyValues) ?? rows[0]
  const chips = groups.map(g => ({
    group: g,
    n: source?.group_stats.find(s => s.group === g)?.n ?? null,
  }))
  // Single variable → its n IS the group's n; 2+ → name the source variable.
  // ⚠️ Counted over the rows that COULD have supplied the n, so a selection of
  // "one nominal + one numeric" names nothing: there is only one measurement,
  // and attributing it would imply the other offers a different number.
  const measurable = rows.filter(hasAnyValues)
  const nVariableLabel = measurable.length > 1 && source ? source.label : null
  return { chips, nVariableLabel }
}
