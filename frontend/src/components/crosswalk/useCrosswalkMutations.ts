/**
 * Crosswalk mutations — Phase 3a shipped `swapMutation` and
 * `removeColumnFromRowMutation`. Phase 3b adds the remaining 14.
 *
 * Invalidation set: Phase 3a established that every state-changing crosswalk
 * mutation invalidates some combination of `['project-columns', pid]`,
 * `['equivalence-groups', pid]`, `['analysis-domains', pid]`, `['metrics', pid]`,
 * and per-affected-dataset `['dataset-data', X]`. Pick the minimal subset for
 * each mutation — do NOT blast all five keys on every settle.
 *
 * Error surface (the swap endpoint still emits 4 structured 409/400 shapes;
 * see parseSwapError below). Domain mutations emit the #289 `duplicate_dataset`
 * and #290 `cross_dataset_unpaired` shapes via `parseEquivalenceError`.
 *
 * Load-bearing Phase 3a patterns Phase 3b reuses:
 *   - Single source of optimistic truth = `['project-columns', pid]`
 *   - Custom collision detection in the DnD hook (not here)
 *   - Stable sonner IDs per mutation family, descriptive toast text
 *   - ConfirmDialog for all confirm flows (not raw AlertDialog)
 *   - requestAnimationFrame for post-mutation focus
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { crosswalkApi, domainsApi, equivalenceApi, recodeApi, metricsApi } from '@/lib/api'
import type { ColumnSwap, EquivalenceGroupSwapResponse } from '@/lib/api/equivalence'
import type {
  MoveMembersRequest,
  MoveMembersResponse,
} from '@/lib/api/crosswalk'
import type { ProjectColumnInfo } from './crosswalk-types'
import type {
  DomainMemberInput,
  AnalysisDomainResponse,
  AnalysisDomainListResponse,
  BulkDomainCreateResult,
  AnalysisDomainBulkCreateItem,
  CreateScoreMetricResponse,
} from '@/lib/api/analysis-domains'
import type { MetricDefinitionSummaryResponse, MetricListResponse } from '@/lib/api/metrics'
import { ApiError } from '@/lib/api/client'

// ─── Structured error parsing ─────────────────────────────────────────────────

/** Parse the 4 structured error shapes the swap endpoint returns. */
export interface SwapError {
  error: 'type_mismatch' | 'cross_dataset' | 'not_linked' | 'cross_dataset_unpaired'
  message: string
  column_ids?: number[]
  unpaired_columns?: number[]
}

export function parseSwapError(err: unknown): SwapError | null {
  const errorData = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (errorData && typeof errorData === 'object' && 'error' in errorData) {
    return errorData as SwapError
  }
  return null
}

/** Parse #289 + #290 + #350 structured errors (domain add / create / equivalence add / score metric). */
export interface EquivalenceErrorInfo {
  error: 'duplicate_dataset' | 'cross_dataset_unpaired' | 'recode_definitions_exist' | 'non_numeric_domain' | string
  message: string
  conflicts?: unknown
  unpaired_columns?: number[]
  /** #350: present on `non_numeric_domain`. List of the offending members
   * with their types so the toast can name a specific column + type. */
  columns?: Array<{
    id: number
    column_code: string | null
    column_text: string
    column_type: string
  }>
}

export function parseEquivalenceErrorDetail(err: unknown): EquivalenceErrorInfo | null {
  if (err instanceof ApiError) {
    const detail = (err.response.data as { detail?: unknown })?.detail
    if (detail && typeof detail === 'object' && 'error' in detail) {
      return detail as EquivalenceErrorInfo
    }
  }
  return null
}

export function toastEquivalenceError(err: unknown, fallback: string) {
  const detail = parseEquivalenceErrorDetail(err)
  if (!detail) {
    toast.error(fallback)
    return
  }
  if (detail.error === 'duplicate_dataset') {
    toast.error(detail.message || 'Row already has a column from that dataset.', {
      description:
        'Each dataset can contribute at most one column per row. Unlink the conflicting column first.',
    })
    return
  }
  if (detail.error === 'cross_dataset_unpaired') {
    toast.error(detail.message || 'Variable group would have unpaired cross-dataset members', {
      description:
        'A group that mixes datasets needs each column paired with an equivalent column from another dataset (an equivalence row). Pair the unpaired columns, or remove them from the group.',
    })
    return
  }
  if (detail.error === 'recode_definitions_exist') {
    toast.error(detail.message || 'Recode definitions exist on this column', {
      description: 'Clear the recode in the Recode Workbench before changing the column type.',
    })
    return
  }
  if (detail.error === 'column_already_linked') {
    const conflicts = (detail.conflicts as Array<{
      column_code?: string | null
      current_group_label?: string | null
    }> | undefined) ?? []
    const first = conflicts[0]
    const colName = first?.column_code ?? 'This column'
    const groupName = first?.current_group_label ?? 'another group'
    toast.error(`${colName} is already in "${groupName}"`, {
      description: 'Unlink it from its current group first, or merge the two groups together.',
    })
    return
  }
  toast.error(detail.message || fallback)
}

// ─── Swap mutation context types ──────────────────────────────────────────────

interface SwapSnapshot {
  previousColumns: { columns: ProjectColumnInfo[]; total: number } | undefined
  inversePayload: ColumnSwap[]
  timestamp: number
}

interface SwapMutationContext extends SwapSnapshot {
  affectedDatasetIds: number[]
  // #336 (Batch B): swap now atomically swaps domain membership too. The
  // optimistic patch applies the same symmetric-difference algorithm to
  // ['analysis-domains', pid] so the UI doesn't briefly show the phantom-
  // cell state during the round-trip. Rollback in onError restores both.
  previousDomains: AnalysisDomainListResponse | undefined
}

// ─── Move mutation snapshot/inverse-plan types (#342) ─────────────────────────

/** Snapshot handed to the consumer on every move success. The consumer
 * surfaces the Undo toast: when ``inversePlan`` is set, clicking Undo
 * dispatches it through ``moveMembersMutation`` again (with a timestamp
 * guard); when null, the toast still appears for visual confirmation but
 * with no action ("Undo unavailable for moves spanning multiple sources"). */
