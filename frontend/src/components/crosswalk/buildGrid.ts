/**
 * Pure function that builds the crosswalk's two-slice grid shape from the
 * project's analysis domains, all-columns list, and equivalence groups.
 *
 * Path A (#325) — every domain member renders as a row. The discriminated
 * union `RowData = EgRowData | UnlinkedRowData` replaces the prior split
 * between bracket rows and a separate `UnlinkedMembersSection` pill list:
 *   - Members whose underlying column has an `equivalence_group_id` render
 *     as `kind: 'eg'` rows that span all active datasets.
 *   - Members without an EG render as `kind: 'unlinked'` synthetic single-
 *     cell rows, with one populated cell in the source dataset and
 *     EmptyCellData placeholders in the sibling datasets.
 *
 * Return shape (see `crosswalk-types.ts`):
 *   - `brackets`: BracketData[] — variable groups; `rows` mixes both kinds.
 *
 * Orphan equivalence groups (#331) are never emitted — Path A's backend
 * auto-dissolve guarantees they don't exist. The `equivalenceGroups`
 * argument is consumed only for label fallbacks on rare empty-EG cases.
 *
 * The function is pure: given the same inputs, it always returns the same
 * output. No React Query, no side effects, no mutations.
 */

import type {
  AnalysisDomainResponse,
  CrosswalkGrid,
  BracketData,
  RowData,
  EgRowData,
  UnlinkedRowData,
  CellData,
  EmptyCellData,
  ProjectColumnInfo,
  EquivalenceGroupResponse,
} from './crosswalk-types'
import type { MetricDefinitionSummaryResponse } from '@/lib/api/metrics'
import { compareScales } from '@/lib/scale-comparison'

/*
 * Scale-signature comparison moved to `lib/scale-comparison.ts` (#693).
 *
 * It was private to this file, feeding one gutter icon on the grid — while the
 * screen where a scale score is CREATED and the screen where it is READ had no
 * access to it at all. Re-exported here because `ScaleLabelsMismatchIcon` and
 * the crosswalk tests import `normalizeScaleLabels` from this module.
 */
export { normalizeScaleLabels } from '@/lib/scale-comparison'

interface BuildGridInput {
  domains: AnalysisDomainResponse[]
  allColumns: ProjectColumnInfo[]
  equivalenceGroups: EquivalenceGroupResponse[]
  /** Column IDs that have at least one primary reverse recode. Used to set
   * `CellData.is_reverse_scored`. Defaults to empty set if the reverse-cols
   * query hasn't loaded yet.
   */
  reverseScoredColumnIds?: Set<number>
  /** Project metrics summary. We filter for the ungrouped scale-score metric
   * per domain (domain_aggregate + both grouping_column_id fields null) and
   * derive `scale_score_metric_id` + `scale_score_metric_state` per bracket. */
  metrics?: MetricDefinitionSummaryResponse[]
  /** Domain IDs whose last createScoreMetricMutation failed. Overrides any
   * state buildGrid would derive from `metrics` (usually 'missing') with
   * 'failed' so the bracket renders the degraded-state action. */
  failedScoreMetricDomainIds?: Set<number>
}

