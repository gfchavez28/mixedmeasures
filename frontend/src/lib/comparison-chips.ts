/**
 * Sidebar comparison group-chip derivation (#510).
 *
 * The comparison response carries per-VARIABLE per-group valid n's — there is
 * no single "group n" when 2+ variables are selected (East can be n=4 for
 * Hours but n=5 for Satisfaction). The chips read the first row's n's; with
 * multiple variables that claim must be attributed to the variable it
 * reflects, not presented as THE group size.
 */
export interface ComparisonChipRow {
  label: string
  group_stats: { group: string; n: number }[]
}

export function comparisonGroupChips(
  groups: string[],
  rows: ComparisonChipRow[],
): { chips: { group: string; n: number | null }[]; nVariableLabel: string | null } {
  const first: ComparisonChipRow | undefined = rows[0]
  const chips = groups.map(g => ({
    group: g,
    n: first?.group_stats.find(s => s.group === g)?.n ?? null,
  }))
  // Single variable → its n IS the group's n; 2+ → name the source variable.
  const nVariableLabel = rows.length > 1 && first ? first.label : null
  return { chips, nVariableLabel }
}
