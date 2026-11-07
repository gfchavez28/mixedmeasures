/**
 * How a p-value was computed, when the method is chosen by the DATA — #1326
 * STAT-12 (1.5.9, D58). The FIFTEENTH member of the stated-basis family
 * (the internal design notes): the server states it, the client shows it
 * and never infers it.
 *
 * Mann–Whitney takes R's `wilcox.test` rule: an EXACT p when neither group has
 * 50 or more values and no value is tied; otherwise the normal approximation
 * with a continuity correction. Two rows of one table can therefore carry
 * different methods, which is why the method rides each result.
 *
 * Constants are hand-mirrored with `backend/app/services/comparisons.py`
 * (`P_METHOD_*`) — no codegen — so
 * `backend/tests/test_mann_whitney_p_method.py::TestCrossLanguageContract`
 * reads this file. An UNKNOWN method renders nothing (a payload from a newer
 * server is silent rather than mislabelled); an ABSENT one, from a server that
 * predates the field, says nothing too.
 */

export const P_METHOD_EXACT = 'exact'
export const P_METHOD_NORMAL_APPROXIMATION = 'normal_approximation'

export type PMethod = typeof P_METHOD_EXACT | typeof P_METHOD_NORMAL_APPROXIMATION

interface PMethodDescriptor {
  /** Beside a p in a cell's title and its accessible text. */
  short: string
  /** The footer's word when every row shares the method. */
  footer: string
}

const P_METHOD_META = {
  [P_METHOD_EXACT]: {
    short: 'exact p',
    footer: 'exact p (no tied values, fewer than 50 in each group)',
  },
  [P_METHOD_NORMAL_APPROXIMATION]: {
    short: 'normal approximation, continuity-corrected',
    footer: 'p from the normal approximation with a continuity correction (tied values, or 50 or more in a group)',
  },
} satisfies Record<PMethod, PMethodDescriptor>

function known(method: string | null | undefined): method is PMethod {
  return method === P_METHOD_EXACT || method === P_METHOD_NORMAL_APPROXIMATION
}

/** The method's short name, or `null` when absent or unknown. */
export function pMethodShort(method: string | null | undefined): string | null {
  return known(method) ? P_METHOD_META[method].short : null
}

/**
 * ONE line for a table whose rows each state a method.
 *
 * Every row the same → that method's footer. Rows differ → both, said once,
 * with each cell naming its own. No row states one → `null`.
 */
export function pMethodFooter(methods: (string | null | undefined)[]): string | null {
  const seen = [...new Set(methods.filter(known))]
  if (seen.length === 0) return null
  if (seen.length === 1) return P_METHOD_META[seen[0]].footer
  return 'exact p where no values are tied and each group has fewer than 50; '
    + 'otherwise the normal approximation with a continuity correction (each p says which)'
}