export interface MoveSnapshot {
  /** Reverse of the user's move. Null when the moved columns came from
   * mixed (eg, domain) tuples — see buildInversePlan. */
  inversePlan: MoveMembersRequest | null
  /** Original move request, kept so descriptive toast text can name the
   * target ("Moved Q3 to Engagement"). */
  originalRequest: MoveMembersRequest
  /** Snapshots for emergency rollback. */
  previousColumns: { columns: ProjectColumnInfo[]; total: number } | undefined
  previousDomains: AnalysisDomainListResponse | undefined
  /** Source and target labels resolved from the snapshots, for toast text. */
  sourceLabels: { domain_name: string | null; eg_label: string | null }
  targetLabel: string | null
  /** Human-readable column codes for the moved set, in input order. */
  columnCodes: (string | null)[]
  /** Echoed for timestamp-guard logic. */
  columnIds: number[]
  /** Count of equivalence rows the move emptied + the backend auto-dissolved
   * (always 0 in onMutate; refined to the real count in onSuccess). */
  dissolvedCount: number
  timestamp: number
}

type MoveMutationContext = MoveSnapshot

/** Build the inverse of a move-members request from the pre-move snapshot.
 *
 * Returns null when the moved columns share a target but have *different*
 * (source EG, source domain) tuples — undoing those would require N
 * inverse calls fanning back out, which we defer (see plan).
 *
 * For the single-source case:
 *   - If columns all came from one EG which is NOT the target EG, inverse
 *     mode is 'existing_eg' (or 'new_eg' if that source EG is going to be
 *     dissolved by this move, which we resolve in onSuccess once the
 *     response arrives).
 *   - If columns all came from null EG (e.g. dragged from Unassigned),
 *     inverse mode is 'strip'.
 */
function buildInversePlan(
  request: MoveMembersRequest,
  prevColumns: ProjectColumnInfo[],
): { inversePlan: MoveMembersRequest | null; sourceEgLabel: string | null } {
  const colsById = new Map(prevColumns.map(c => [c.id, c]))
  const tuples = new Set<string>()
  let prevEgId: number | null = null
  let prevEgLabel: string | null = null
  let firstSeen = false
  for (const cid of request.column_ids) {
    const col = colsById.get(cid)
    if (!col) {
      // Snapshot doesn't know about this column — bail.
      return { inversePlan: null, sourceEgLabel: null }
    }
    const tuple = `${col.equivalence_group_id ?? 'null'}|${request.source_domain_id ?? 'null'}`
    tuples.add(tuple)
    if (!firstSeen) {
      prevEgId = col.equivalence_group_id
      prevEgLabel = col.equivalence_group_label
      firstSeen = true
    }
  }
  if (tuples.size > 1) {
    // Multi-source — defer.
    return { inversePlan: null, sourceEgLabel: null }
  }

  const inverse: MoveMembersRequest = {
    column_ids: [...request.column_ids],
    // Source/target swap: undo lands the columns back where they came from.
    source_domain_id: request.target_domain_id,
    target_domain_id: request.source_domain_id,
    target_mode: prevEgId == null ? 'strip' : 'existing_eg',
    target_eg_id: prevEgId ?? undefined,
    target_eg_label: undefined,
  }
  return { inversePlan: inverse, sourceEgLabel: prevEgLabel }
}

// ─── Options ──────────────────────────────────────────────────────────────────

interface UseCrosswalkMutationsOptions {
  projectId: number
  /** Called when a swap succeeds — drives the undo toast. */
  onSwapSuccess?: (snapshot: SwapSnapshot) => void
  /** Called when a move (drag-to-empty-cell) succeeds — drives the green
   * flash + undo toast for moves, analogous to onSwapSuccess for swaps. */
  onMoveSuccess?: (info: {
    columnId: number
    sourceEgId: number | null
    targetEgId: number
    datasetId: number
    datasetName: string
    columnCode: string | null
    timestamp: number
  }) => void
  /** Called on every successful moveMembersMutation; carries the inverse
   * plan + snapshots for the Undo toast (#342). */
  onMoveSnapshot?: (snapshot: MoveSnapshot) => void
  /** Called when createScoreMetricMutation fails — CrosswalkView sets
   * `failedScoreMetricDomainIds` so buildGrid reflects the degraded state
   * even though the `['metrics']` list has no entry. */
  onScoreMetricFailed?: (domainId: number) => void
  /** Called when createScoreMetricMutation succeeds — lets CrosswalkView
   * clear the 'failed' sentinel for that domain. */
  onScoreMetricRecovered?: (domainId: number) => void
  /** Type-mismatch handler — surfaced so `useCrosswalkDnD` can open the
   * SwapErrorOverlay (Phase 3b.6) instead of the Phase-3a toast. The
   * payload is the original swap we attempted, so the overlay can retry
   * after the user fixes types. */
  onSwapTypeMismatch?: (payload: ColumnSwap[], error: SwapError) => void
}

// ─── Invalidation helpers ─────────────────────────────────────────────────────

function invalidateCore(qc: QueryClient, pid: number) {
  qc.invalidateQueries({ queryKey: ['project-columns', pid] })
  qc.invalidateQueries({ queryKey: ['equivalence-groups', pid] })
  qc.invalidateQueries({ queryKey: ['analysis-domains', pid] })
}

function invalidateWithMetrics(qc: QueryClient, pid: number) {
  invalidateCore(qc, pid)
  qc.invalidateQueries({ queryKey: ['metrics', pid] })
}

// ─── Descriptive toast helpers ────────────────────────────────────────────────

function describeColumn(col: ProjectColumnInfo | undefined): string {
  if (!col) return 'column'
  return col.column_code ?? `col ${col.id}`
}

// ─── Main hook ────────────────────────────────────────────────────────────────

