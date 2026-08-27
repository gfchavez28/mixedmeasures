/**
 * What a split-half coefficient was split BY (#710).
 *
 * ## Why this rides the wire
 *
 * Split-half reliability is split-DEPENDENT by construction: a different
 * partition of the same items gives a different coefficient, so reporting one
 * split as *the* number overstates its stability. Until #710 the split was
 * odd/even over `DatasetColumn.id` — the order the columns happened to be
 * inserted into the database across the whole project, which for a cross-dataset
 * domain blocks all of one dataset then all of the other, and which the
 * researcher sees NOWHERE in the UI.
 *
 * It now follows the domain's own item order, which the researcher controls
 * through the domain member reorder. So the basis is worth stating, and the
 * client STATES what the server did rather than inferring it — the `ci_method`
 * (#690/#715) and `aggregation_basis` (#693) pattern.
 *
 * ⚠️ A different split rule (averaging random splits, a theoretical two-half
 * structure) must take a NEW value on both sides. Reusing this one would let a
 * label assert a split that did not happen, which is worse than no label.
 */

export const SPLIT_BASIS_ODD_EVEN_DOMAIN_ORDER = 'odd_even_domain_order'

export type SplitBasis = typeof SPLIT_BASIS_ODD_EVEN_DOMAIN_ORDER

interface SplitBasisDescriptor {
  /** Short phrase for beside the coefficient. */
  label: string
  /** The sentence that makes it actionable. */
  detail: string
}

const DESCRIPTORS = {
  [SPLIT_BASIS_ODD_EVEN_DOMAIN_ORDER]: {
    label: 'odd/even by item order',
    detail:
      'Items are split into odd- and even-numbered halves following this scale’s item order, which you can change by reordering its items. Split-half reliability depends on which items land in which half, so a different order gives a different coefficient.',
  },
} satisfies Record<SplitBasis, SplitBasisDescriptor>

/**
 * The short phrase, or `null` when the result predates the field.
 *
 * `null` rather than a guess: a result computed before #710 was split over an
 * internal column order, and labelling it with the current basis would be a
 * false statement about a number that is still on screen.
 */
export function splitBasisLabel(basis?: string | null): string | null {
  if (!basis) return null
  return (DESCRIPTORS as Record<string, SplitBasisDescriptor>)[basis]?.label ?? null
}

export function splitBasisDetail(basis?: string | null): string | null {
  if (!basis) return null
  return (DESCRIPTORS as Record<string, SplitBasisDescriptor>)[basis]?.detail ?? null
}

/**
 * "Items 1, 3, 5 vs 2, 4" — which items actually landed in each half.
 *
 * The coefficient cannot be judged without this, and a researcher who dislikes
 * the split now has both the information and the control to change it.
 * Returns `null` when either half is absent (a pre-#710 result).
 */
export function describeHalves(
  half1?: string[] | null,
  half2?: string[] | null,
): string | null {
  if (!half1?.length || !half2?.length) return null
  return `${half1.join(', ')} vs ${half2.join(', ')}`
}
