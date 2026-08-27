/**
 * What a saturation curve's x-axis is ordered BY (#708).
 *
 * ## Why the ordering is part of the claim
 *
 * A saturation curve is entirely order-dependent: a plateau after the twelfth
 * source can be a property of the SEQUENCE rather than of the data. Sources are
 * ordered by `created_at` — when each was imported into the project, which is
 * not when fieldwork happened — and the backend docstring disclosed that
 * honestly while the chart said nothing. The chart is what goes in the report.
 *
 * The server names its ordering and the client DISPLAYS it, the same seam as
 * `ci_method` (#690/#715), `aggregation_basis` (#693) and `split_basis` (#710).
 *
 * ⚠️ Letting the researcher CHOOSE the ordering is a bigger change than it
 * looks and is deliberately not offered yet: only `Conversation` has a fieldwork
 * date (`conversation_date`, nullable). `Document` and `Observation` have none,
 * so "order by fieldwork date" needs two new columns and a migration before it
 * can mean anything on a mixed corpus.
 */

export const SATURATION_ORDERING_IMPORT_DATE = 'import_date'

export type SaturationOrdering = typeof SATURATION_ORDERING_IMPORT_DATE

interface OrderingDescriptor {
  /** Axis title — short, it sits under rotated tick labels. */
  axisLabel: string
  /** The caveat, for the caption and the footnote. */
  caveat: string
}

const DESCRIPTORS = {
  [SATURATION_ORDERING_IMPORT_DATE]: {
    axisLabel: 'Sources, in the order they were added to this project',
    caveat:
      'Sources are ordered by when they were added to this project, which is not necessarily the order fieldwork happened in. A saturation curve depends on that order, so a plateau here is evidence about this sequence rather than about the corpus as a whole.',
  },
} satisfies Record<SaturationOrdering, OrderingDescriptor>

function descriptor(ordering?: string | null): OrderingDescriptor | undefined {
  if (!ordering) return undefined
  return (DESCRIPTORS as Record<string, OrderingDescriptor>)[ordering]
}

/**
 * The x-axis title, or `null` when the payload names no ordering.
 *
 * `null` rather than a default: an older result carries no `ordering` field,
 * and captioning it with an ordering we have not been told is exactly the
 * confident-wrong-statement this module exists to avoid.
 */
export function saturationAxisLabel(ordering?: string | null): string | null {
  return descriptor(ordering)?.axisLabel ?? null
}

export function saturationCaveat(ordering?: string | null): string | null {
  return descriptor(ordering)?.caveat ?? null
}