export function useCrosswalkMutations({
  projectId,
  onSwapSuccess,
  onMoveSuccess,
  onMoveSnapshot,
  onScoreMetricFailed,
  onScoreMetricRecovered,
  onSwapTypeMismatch,
}: UseCrosswalkMutationsOptions) {
  const queryClient = useQueryClient()

  // ── Score metric chain (A1 degraded-state propagation) ────────────────────
  // Kept as a standalone mutation so:
  //   - Bracket context menu "Create scale score manually" can re-fire it
  //   - The degraded-state toast action can re-fire it without going through
  //     createDomain again (which would create a duplicate domain).
  const createScoreMetricMutation = useMutation<
    CreateScoreMetricResponse,
    unknown,
    { domainId: number; domainName?: string }
  >({
    mutationFn: ({ domainId }) => domainsApi.createScoreMetric(projectId, domainId),
    onSuccess: (data, { domainId }) => {
      // Patch the metrics cache so the Σ badge lights up without a refetch.
      // The backend returns a lean metric shape; we insert it into
      // MetricListResponse as a minimal summary. This is belt — onSettled
      // invalidates ['metrics'] anyway — but it avoids a flicker where the
      // badge state flips missing → ok after a 200ms refetch round-trip.
      const existing = queryClient.getQueryData<MetricListResponse>(['metrics', projectId])
      if (existing) {
        const alreadyListed = existing.metrics.some((m) => m.id === data.metric.id)
        if (!alreadyListed) {
          const patched: MetricDefinitionSummaryResponse = {
            id: data.metric.id,
            project_id: projectId,
            name: data.metric.name,
            description: null,
            metric_type: data.metric.metric_type as MetricDefinitionSummaryResponse['metric_type'],
            config: {},
            input_source_type: data.metric.input_source_type as MetricDefinitionSummaryResponse['input_source_type'],
            input_source_id: data.metric.input_source_id,
            input_source_label: null,
            grouping_column_id: data.metric.grouping_column_id,
            grouping_column_id_2: data.metric.grouping_column_id_2,
            grouping_mode: null,
            exclude_values: null,
            sequence_order: 0,
            origin: data.metric.origin,
            origin_context: data.metric.origin_context,
            stale: data.metric.stale,
            result_type: 'metric_summary',
            latest_computed_at: null,
            total_valid_n: null,
            result_count: 0,
            last_accessed_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
          queryClient.setQueryData<MetricListResponse>(['metrics', projectId], {
            ...existing,
            metrics: [...existing.metrics, patched],
            total: existing.total + 1,
          })
        }
      }
      onScoreMetricRecovered?.(domainId)
    },
    onError: (err, { domainId, domainName }) => {
      onScoreMetricFailed?.(domainId)
      const msg = domainName
        ? `"${domainName}" created, but scale score could not be computed.`
        : 'Scale score could not be computed.'
      const retry = () => createScoreMetricMutation.mutate({ domainId, domainName })
      // Surface the cross-dataset 409 with its plain-language message; other
      // errors get the generic degraded-state toast with a retry action.
      const detail = parseEquivalenceErrorDetail(err)
      if (detail?.error === 'cross_dataset_unpaired') {
        toast.error(detail.message || 'Scale score blocked by unpaired members', {
          id: `crosswalk-score-metric-${domainId}`,
          description:
            'Cross-dataset groups need every member paired via an equivalence row before a scale score can compute.',
          action: { label: 'Retry', onClick: retry },
          duration: 10000,
        })
        return
      }
      if (detail?.error === 'non_numeric_domain') {
        // #350: don't offer a retry — the user must fix members first. Name
        // the first offending column + type in the description for a concrete
        // pointer instead of a generic "change something" message.
        const first = detail.columns?.[0]
        const where = first
          ? `${first.column_code ?? first.column_text} is type ${first.column_type}`
          : 'all members are of non-numeric types'
        toast.error(domainName
          ? `"${domainName}" created, but scale score needs numeric members.`
          : 'Scale score needs at least one numeric, percentage, or ordinal member.', {
          id: `crosswalk-score-metric-${domainId}`,
          description: `${where}. Recode columns to a numeric type, add a numeric member, or pick a different metric for this group.`,
          duration: 12000,
        })
        return
      }
      toast.error(msg, {
        id: `crosswalk-score-metric-${domainId}`,
        description: 'Create scale score manually to retry.',
        action: { label: 'Create scale score manually', onClick: retry },
        duration: 10000,
      })
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['metrics', projectId] })
    },
  })

  // ── createDomainMutation ──────────────────────────────────────────────────
  // Chain: create domain → chain createScoreMetricMutation. The chained
  // mutation handles its own degraded-state toast; this mutation's onError
  // only fires when the create itself fails (e.g. #290 unpaired validation).
  const createDomainMutation = useMutation<
    AnalysisDomainResponse,
    unknown,
    { name: string; description?: string | null; color?: string | null; members?: DomainMemberInput[] }
  >({
    mutationFn: (data) => domainsApi.create(projectId, data),
    onSuccess: (domain) => {
      invalidateCore(queryClient, projectId)
      // Fire the chained metric creation. Not awaited — its own onSuccess/
      // onError handles cache patching + degraded-state toast.
      createScoreMetricMutation.mutate({ domainId: domain.id, domainName: domain.name })
      toast.success(`Created "${domain.name}"`, { id: 'crosswalk-create-domain' })
    },
    onError: (err) => {
      toastEquivalenceError(err, 'Failed to create variable group')
    },
  })

  // ── bulkCreateDomainsMutation (Phase 4 Suggest accept) ───────────────────
  // Used by the Suggest UI to accept one or more ghost rows in a single
  // request. Inline `equivalence_groups` carry the auto-pair output from the
  // backend's pairing pass — the server creates the EGs in the same
  // transaction as the domain so cross-dataset I2 (#290) is satisfied
  // atomically.
  //
  // After success, fans out N parallel `createScoreMetric` calls (one per
  // newly-created domain). Failures from individual metric creates surface
  // via `onScoreMetricFailed` (existing degraded-state toast pattern); the
  // domain is preserved either way.
  //
  // Optimistic patch of `['analysis-domains', pid]` is intentionally NOT
  // implemented here — the bulk create touches enough invariants
  // (equivalence_groups too) that a stale-cache flicker is preferable to
  // an inconsistent optimistic state. The Σ badge resolves missing → ok
  // in a second tick after `['metrics', pid]` invalidates.
  const bulkCreateDomainsMutation = useMutation<
    BulkDomainCreateResult,
    unknown,
    { items: AnalysisDomainBulkCreateItem[] }
  >({
    mutationFn: ({ items }) => domainsApi.bulkCreate(projectId, items),
    onSuccess: (result) => {
      invalidateCore(queryClient, projectId)
      // Fan out scale-score metric creation for each new domain
      for (const domain of result.domains) {
        createScoreMetricMutation.mutate({
          domainId: domain.id,
          domainName: domain.name,
        })
      }
      const n = result.created
      toast.success(
        n === 1
          ? `Accepted "${result.domains[0]?.name ?? 'variable group'}"`
          : `Created ${n} variable groups`,
        { id: 'crosswalk-bulk-create-domains' },
      )
    },
    onError: (err) => {
      toastEquivalenceError(err, 'Failed to accept suggestions')
    },
  })

  // ── updateDomainMutation (A4 optimistic rename + metric-rename cascade) ──
  const updateDomainMutation = useMutation<
    AnalysisDomainResponse,
    unknown,
    { domainId: number; data: { name?: string; description?: string | null; color?: string | null } },
    { previousDomains: AnalysisDomainListResponse | undefined; previousName: string | undefined }
  >({
    mutationFn: ({ domainId, data }) => domainsApi.update(projectId, domainId, data),
    onMutate: async ({ domainId, data }) => {
      await queryClient.cancelQueries({ queryKey: ['analysis-domains', projectId] })
      const previousDomains = queryClient.getQueryData<AnalysisDomainListResponse>([
        'analysis-domains',
        projectId,
      ])
      let previousName: string | undefined
      if (previousDomains) {
        const nextDomains = previousDomains.domains.map((d) => {
          if (d.id !== domainId) return d
          previousName = d.name
          return {
            ...d,
            name: data.name ?? d.name,
            description: data.description !== undefined ? data.description : d.description,
            color: data.color !== undefined ? data.color : d.color,
          }
        })
        queryClient.setQueryData<AnalysisDomainListResponse>(
          ['analysis-domains', projectId],
          { ...previousDomains, domains: nextDomains },
        )
      }
      return { previousDomains, previousName }
    },
    onError: (err, _vars, context) => {
      if (context?.previousDomains) {
        queryClient.setQueryData(['analysis-domains', projectId], context.previousDomains)
      }
      toastEquivalenceError(err, 'Failed to update variable group')
    },
    onSuccess: async (_domain, { domainId, data }) => {
      // Chained metric-rename cascade: if the name changed, update the
      // ungrouped domain_aggregate metric (both grouping_column_id fields
      // null). Grouped variants (user-authored "by X" breakdowns) must not
      // be renamed — the two-NULL filter is load-bearing here.
      if (data.name) {
        try {
          const metricsRes = await metricsApi.list(projectId)
          const candidates = metricsRes.metrics.filter(
            (m) =>
              m.metric_type === 'domain_aggregate' &&
              m.input_source_type === 'dataset_domain' &&
              m.input_source_id === domainId &&
              m.grouping_column_id == null &&
              m.grouping_column_id_2 == null,
          )
          if (candidates.length > 1) {
            console.warn(
              `[crosswalk] Expected ≤1 ungrouped scale-score metric for domain ${domainId}, got ${candidates.length}. Skipping rename cascade.`,
            )
          } else if (candidates.length === 1) {
            await metricsApi.update(projectId, candidates[0].id, { name: `${data.name} Score` })
          }
        } catch (e) {
          console.warn('[crosswalk] Metric rename cascade failed', e)
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['analysis-domains', projectId] })
      queryClient.invalidateQueries({ queryKey: ['metrics', projectId] })
    },
  })

  // ── deleteDomainMutation ──────────────────────────────────────────────────
  const deleteDomainMutation = useMutation<unknown, unknown, { domainId: number; domainName: string }>({
    mutationFn: ({ domainId }) => domainsApi.delete(projectId, domainId),
    onSuccess: (_data, { domainName }) => {
      toast.success(`Deleted "${domainName}"`, { id: 'crosswalk-delete-domain' })
    },
    onError: () => {
      toast.error('Could not delete variable group.')
    },
    onSettled: () => {
      invalidateWithMetrics(queryClient, projectId)
    },
  })

  // ── addMembersMutation ────────────────────────────────────────────────────
  const addMembersMutation = useMutation<
    AnalysisDomainResponse,
    unknown,
    { domainId: number; members: DomainMemberInput[] }
  >({
    mutationFn: ({ domainId, members }) => domainsApi.addMembers(projectId, domainId, members),
    onSuccess: (domain) => {
      toast.success(`Added to "${domain.name}"`, { id: 'crosswalk-add-members' })
    },
    onError: (err) => {
      toastEquivalenceError(err, 'Failed to add columns to group')
    },
    onSettled: () => {
      // #335: backend analysis_domains.py:413 calls mark_metrics_stale here,
      // so the metrics cache must be invalidated alongside core keys.
      invalidateWithMetrics(queryClient, projectId)
    },
  })

  // ── removeMembersMutation (A3 zero-member guard lives at the caller) ────
  const removeMembersMutation = useMutation<
    AnalysisDomainResponse,
    unknown,
    { domainId: number; members: DomainMemberInput[] }
  >({
    mutationFn: ({ domainId, members }) => domainsApi.removeMembers(projectId, domainId, members),
    onSuccess: (domain) => {
      toast.success(`Removed from "${domain.name}"`, { id: 'crosswalk-remove-members' })
    },
    onError: (err) => {
      toastEquivalenceError(err, 'Failed to remove members')
    },
    onSettled: () => {
      // #335: backend analysis_domains.py:450 calls mark_metrics_stale here.
      invalidateWithMetrics(queryClient, projectId)
    },
  })

  // ── deleteRow (equivalence group delete) ──────────────────────────────────
  const deleteRowMutation = useMutation<unknown, unknown, { groupId: number; label?: string }>({
    mutationFn: ({ groupId }) => equivalenceApi.delete(projectId, groupId),
    onSuccess: (_data, { label }) => {
      toast.success(label ? `Deleted row "${label}"` : 'Row deleted', {
        id: 'crosswalk-delete-row',
      })
    },
    onError: () => {
      toast.error('Could not delete row.')
    },
    onSettled: () => {
      invalidateWithMetrics(queryClient, projectId)
    },
  })

  // ── addColumnToRowMutation ────────────────────────────────────────────────
  const addColumnToRowMutation = useMutation<
    unknown,
    unknown,
    { groupId: number; columnId: number }
  >({
    mutationFn: ({ groupId, columnId }) => equivalenceApi.addColumns(projectId, groupId, [columnId]),
    onError: (err) => {
      toastEquivalenceError(err, 'Could not add column to row')
    },
    onSettled: () => {
      invalidateCore(queryClient, projectId)
    },
  })

  // ── removeColumnFromRowMutation ──────────────────────────────────────────
  // Handles both drag-to-panel and cell context-menu "Remove from row".
  // Path A (#323): backend `remove_columns` auto-dissolves the EG when the
  // removal empties it. The response carries `dissolved` so the frontend can
  // surface that explicitly if needed. The earlier frontend bandage that
  // fired a follow-up `equivalenceApi.delete` is retired; the backend does
  // the cleanup atomically in the same transaction.
  const removeColumnFromRowMutation = useMutation({
    mutationFn: ({ groupId, columnId }: { groupId: number; columnId: number }) =>
      equivalenceApi.removeColumns(projectId, groupId, [columnId]),
    onSettled: () => {
      invalidateCore(queryClient, projectId)
    },
    onError: () => {
      toast.error('Could not remove from row. Please try again.')
    },
  })

  // ── moveColumnMutation (drag-to-empty-cell, A6 mid-compose recovery) ─────
  // Composition: remove from source EG (if any) → add to target EG. If the
  // add fails after the remove succeeded, the column is left orphaned
  // (equivalence_group_id = NULL) and the toast carries a Retry action that
  // re-fires ONLY the add — don't re-fire the remove.
  const moveColumnMutation = useMutation<
    { columnId: number; targetEgId: number; datasetId: number; datasetName: string; columnCode: string | null; sourceEgId: number | null },
    unknown,
    { columnId: number; sourceEgId: number | null; targetEgId: number; datasetId: number; datasetName: string; columnCode: string | null },
    { previousColumns: { columns: ProjectColumnInfo[]; total: number } | undefined }
  >({
    mutationFn: async ({ columnId, sourceEgId, targetEgId, datasetId, datasetName, columnCode }) => {
      // Phase 1: remove from source EG if one exists
      if (sourceEgId != null) {
        try {
          await equivalenceApi.removeColumns(projectId, sourceEgId, [columnId])
        } catch (err) {
          // Tag the error so onError can distinguish remove vs add failures
          throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
            _movePhase: 'removing' as const,
            _moveParams: { columnId, sourceEgId, targetEgId },
          })
        }
      }
      // Phase 2: add to target EG
      try {
        await equivalenceApi.addColumns(projectId, targetEgId, [columnId])
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
          _movePhase: 'adding' as const,
          _moveParams: { columnId, sourceEgId, targetEgId },
        })
      }
      return { columnId, sourceEgId, targetEgId, datasetId, datasetName, columnCode }
    },
    onMutate: async ({ columnId, targetEgId }) => {
      await queryClient.cancelQueries({ queryKey: ['project-columns', projectId] })
      const previousColumns = queryClient.getQueryData<{ columns: ProjectColumnInfo[]; total: number }>(
        ['project-columns', projectId],
      )
      if (previousColumns) {
        const nextColumns = previousColumns.columns.map((c) =>
          c.id === columnId ? { ...c, equivalence_group_id: targetEgId } : c,
        )
        queryClient.setQueryData(['project-columns', projectId], {
          ...previousColumns,
          columns: nextColumns,
        })
      }
      return { previousColumns }
    },
    onSuccess: (info) => {
      onMoveSuccess?.({ ...info, timestamp: Date.now() })
      toast.success(
        `Moved ${info.columnCode ?? `col ${info.columnId}`} in ${info.datasetName}`,
        { id: 'crosswalk-move-toast' },
      )
    },
    onError: (err, vars, context) => {
      if (context?.previousColumns) {
        queryClient.setQueryData(['project-columns', projectId], context.previousColumns)
      }
      const phase = (err as { _movePhase?: 'removing' | 'adding' })._movePhase
      const { columnCode, datasetName, targetEgId } = vars
      if (phase === 'adding') {
        // Remove already landed — column is orphan. Provide Retry-add only.
        toast.error(
          `Removed ${columnCode ?? 'column'} from its row but could not add to target row in ${datasetName}.`,
          {
            id: 'crosswalk-move-toast',
            description: 'The column is now unassigned — retry or drag from the panel.',
            action: {
              label: 'Retry add',
              onClick: () =>
                addColumnToRowMutation.mutate({
                  groupId: targetEgId,
                  columnId: vars.columnId,
                }),
            },
            duration: 10000,
          },
        )
        return
      }
      toastEquivalenceError(err, 'Could not move column to target row')
    },
    onSettled: () => {
      invalidateCore(queryClient, projectId)
    },
  })

  // ── reorderRowsMutation (member reorder within a domain) ─────────────────
  const reorderRowsMutation = useMutation<
    unknown,
    unknown,
    { domainId: number; memberIds: number[] }
  >({
    mutationFn: ({ domainId, memberIds }) =>
      domainsApi.reorderMembers(projectId, domainId, memberIds),
    onError: () => {
      toast.error('Could not reorder rows.')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['analysis-domains', projectId] })
    },
  })

  // ── reorderDomainsMutation ────────────────────────────────────────────────
  const reorderDomainsMutation = useMutation<
    unknown,
    unknown,
    { domainIds: number[] },
    { previousDomains: AnalysisDomainListResponse | undefined }
  >({
    mutationFn: ({ domainIds }) => domainsApi.reorder(projectId, domainIds),
    onMutate: async ({ domainIds }) => {
      await queryClient.cancelQueries({ queryKey: ['analysis-domains', projectId] })
      const previousDomains = queryClient.getQueryData<AnalysisDomainListResponse>([
        'analysis-domains',
        projectId,
      ])
      if (previousDomains) {
        const byId = new Map(previousDomains.domains.map((d) => [d.id, d]))
        const nextDomains = domainIds
          .map((id) => byId.get(id))
          .filter((d): d is AnalysisDomainResponse => d != null)
        queryClient.setQueryData<AnalysisDomainListResponse>(
          ['analysis-domains', projectId],
          { ...previousDomains, domains: nextDomains },
        )
      }
      return { previousDomains }
    },
    onError: (_err, _vars, context) => {
      if (context?.previousDomains) {
        queryClient.setQueryData(['analysis-domains', projectId], context.previousDomains)
      }
      toast.error('Could not reorder variable groups.')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['analysis-domains', projectId] })
    },
  })

  // ── bulkTypeUpdateMutation (single-dataset path; see batch helper below)
  const bulkTypeUpdateMutation = useMutation<
    unknown,
    unknown,
    { datasetId: number; columnIds: number[]; columnType: string }
  >({
    mutationFn: ({ datasetId, columnIds, columnType }) =>
      recodeApi.bulkTypeUpdate(projectId, datasetId, columnIds, columnType),
    onError: (err) => {
      toastEquivalenceError(err, 'Failed to change column type')
    },
    onSettled: () => {
      invalidateCore(queryClient, projectId)
    },
  })

  // ── bulkAssignMutation (A2 Promise.allSettled partial failure) ───────────
  // For each column, creates a new equivalence group (row) and adds the
  // column to the target domain. The Path A unified row model retired the
  // earlier `as_additional` placement option — every column becomes a row.
  //
  // #335: when `equivalenceApi.create` succeeds but `domainsApi.addMembers`
  // then rejects, the EG was created. The catch path attaches the partial
  // groupId to the thrown error so the outer aggregator can surface it on
  // `failed[].partialGroupId`, and the Undo action deletes those orphan
  // EGs alongside the fully-succeeded ones.
  const bulkAssignMutation = useMutation<
    {
      succeeded: Array<{ columnId: number; groupId: number | null }>
      failed: Array<{ columnId: number; error: unknown; partialGroupId: number | null }>
    },
    unknown,
    {
      domainId: number
      domainName: string
      columnIds: number[]
      allColumns: ProjectColumnInfo[]
    }
  >({
    mutationFn: async ({ domainId, columnIds, allColumns }) => {
      const byId = new Map<number, ProjectColumnInfo>()
      for (const c of allColumns) byId.set(c.id, c)
      const results = await Promise.allSettled(
        columnIds.map(async (columnId) => {
          const col = byId.get(columnId)
          const label = col?.column_text?.slice(0, 80) ?? `Row for column ${columnId}`
          const grp = await equivalenceApi.create(projectId, { label, column_ids: [columnId] })
          try {
            await domainsApi.addMembers(projectId, domainId, [
              { member_type: 'column', member_id: columnId },
            ])
          } catch (err) {
            // Partial-success: EG exists, addMembers failed. Wrap (don't
            // mutate) the original error so concurrent rejections that
            // share a single Error instance — e.g. a single rate-limit
            // ApiError caught by multiple parallel calls — don't clobber
            // each other's _partialGroupId. Caller reads err._partialGroupId
            // off the wrapped instance via failed[].partialGroupId.
            const cause = err instanceof Error ? err : new Error(String(err))
            throw Object.assign(new Error(cause.message), {
              _partialGroupId: grp.id,
              cause,
            })
          }
          return { columnId, groupId: grp.id }
        }),
      )
      const succeeded: Array<{ columnId: number; groupId: number | null }> = []
      const failed: Array<{ columnId: number; error: unknown; partialGroupId: number | null }> = []
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          succeeded.push(r.value)
        } else {
          const partialGroupId =
            (r.reason as { _partialGroupId?: number })?._partialGroupId ?? null
          failed.push({ columnId: columnIds[idx], error: r.reason, partialGroupId })
        }
      })
      return { succeeded, failed }
    },
    onSuccess: (result, { domainName }) => {
      const { succeeded, failed } = result
      const orphanGroupIds = failed
        .map((f) => f.partialGroupId)
        .filter((g): g is number => g != null)
      const undoAll = async () => {
        // Delete both fully-succeeded EGs and orphan partial-success EGs.
        // Backend cascade removes the domain member via orphan cleanup.
        const idsToDelete = [
          ...succeeded.filter((s) => s.groupId != null).map((s) => s.groupId!),
          ...orphanGroupIds,
        ]
        await Promise.allSettled(
          idsToDelete.map((gid) => equivalenceApi.delete(projectId, gid)),
        )
        invalidateWithMetrics(queryClient, projectId)
        toast.success('Undone', { id: 'crosswalk-bulk-assign' })
      }

      if (failed.length === 0) {
        toast.success(`${succeeded.length} added to "${domainName}"`, {
          id: 'crosswalk-bulk-assign',
          action: { label: 'Undo', onClick: undoAll },
          duration: 8000,
        })
      } else if (succeeded.length === 0) {
        // All-fail. Conditionally surface Undo when there are orphan EGs to
        // clean up — without it the partial-success EGs leak silently.
        toast.error(`Could not add ${failed.length} columns to "${domainName}"`, {
          id: 'crosswalk-bulk-assign',
          description: 'Check the column types and try again.',
          ...(orphanGroupIds.length > 0
            ? { action: { label: 'Undo', onClick: undoAll }, duration: 10000 }
            : {}),
        })
      } else {
        toast.error(
          `${succeeded.length} of ${succeeded.length + failed.length} added to "${domainName}"; ${failed.length} failed.`,
          {
            id: 'crosswalk-bulk-assign',
            action: { label: 'Undo partial', onClick: undoAll },
            duration: 10000,
          },
        )
      }
    },
    onError: () => {
      toast.error('Bulk assign failed.')
    },
    onSettled: () => {
      // #335: the per-column inner fn calls domains.addMembers which marks
      // metrics stale. invalidateWithMetrics keeps the Σ badge in sync.
      invalidateWithMetrics(queryClient, projectId)
    },
  })

  // ── moveMembersMutation (Path A #328 + #342 Undo) ─────────────────────────
  // Atomic backend transaction: updates DatasetColumn.equivalence_group_id
  // AND AnalysisDomainMember in one round-trip. Replaces today's "drag
  // changes EG only" semantics. The endpoint returns reloaded source/target
  // domain shapes plus dissolved EG IDs and recomputed metric IDs.
  //
  // Optimistic patches are deferred — we rely on invalidate-on-settle for
  // the visible cell movement. The Phase 3.5 perf invariant is about render-
  // chain stability under stable mutation refs, not optimistic latency.
  //
  // #342 (2026-05-01): snapshot pre-move state so the consumer can offer
  // Undo. Mirrors the swap snapshot pattern. Initial scope: single-source
  // moves only (all moved columns share one prev EG/domain tuple). Multi-
  // source moves return inversePlan=null so the consumer can show "Undo
  // unavailable for moves spanning multiple sources" with no action.
  const moveMembersMutation = useMutation<
    MoveMembersResponse,
    unknown,
    MoveMembersRequest,
    MoveMutationContext
  >({
    mutationFn: (request) => crosswalkApi.moveMembers(projectId, request),

    onMutate: async (request) => {
      // Cancel in-flight queries so our snapshot is the canonical pre-move
      // state. Two keys we read from below.
      await queryClient.cancelQueries({ queryKey: ['project-columns', projectId] })
      await queryClient.cancelQueries({ queryKey: ['analysis-domains', projectId] })

      const previousColumns = queryClient.getQueryData<{ columns: ProjectColumnInfo[]; total: number }>(
        ['project-columns', projectId],
      )
      const previousDomains = queryClient.getQueryData<AnalysisDomainListResponse>(
        ['analysis-domains', projectId],
      )

      // Resolve labels for the toast text. Defensive against missing
      // snapshots (rare in practice; pages prefetch these on mount).
      const colsById = new Map((previousColumns?.columns ?? []).map(c => [c.id, c]))
      const domainsById = new Map((previousDomains?.domains ?? []).map(d => [d.id, d]))
      const sourceDomain = request.source_domain_id != null
        ? domainsById.get(request.source_domain_id)
        : null
      const targetDomain = request.target_domain_id != null
        ? domainsById.get(request.target_domain_id)
        : null

      const { inversePlan, sourceEgLabel } = previousColumns
        ? buildInversePlan(request, previousColumns.columns)
        : { inversePlan: null, sourceEgLabel: null }

      const columnCodes = request.column_ids.map(cid => colsById.get(cid)?.column_code ?? null)

      const snapshot: MoveSnapshot = {
        inversePlan,
        originalRequest: request,
        previousColumns,
        previousDomains,
        sourceLabels: {
          domain_name: sourceDomain?.name ?? null,
          eg_label: sourceEgLabel,
        },
        targetLabel: targetDomain?.name ?? null,
        columnCodes,
        columnIds: [...request.column_ids],
        dissolvedCount: 0,  // refined in onSuccess
        timestamp: Date.now(),
      }
      return snapshot
    },

    onSuccess: (data, _request, context) => {
      // If the response tells us a source EG was dissolved by this move,
      // refine the inverse plan from existing_eg → new_eg with the captured
      // label so the undo recreates the EG instead of failing on a 404.
      let plan = context?.inversePlan ?? null
      if (
        plan &&
        plan.target_mode === 'existing_eg' &&
        plan.target_eg_id != null &&
        data.dissolved_eg_ids.includes(plan.target_eg_id)
      ) {
        plan = {
          ...plan,
          target_mode: 'new_eg',
          target_eg_id: undefined,
          target_eg_label: context?.sourceLabels.eg_label ?? null,
        }
      }
      if (context && onMoveSnapshot) {
        onMoveSnapshot({
          ...context,
          inversePlan: plan,
          dissolvedCount: data.dissolved_eg_ids.length,
        })
      }
    },

    onError: (err, _request, context) => {
      // Rollback both snapshots to keep the cache consistent if any
      // optimistic patch were ever added later. Today this is defensive —
      // we don't optimistically patch, but the cancelQueries+snapshot
      // pattern is cheap and matches swapMutation.
      if (context?.previousColumns) {
        queryClient.setQueryData(['project-columns', projectId], context.previousColumns)
      }
      if (context?.previousDomains) {
        queryClient.setQueryData(['analysis-domains', projectId], context.previousDomains)
      }
      toastEquivalenceError(err, 'Move failed')
    },

    onSettled: () => {
      invalidateWithMetrics(queryClient, projectId)
    },
  })

  // ── swapMutation (shipped 3a — preserved verbatim) ───────────────────────
  const swapMutation = useMutation<
    EquivalenceGroupSwapResponse,
    unknown,
    ColumnSwap[],
    SwapMutationContext
  >({
    mutationFn: (swaps: ColumnSwap[]) => equivalenceApi.swap(projectId, swaps),

    onMutate: async (swaps) => {
      await queryClient.cancelQueries({ queryKey: ['project-columns', projectId] })
      await queryClient.cancelQueries({ queryKey: ['analysis-domains', projectId] })

      const previousColumns = queryClient.getQueryData<{ columns: ProjectColumnInfo[]; total: number }>(
        ['project-columns', projectId],
      )
      const previousDomains = queryClient.getQueryData<AnalysisDomainListResponse>(
        ['analysis-domains', projectId],
      )

      const affectedDatasetIds: number[] = []
      if (previousColumns) {
        const byId = new Map(previousColumns.columns.map((c) => [c.id, c]))
        const seen = new Set<number>()
        for (const { column_id_a, column_id_b } of swaps) {
          const a = byId.get(column_id_a)
          const b = byId.get(column_id_b)
          if (a && !seen.has(a.dataset_id)) {
            seen.add(a.dataset_id)
            affectedDatasetIds.push(a.dataset_id)
          }
          if (b && !seen.has(b.dataset_id)) {
            seen.add(b.dataset_id)
            affectedDatasetIds.push(b.dataset_id)
          }
        }

        const nextColumns = previousColumns.columns.map((c) => ({ ...c }))
        const idxById = new Map(nextColumns.map((c, i) => [c.id, i]))
        for (const { column_id_a, column_id_b } of swaps) {
          const iA = idxById.get(column_id_a)
          const iB = idxById.get(column_id_b)
          if (iA == null || iB == null) continue
          const egA = nextColumns[iA].equivalence_group_id
          const labelA = nextColumns[iA].equivalence_group_label
          nextColumns[iA].equivalence_group_id = nextColumns[iB].equivalence_group_id
          nextColumns[iA].equivalence_group_label = nextColumns[iB].equivalence_group_label
          nextColumns[iB].equivalence_group_id = egA
          nextColumns[iB].equivalence_group_label = labelA
        }
        queryClient.setQueryData(['project-columns', projectId], {
          ...previousColumns,
          columns: nextColumns,
        })
      }

      // #336 — optimistic membership swap. Mirror the backend's symmetric-
      // difference algorithm (routers/equivalence.py::swap_columns Phase 2b):
      // for each pair, replace col_a with col_b in domains containing only
      // col_a (and vice versa). Domains containing both or neither are
      // untouched. Without this, the round-trip briefly shows the phantom-
      // cell state we're fixing.
      if (previousDomains) {
        const nextDomains: AnalysisDomainListResponse = {
          ...previousDomains,
          domains: previousDomains.domains.map((d) => ({
            ...d,
            members: d.members.map((m) => ({ ...m })),
          })),
        }
        for (const { column_id_a, column_id_b } of swaps) {
          for (const domain of nextDomains.domains) {
            const memberIds = new Set(
              domain.members
                .filter((m) => m.member_type === 'column')
                .map((m) => m.member_id),
            )
            const hasA = memberIds.has(column_id_a)
            const hasB = memberIds.has(column_id_b)
            if (hasA && !hasB) {
              for (const m of domain.members) {
                if (m.member_type === 'column' && m.member_id === column_id_a) {
                  m.member_id = column_id_b
                }
              }
            } else if (hasB && !hasA) {
              for (const m of domain.members) {
                if (m.member_type === 'column' && m.member_id === column_id_b) {
                  m.member_id = column_id_a
                }
              }
            }
          }
        }
        queryClient.setQueryData<AnalysisDomainListResponse>(
          ['analysis-domains', projectId],
          nextDomains,
        )
      }

      const inversePayload: ColumnSwap[] = swaps.map((s) => ({
        column_id_a: s.column_id_b,
        column_id_b: s.column_id_a,
      }))

      return {
        previousColumns,
        previousDomains,
        inversePayload,
        timestamp: Date.now(),
        affectedDatasetIds,
      }
    },

    onError: (err, swaps, context) => {
      if (context?.previousColumns) {
        queryClient.setQueryData(['project-columns', projectId], context.previousColumns)
      }
      // #336: roll back the optimistic membership patch alongside columns.
      if (context?.previousDomains) {
        queryClient.setQueryData(['analysis-domains', projectId], context.previousDomains)
      }

      const parsed = parseSwapError(err)
      if (!parsed) {
        toast.error('Swap failed. Please try again.')
        return
      }

      switch (parsed.error) {
        case 'type_mismatch':
          // Phase 3b.6: hand off to SwapErrorOverlay if caller wants the
          // fix-links flow; otherwise fall back to the Phase 3a toast.
          if (onSwapTypeMismatch) {
            onSwapTypeMismatch(swaps, parsed)
          } else {
            toast.error('Type mismatch', {
              description:
                parsed.message ?? 'Both cells must have the same column type. Change the type in Dataset View and try again.',
            })
          }
          break
        case 'cross_dataset':
          toast.error('Cells must be in the same dataset column to swap.')
          break
        case 'not_linked':
          break
        case 'cross_dataset_unpaired':
          toast.error('Swap would leave a variable group unpaired', {
            id: 'crosswalk-unpaired-toast',
            description:
              parsed.message ??
              'One of the affected variable groups spans multiple datasets, and this swap would leave a member without a cross-dataset equivalent.',
            duration: 10000,
          })
          break
      }
    },

    onSuccess: (_data, _swaps, context) => {
      if (context && onSwapSuccess) {
        onSwapSuccess({
          previousColumns: context.previousColumns,
          inversePayload: context.inversePayload,
          timestamp: context.timestamp,
        })
      }
    },

    onSettled: (_data, _err, _swaps, context) => {
      queryClient.invalidateQueries({ queryKey: ['project-columns', projectId] })
      queryClient.invalidateQueries({ queryKey: ['equivalence-groups', projectId] })
      queryClient.invalidateQueries({ queryKey: ['analysis-domains', projectId] })
      // #335: backend equivalence.py:755 calls mark_metrics_stale + sync
      // recompute. The Σ scale-score badge state lives in ['metrics', pid],
      // so it must invalidate or the badge will lag until next refetch.
      queryClient.invalidateQueries({ queryKey: ['metrics', projectId] })
      if (context?.affectedDatasetIds) {
        for (const did of context.affectedDatasetIds) {
          queryClient.invalidateQueries({ queryKey: ['dataset-data', did] })
        }
      }
    },
  })

  return {
    // Mutations
    swapMutation,
    moveMembersMutation,
    removeColumnFromRowMutation,
    moveColumnMutation,
    createDomainMutation,
    bulkCreateDomainsMutation,
    createScoreMetricMutation,
    updateDomainMutation,
    deleteDomainMutation,
    addMembersMutation,
    removeMembersMutation,
    deleteRowMutation,
    addColumnToRowMutation,
    reorderRowsMutation,
    reorderDomainsMutation,
    bulkTypeUpdateMutation,
    bulkAssignMutation,
    // helpers for consumers that need to dispatch a column-code toast
    describeColumn,
  }
}

