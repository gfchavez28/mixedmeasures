export type AnalysisSource =
  | { type: 'conversation'; id: number; label: string; importOrder: number }
  | { type: 'text_column'; id: number; label: string; datasetId: number; datasetName: string; columnName: string }
  | { type: 'document'; id: number; label: string }

export type QualTab = 'content' | 'descriptives' | 'relationships' | 'reconciliation' | 'irr' | 'models' | 'quoteboard'

/**
 * Track J · J2-5 M-1 — the Reconciliation tab/grid is offered only when the project
 * has ≥2 HUMAN coders AND a consensus layer exists. Hidden while BLIND (DEC-G — the
 * reconciliation grid reveals every coder side-by-side; you must Reveal first). Pure.
 *
 * 🔴 The parameter is `multiHumanCoder`, not `multiCoder` (#989). Both tabs are
 * about agreement between PEOPLE: a machine coder cannot vote in consensus and is
 * excluded from every coefficient at the server, so on a one-person-plus-machine
 * roster the old flag offered a reconciliation grid with nothing to reconcile and
 * a reliability table that can only ever hold one column. Naming the parameter for
 * the question is what stops the next caller passing the wrong roster count.
 */
export function isReconciliationTabVisible(multiHumanCoder: boolean, consensusAvailable: boolean, blind = false): boolean {
  return multiHumanCoder && consensusAvailable && !blind
}

/**
 * Track J · J2-5 — the Reliability (IRR) tab is offered whenever the project has
 * ≥2 HUMAN coders. Unlike Reconciliation it does NOT require a consensus layer (IRR
 * is human-roster agreement, independent of consensus). Hidden while BLIND (DEC-G —
 * it names coders + shows agreement). Pure (unit-tested). See the note above on why
 * this is the HUMAN count.
 */
export function isIrrTabVisible(multiHumanCoder: boolean, blind = false): boolean {
  return multiHumanCoder && !blind
}

/**
 * #1030 — the Model comparison tab is offered when a MODEL has coded this project
 * and there is at least one PERSON to compare it with. Pure (unit-tested).
 *
 * 🔴 **Not gated on `multiHumanCoder`, and that is the whole defect it closes.** The
 * comparison lived inside the Reliability tab, which needs two PEOPLE, so the
 * researcher it exists for — one person plus an imported model layer, the default
 * install — never saw it, while the server computed it happily with one human.
 *
 * 🔴 **Not hidden while blind either.** A model is not a colleague (`multicoder.md`
 * §blind mode is about people), so a blind coder may compare their OWN coding with
 * it: the tab narrows the request to the viewer (`MachineAgreementTable`'s
 * `humanId`) and no colleague's row reaches the wire.
 *
 * ⚠️ `projectHasActiveMachine` comes from CODER COVERAGE, never the roster: the
 * roster is install-wide, so a model imported into another project would offer a
 * tab here that can only say "nothing shared" (#1038 g, the #806 shape). ACTIVE,
 * because the comparison excludes an archived machine on purpose (DEC-F's roster).
 */
export function isModelComparisonTabVisible(
  projectHasActiveMachine: boolean,
  hasHumanCoder: boolean,
): boolean {
  return projectHasActiveMachine && hasHumanCoder
}
export type QualCodeMode = 'codes' | 'categories'
export type QualChartType = 'heatmap' | 'bar' | 'stacked_bar' | 'summary' | 'saturation' | 'timeline'
export type QualValueMode = 'count' | 'segment_proportion' | 'text_coverage'
export type QualDenominatorMode = 'total' | 'coded'
export type QualSortOrder = 'import' | 'alpha' | 'count_desc' | 'count_asc' | 'custom'
export type QualOrientation = 'sources-rows' | 'codes-rows'

/**
 * Orientation is the ONE display option that travels as a short URL token
 * (`sr` / `cr`) rather than as its own type — and a saved material config
 * stores the TOKEN, because `buildCurrentConfig` writes `orientRaw` verbatim
 * while every sibling option (`value_mode`, `sort_order`, `chart_type`) is
 * written already-typed.
 *
 * ⚠️ That asymmetry is a silent-corruption trap, which is why both directions
 * live here instead of being re-inlined per consumer (#652 slab 1): a consumer
 * that passes the stored `'sr'` straight into a chart component sends a value
 * outside `QualOrientation`, and every component treats anything that isn't
 * exactly `'codes-rows'` as sources-rows. So the bug is INVISIBLE on the
 * default and appears only for a researcher who chose codes-rows — the
 * coinciding-values shape this codebase keeps re-filing.
 */
export function orientationFromToken(token: unknown): QualOrientation {
  return token === 'cr' || token === 'codes-rows' ? 'codes-rows' : 'sources-rows'
}

export function orientationToToken(orientation: QualOrientation): 'sr' | 'cr' {
  return orientation === 'codes-rows' ? 'cr' : 'sr'
}
export type QualRelView = 'cooccurrence' | 'comparisons'
export type QualCooccurrenceLevel = 'segment' | 'source'
export type QualComparisonChartMode = 'table' | 'bar'
/**
 * #685 — the Timeline's table breakdown. A per-CHART property (one toggle for
 * the whole chart), not per-observation: the old per-block `useState` was an
 * accident of where it was declared, and making it observation-keyed would put
 * an id map in the config that every `.mmproject` import has to remap.
 */
export type QualTimelineTableMode = 'code' | 'coder'
export type QualContentMode = 'by-code' | 'by-source'
export type QuoteGroupBy = 'none' | 'code' | 'source' | 'category'
export type QuoteSort = 'source' | 'date' | 'quoted' | 'custom'
export type QuoteDensity = 'quote' | 'full'
export type QuoteLayout = 'auto' | '1' | '2'
