/**
 * Is a canvas-embedded material qualitative or quantitative, and where does
 * "Open in Analysis" go? (#652 slab 0)
 *
 * ONE place decides this. Before slab 0, `ChartEmbedView` hardcoded
 * `/analysis/quantitative` in two places, so every qualitative material
 * deep-linked to the wrong workspace — observed live on a
 * `qualitative_descriptives` material.
 *
 * ⚠️ **Why the CONFIG and not `source_tab`.** `source_tab` is the authoritative
 * field and the Materials drawer badges Q/N from it — but it arrives via the
 * `materials-all` query, and that makes it the wrong input *here* for two
 * reasons:
 *
 *   1. **It can disappear.** Delete the material row and the lookup returns
 *      nothing, so a qualitative embed would route to the quantitative view
 *      forever. The config is stored ON THE NODE and survives.
 *   2. **It arrives late.** While the query is pending there is no answer, so
 *      the link would either flash the wrong destination or vanish and shift
 *      layout.
 *
 * The config is synchronous, always present, and is already what
 * `InlineChartRenderer` reads. Keep this the single discriminator; do not add a
 * second one keyed on `source_tab`.
 */

import type { MaterialRefKind } from './api/materials'

/** Keys only ever written by `useQualitativeAnalysis::buildCurrentConfig`. */
const QUALITATIVE_CONFIG_KEYS = ['code_mode', 'code_ids'] as const

/**
 * True when this material's config came from the qualitative analysis view.
 *
 * The quantitative builder (`AnalysisView::buildCurrentChartConfig`) writes
 * `selected_columns` / `selected_domains` / `metric_type` and never a code key,
 * so presence of either key below is decisive.
 */
export function isQualitativeMaterialConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  if (!config || typeof config !== 'object') return false
  return QUALITATIVE_CONFIG_KEYS.some(key => key in config)
}

/**
 * Route for the embed's "Open in Analysis" affordance.
 *
 * Both views already consume `?material=N` — `QualitativeAnalysisView` restores
 * it through `loadMaterial` on arrival ("Auto-load material when navigating
 * from canvas"), which is why this is a routing fix rather than a feature.
 */
export function materialAnalysisPath(
  projectId: number | string,
  materialId: number | string,
  config: Record<string, unknown> | null | undefined,
): string {
  const view = isQualitativeMaterialConfig(config) ? 'qualitative' : 'quantitative'
  return `/projects/${projectId}/analysis/${view}?material=${materialId}`
}

/** Human wording for the ref kinds a material can lose (#652 slab 3). */
const REF_KIND_NOUNS: Record<MaterialRefKind, [singular: string, plural: string]> = {
  column: ['column', 'columns'],
  domain: ['domain', 'domains'],
  code: ['code', 'codes'],
  conversation: ['conversation', 'conversations'],
  document: ['document', 'documents'],
  observation: ['observation', 'observations'],
  participant: ['participant', 'participants'],
}

/**
 * Describe a material's missing references by KIND.
 *
 * The previous copy read *"N referenced columns or domains no longer exist"* —
 * accurate while only those two kinds were ever collected, and wrong the moment
 * slab 3 started reporting codes and sources. Naming the kinds actually missing
 * is also more useful: "1 conversation" tells the researcher where to look,
 * "1 reference" does not.
 */
export function describeMissingRefs(refs: { type: MaterialRefKind }[]): string {
  if (refs.length === 0) return ''
  const counts = new Map<MaterialRefKind, number>()
  for (const r of refs) counts.set(r.type, (counts.get(r.type) ?? 0) + 1)

  const parts = [...counts.entries()]
    // Stable ordering so the sentence does not reshuffle between renders.
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, n]) => {
      const nouns = REF_KIND_NOUNS[kind]
      // An unknown kind from a newer server degrades to the raw token rather
      // than rendering "undefined".
      return `${n} ${nouns ? (n === 1 ? nouns[0] : nouns[1]) : kind}`
    })

  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${list} referenced here no longer ${refs.length === 1 ? 'exists' : 'exist'}.`
}
