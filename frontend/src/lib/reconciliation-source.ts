/**
 * The reconciliation grid's source narrowing — pure mapping.
 *
 * Lives in lib/ rather than beside the picker component so the key and the
 * request parameters are single-sourced and unit-testable (the
 * `lib/merge-coder-mapping.ts` pattern).
 */

export interface ReconciliationSource {
  type: 'conversation' | 'document' | 'observation'
  id: number
}

/**
 * The React Query key slot for the chosen source.
 *
 * Paired with `sourceParams` deliberately: the slot used to hold a literal
 * `null` while the endpoint had accepted source_type/source_id all along, so
 * narrowing served the previous source's page from cache — the #454 shape.
 */
export function sourceQueryKey(source: ReconciliationSource | null): string | null {
  return source ? `${source.type}:${source.id}` : null
}

/** The request parameters for the chosen source (none when showing everything). */
export function sourceParams(source: ReconciliationSource | null) {
  return source ? { source_type: source.type, source_id: source.id } : {}
}

/**
 * Only FROZEN observations can be narrowed to. An open clip set is each coder's
 * own, so its units are never gathered for reliability — offering one would
 * produce an empty grid with nothing explaining why.
 */
export function selectableObservations<T extends { segmentation_frozen_at: string | null }>(
  observations: T[],
): T[] {
  return observations.filter(o => o.segmentation_frozen_at != null)
}

/**
 * The inverse lens (D18's other half): only OPEN observations get the open-cut
 * panel (unitizing α + binned κ). A frozen observation's clips are shared units —
 * they pool into the ordinary IRR gather (6b-B), so offering one here would
 * report the same coding twice under two different statistics.
 */
export function openObservations<T extends { segmentation_frozen_at: string | null }>(
  observations: T[],
): T[] {
  return observations.filter(o => o.segmentation_frozen_at == null)
}