export function buildGrid({
  domains,
  allColumns,
  equivalenceGroups,
  reverseScoredColumnIds = new Set(),
  metrics = [],
  failedScoreMetricDomainIds = new Set(),
}: BuildGridInput): CrosswalkGrid {
  // Build a lookup from domain_id → ungrouped scale-score metric. Only the
  // ungrouped variant qualifies (both grouping_column_id fields null).
  const scoreMetricByDomain = new Map<number, MetricDefinitionSummaryResponse>()
  for (const m of metrics) {
    if (m.metric_type !== 'domain_aggregate') continue
    if (m.input_source_type !== 'dataset_domain') continue
    if (m.grouping_column_id != null) continue
    if (m.grouping_column_id_2 != null) continue
    scoreMetricByDomain.set(m.input_source_id, m)
  }

  // ── Step 1: O(1) lookup by column ID ──────────────────────────────────
  const columnsById = new Map<number, ProjectColumnInfo>()
  for (const col of allColumns) {
    columnsById.set(col.id, col)
  }

  // ── Step 2: index columns by their EG ─────────────────────────────────
  const columnsByEg = new Map<number, ProjectColumnInfo[]>()
  for (const col of allColumns) {
    if (col.equivalence_group_id != null) {
      const list = columnsByEg.get(col.equivalence_group_id)
      if (list) {
        list.push(col)
      } else {
        columnsByEg.set(col.equivalence_group_id, [col])
      }
    }
  }

  // EG metadata lookup. Path A's auto-dissolve means an EG with no column
  // members shouldn't exist; this map is carried for defensive lookup.
  const egById = new Map<number, EquivalenceGroupResponse>()
  for (const eg of equivalenceGroups) {
    egById.set(eg.id, eg)
  }

  // ── Step 3: column → CellData converter ───────────────────────────────
  function toCell(col: ProjectColumnInfo): CellData {
    return {
      column_id: col.id,
      dataset_id: col.dataset_id,
      dataset_name: col.dataset_name,
      column_code: col.column_code,
      column_text: col.column_text,
      column_type: col.column_type,
      scale_points: col.scale_points,
      // Phase 4.5: full scale labels carried so mismatch v2 can compare
      // arrays (not just point counts). Backend ships this on
      // ProjectColumnInfo (commit 4 schema enrichment).
      scale_labels: col.scale_labels ?? null,
      is_reverse_scored: reverseScoredColumnIds.has(col.id),
      // Phase 4.4: backend's all-columns endpoint computes the count once
      // and ships it on ProjectColumnInfo so the crosswalk doesn't have to
      // round-trip per-column queries.
      recode_def_count: col.recode_def_count ?? 0,
      equivalence_group_id: col.equivalence_group_id,
    }
  }

  // ── Step 4a: build an EG-keyed row (multi-cell) ───────────────────────
  function buildEgRow(egId: number): EgRowData {
    const members = columnsByEg.get(egId) ?? []
    const cells_by_dataset = new Map<number, CellData | EmptyCellData>()

    for (const col of members) {
      cells_by_dataset.set(col.dataset_id, toCell(col))
    }

    let auto_label: string
    if (members.length > 0) {
      const lowest = members.reduce((a, b) => (a.id < b.id ? a : b))
      auto_label = lowest.column_text
    } else {
      const eg = egById.get(egId)
      auto_label = eg?.label ?? `Row ${egId}`
    }

    // Phase 4.5: scale signature comparison (replaces v1 scale_points proxy).
    // Catches both point-count differences AND same-count-different-labels
    // (e.g. 5pt agree-disagree vs 5pt frequency).
    //
    // The signature combines scale_labels (preferred) with scale_points
    // (fallback) so legacy projects without scale_labels don't lose v1
    // mismatch detection. See `scaleSignature` for the composition rule.
    //
    // Single-cell EG rows can't compare. `kind:'unlinked'` rows never enter
    // buildEgRow.
    // #693: one comparator, shared with the domain picker and the analysis
    // view. `unknown` (fewer than two columns carry scale metadata) does not
    // raise the grid's gutter icon — the grid shows WHICH datasets disagree,
    // and there is nothing to show when nothing is known. The surfaces that
    // make a claim ABOUT the aggregate say "unknown" out loud instead.
    const has_scale_labels_mismatch = compareScales(members) === 'mismatch'

    return {
      kind: 'eg',
      equivalence_group_id: egId,
      auto_label,
      cells_by_dataset,
      has_scale_labels_mismatch,
    }
  }

  // ── Step 4b: build a synthetic single-cell row (Path A #325) ──────────
  function buildSyntheticRow(
    col: ProjectColumnInfo,
    memberId: number,
  ): UnlinkedRowData {
    const cells_by_dataset = new Map<number, CellData | EmptyCellData>()
    cells_by_dataset.set(col.dataset_id, toCell(col))
    // Sibling datasets are populated by the consumer's activeDatasetIds
    // iteration; we don't pre-seed empty placeholders here. EquivalenceRow
    // already handles missing keys via its emptyFallbacks map.
    return {
      kind: 'unlinked',
      member_id: memberId,
      column_id: col.id,
      auto_label: col.column_text,
      cells_by_dataset,
    }
  }

  // ── Step 5: per-domain row emission (Path A unified) ──────────────────
  const brackets: BracketData[] = []

  // Sort domains by sequence_order (nulls last), then ID — mirrors the
  // server's list_domains order.
  const sortedDomains = [...domains].sort((a, b) => {
    const aOrder = a.sequence_order ?? Number.MAX_SAFE_INTEGER
    const bOrder = b.sequence_order ?? Number.MAX_SAFE_INTEGER
    if (aOrder !== bOrder) return aOrder - bOrder
    return a.id - b.id
  })

  for (const domain of sortedDomains) {
    const rows: RowData[] = []
    const egIdsSeen = new Set<number>()
    const datasetsInDomain = new Set<number>()

    // domain.members is server-ordered by sequence_order via the SQLAlchemy
    // relationship's `order_by` clause. Trust that order; tiebreak on id.
    const sortedMembers = [...domain.members].sort((a, b) => a.id - b.id)

    for (const member of sortedMembers) {
      if (member.member_type !== 'column') continue
      const col = columnsById.get(member.member_id)
      if (!col) continue  // stale reference; skip silently

      datasetsInDomain.add(col.dataset_id)

      if (col.equivalence_group_id != null) {
        // EG-keyed member — emit one row per distinct EG
        if (!egIdsSeen.has(col.equivalence_group_id)) {
          egIdsSeen.add(col.equivalence_group_id)
          rows.push(buildEgRow(col.equivalence_group_id))
        }
      } else {
        // Synthetic single-cell row (#325)
        rows.push(buildSyntheticRow(col, member.id))
      }
    }

    const is_cross_dataset = datasetsInDomain.size >= 2

    // Derive scale-score metric state. 'failed' is a frontend sentinel set
    // by createScoreMetricMutation.onError; it overrides the metric-derived
    // state so the bracket can surface "Create scale score manually."
    let scale_score_metric_id: number | null = null
    let scale_score_metric_state: BracketData['scale_score_metric_state'] = 'missing'
    if (failedScoreMetricDomainIds.has(domain.id)) {
      scale_score_metric_state = 'failed'
    } else {
      const sm = scoreMetricByDomain.get(domain.id)
      if (sm) {
        scale_score_metric_id = sm.id
        scale_score_metric_state = sm.stale ? 'stale' : 'ok'
      }
    }

    brackets.push({
      domain_id: domain.id,
      name: domain.name,
      description: domain.description,
      color: domain.color,
      sequence_order: domain.sequence_order,
      rows,
      is_cross_dataset,
      dataset_count: datasetsInDomain.size,
      scale_score_metric_id,
      scale_score_metric_state,
    })
  }

  // The `equivalenceGroups` argument is currently consumed only for
  // empty-EG label fallback inside `buildEgRow`. Path A's auto-dissolve
  // means orphan EGs cannot exist, so this list parallels what's already
  // referenced by domain members in normal operation.
  void equivalenceGroups

  return { brackets }
}