// ─── Batch helper: bulk type update across datasets ──────────────────────────
// Wraps `recodeApi.bulkTypeUpdate` in a per-dataset fan-out. Matches the
// directive's foot-gun — `bulk_type_update` is dataset-scoped, so when the
// crosswalk needs to change types across multiple datasets at once (e.g. the
// row-level fix in SwapErrorOverlay), we issue one call per dataset and
// aggregate the outcome.
export interface BatchBulkTypeUpdateResult {
  succeededDatasetIds: number[]
  failed: Array<{ datasetId: number; error: unknown }>
}

export async function batchBulkTypeUpdateByDataset(
  projectId: number,
  columnIds: number[],
  newType: string,
  allColumns: ProjectColumnInfo[],
): Promise<BatchBulkTypeUpdateResult> {
  const byDataset = new Map<number, number[]>()
  const colById = new Map<number, ProjectColumnInfo>()
  for (const c of allColumns) colById.set(c.id, c)
  for (const cid of columnIds) {
    const col = colById.get(cid)
    if (!col) continue
    if (!byDataset.has(col.dataset_id)) byDataset.set(col.dataset_id, [])
    byDataset.get(col.dataset_id)!.push(cid)
  }
  const datasetIds = Array.from(byDataset.keys())
  const results = await Promise.allSettled(
    datasetIds.map((dsId) =>
      recodeApi.bulkTypeUpdate(projectId, dsId, byDataset.get(dsId)!, newType),
    ),
  )
  const succeededDatasetIds: number[] = []
  const failed: Array<{ datasetId: number; error: unknown }> = []
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled') {
      succeededDatasetIds.push(datasetIds[idx])
    } else {
      failed.push({ datasetId: datasetIds[idx], error: r.reason })
    }
  })
  return { succeededDatasetIds, failed }
}