// ─── Derived helpers consumed by other crosswalk components ────────────────

/** Compute the list of truly-unassigned columns — the data source for the
 * UnassignedPanel.
 *
 * Excludes (a) columns linked to an equivalence group, AND (b) columns that
 * are domain members but render as synthetic single-cell rows (null EG +
 * domain membership). The synthetic-row case must be excluded because each
 * such column is already rendered as a cell-${columnId} draggable inside
 * its bracket. Including it in the panel too produces a second draggable
 * with the SAME drag ID, which dnd-kit resolves by picking the panel's
 * rect — anchoring the DragOverlay at the panel cell's position instead
 * of the bracket cell's, far from the cursor. (#334)
 */
export function computeUnassignedColumns(
  allColumns: ProjectColumnInfo[],
  domainMemberColumnIds?: Set<number>,
): ProjectColumnInfo[] {
  return allColumns.filter(
    col =>
      col.equivalence_group_id == null &&
      !(domainMemberColumnIds?.has(col.id) ?? false),
  )
}

/** Compute the distinct active datasets in the project, ordered by the
 * first column's dataset_id. Used by CrosswalkHeader to render dataset
 * toggles. Includes the user-customizable color override (if any) so
 * downstream surfaces (column headers, cell dots, identity dots on page
 * titles) resolve dataset visual identity from one place. */
export function computeProjectDatasets(
  allColumns: ProjectColumnInfo[],
): Array<{ dataset_id: number; dataset_name: string; dataset_color: string | null }> {
  const seen = new Map<number, { dataset_name: string; dataset_color: string | null }>()
  for (const col of allColumns) {
    if (!seen.has(col.dataset_id)) {
      seen.set(col.dataset_id, {
        dataset_name: col.dataset_name,
        dataset_color: col.dataset_color ?? null,
      })
    }
  }
  return Array.from(seen.entries())
    .map(([dataset_id, info]) => ({ dataset_id, ...info }))
    .sort((a, b) => a.dataset_id - b.dataset_id)
}

/** Compute total column counts per dataset. Filter-unaware: returns the
 * full dataset size regardless of assignment state. */
export function computeDatasetColumnCounts(
  allColumns: ProjectColumnInfo[],
): Map<number, number> {
  const counts = new Map<number, number>()
  for (const col of allColumns) {
    counts.set(col.dataset_id, (counts.get(col.dataset_id) ?? 0) + 1)
  }
  return counts
}

/** Domain ID → set of column IDs across all rows in that bracket.
 * Used by the #327 search auto-expand: when a search match lives inside a
 * collapsed bracket, the consumer transiently treats it as expanded so the
 * researcher can see the highlight. The persisted collapse Set is unchanged. */
export function computeColumnIdsByDomain(
  grid: CrosswalkGrid,
): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>()
  for (const bracket of grid.brackets) {
    const ids = new Set<number>()
    for (const row of bracket.rows) {
      for (const cell of row.cells_by_dataset.values()) {
        if ('column_id' in cell) ids.add(cell.column_id)
      }
    }
    map.set(bracket.domain_id, ids)
  }
  return map
}
