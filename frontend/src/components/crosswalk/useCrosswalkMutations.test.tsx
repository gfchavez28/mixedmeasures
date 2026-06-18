/**
 * Unit tests for `useCrosswalkMutations` — the 1,019-LOC, 17-mutation hook
 * that backs the Tier 3 crosswalk's drag/drop, bulk-assign, suggest-accept,
 * and rename flows.
 *
 * Why this file exists (audit ref the internal design notes
 * §7 Priority 3): two silent bugs have shipped against this hook —
 *   - moveColumnMutation orphan-path on phase=adding error (still latent)
 *   - moveMembersMutation same-domain member loss (fixed in 684f6cc)
 * — and the hook had zero unit-test coverage. This file locks in the
 * lifecycle, optimistic-update, and error-branch behavior of the 5 highest-
 * risk mutations + a small moveMembersMutation block to guard the 684f6cc
 * regression.
 *
 * Scope honesty: this file tests the MUTATIONS hook only. The DnD-layer
 * routing decisions that produced the prior moveColumn orphan bug are
 * covered by `useCrosswalkDnD.test.tsx`. A unit test of the mutations hook
 * cannot catch a bug where the wrong mutation is dispatched — it can only
 * catch a bug where the right mutation behaves wrongly once dispatched.
 *
 * History: this file initially shipped (Priority 3) with five
 * "locked-in-but-flagged" behaviors that asserted the buggy CURRENT state
 * via negative matches + // TODO(#335) markers, so the future fix would
 * break the tests visibly. Issue #335 closed those gaps:
 *   1. swapMutation.onSettled now invalidates ['metrics', pid] (test 2.7).
 *   2. addMembersMutation / removeMembersMutation / bulkAssignMutation
 *      onSettled all moved from invalidateCore → invalidateWithMetrics
 *      (tests 4.5 / 5.3 / 5.4 lock this).
 *   3. bulkAssignMutation orphan-EG leak: the inner per-column async fn
 *      now attaches the partial groupId to the thrown error so undo can
 *      delete the orphaned EG. Test 4.4 (formerly it.todo) locks this.
 *
 * Mock strategy: each API submodule is mocked individually via vi.mock(),
 * which is hoisted before all imports. The hook uses the barrel
 * `@/lib/api`; vitest's module registry intercepts the underlying paths so
 * the barrel re-exports the mocked versions. ApiError is NOT mocked —
 * `parseEquivalenceErrorDetail` uses `instanceof ApiError`.
 *
 * Test order minimizes infrastructure churn (per audit Plan-agent advice):
 *   1. moveColumnMutation (flushes deferred-promise + Retry-action wiring)
 *   2. swapMutation
 *   3. reorderDomainsMutation
 *   4. bulkAssignMutation
 *   5. moveMembersMutation
 *   6. createDomain + createScoreMetric chain (hardest — cross-mutation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiError } from '@/lib/api/client'
import type { ProjectColumnInfo } from '@/lib/api/datasets'
import type {
  AnalysisDomainResponse,
  AnalysisDomainListResponse,
  CreateScoreMetricResponse,
} from '@/lib/api/analysis-domains'
import type { MetricListResponse, MetricDefinitionSummaryResponse } from '@/lib/api/metrics'
import type { MoveMembersResponse } from '@/lib/api/crosswalk'
import type { ColumnSwap, EquivalenceGroupSwapResponse } from '@/lib/api/equivalence'
import type { SwapError } from './useCrosswalkMutations'
import { useCrosswalkMutations } from './useCrosswalkMutations'

// ─── Mocks (hoisted before all imports) ───────────────────────────────────────

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@/lib/api/equivalence', () => ({
  equivalenceApi: {
    swap: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    addColumns: vi.fn(),
    removeColumns: vi.fn(),
  },
}))

vi.mock('@/lib/api/analysis-domains', () => ({
  domainsApi: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    addMembers: vi.fn(),
    removeMembers: vi.fn(),
    reorder: vi.fn(),
    reorderMembers: vi.fn(),
    createScoreMetric: vi.fn(),
    bulkCreate: vi.fn(),
  },
}))

vi.mock('@/lib/api/crosswalk', () => ({
  crosswalkApi: { moveMembers: vi.fn() },
}))

// `recodeApi` lives in @/lib/api/datasets — must mock that module to avoid
// the real datasetsApi/recodeApi hitting fetch on accidental call.
vi.mock('@/lib/api/datasets', () => ({
  datasetsApi: {},
  recodeApi: { bulkTypeUpdate: vi.fn() },
}))

vi.mock('@/lib/api/metrics', () => ({
  metricsApi: { list: vi.fn(), update: vi.fn() },
}))

import { toast } from 'sonner'
import { equivalenceApi } from '@/lib/api/equivalence'
import { domainsApi } from '@/lib/api/analysis-domains'
import { crosswalkApi } from '@/lib/api/crosswalk'

// ─── Shared helpers ───────────────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Real ApiError (per equivalenceErrors.test.ts). The hook's
 * `parseEquivalenceErrorDetail` uses `instanceof ApiError` — a plain Error
 * with response.data.detail does NOT match. */
function makeApiError(detail: unknown, status = 409): ApiError {
  return new ApiError(status, { detail }, {})
}

/** Build a `parseSwapError`-shaped error. The hook reads
 * `(err as any).response?.data?.detail` for swap parsing — NOT
 * `instanceof ApiError`. So a plain object with the response shape works. */
function makeSwapError(
  errorCode: 'type_mismatch' | 'cross_dataset' | 'not_linked' | 'cross_dataset_unpaired',
  extra: Record<string, unknown> = {},
): Error & { response: { data: { detail: unknown } } } {
  const e = new Error(`swap_${errorCode}`) as Error & { response: { data: { detail: unknown } } }
  e.response = {
    data: { detail: { error: errorCode, message: `swap failed: ${errorCode}`, ...extra } },
  }
  return e
}

function buildColumn(overrides: Partial<ProjectColumnInfo> & { id: number }): ProjectColumnInfo {
  return {
    id: overrides.id,
    dataset_id: overrides.dataset_id ?? 100,
    dataset_name: overrides.dataset_name ?? `Dataset ${overrides.dataset_id ?? 100}`,
    dataset_color: overrides.dataset_color ?? null,
    column_code: overrides.column_code ?? `C${overrides.id}`,
    column_name: overrides.column_name ?? null,
    column_text: overrides.column_text ?? `Column ${overrides.id}`,
    column_type: overrides.column_type ?? 'ordinal',
    scale_points: overrides.scale_points ?? 5,
    scale_labels: overrides.scale_labels ?? null,
    recode_def_count: overrides.recode_def_count ?? 0,
    equivalence_group_id: overrides.equivalence_group_id ?? null,
    equivalence_group_label: overrides.equivalence_group_label ?? null,
  }
}

function buildDomain(id: number, name: string): AnalysisDomainResponse {
  return {
    id,
    project_id: 1,
    name,
    description: null,
    color: null,
    sequence_order: id,
    origin: 'human',
    member_count: 0,
    members: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

interface SetupOptions {
  onSwapSuccess?: (s: { previousColumns: unknown; inversePayload: unknown; timestamp: number }) => void
  onMoveSuccess?: (info: unknown) => void
  onMoveSnapshot?: (snap: unknown) => void
  onScoreMetricFailed?: (domainId: number) => void
  onScoreMetricRecovered?: (domainId: number) => void
  // Pass `null` to omit the callback (test 2.5 needs the without-callback branch).
  // Otherwise pass a function — typed loosely; useCrosswalkMutations narrows internally.
  onSwapTypeMismatch?: ((payload: never, error: never) => void) | null
}

function setupHook(opts: SetupOptions = {}) {
  const qc = new QueryClient({
    defaultOptions: {
      // NOTE: leave gcTime at default (5min). Setting gcTime: 0 GCs cache
      // entries that have no active observer the moment invalidateQueries
      // marks them stale — which makes seeded test caches evaporate before
      // post-settle assertions can read them.
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  // Spy invalidateQueries — capture every settled invalidation pattern.
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
  const callbacks = {
    onSwapSuccess: vi.fn(opts.onSwapSuccess),
    onMoveSuccess: vi.fn(opts.onMoveSuccess),
    onMoveSnapshot: vi.fn(opts.onMoveSnapshot),
    onScoreMetricFailed: vi.fn(opts.onScoreMetricFailed),
    onScoreMetricRecovered: vi.fn(opts.onScoreMetricRecovered),
    // null sentinel ⇒ pass undefined (test 2.5 needs the without-callback branch).
    onSwapTypeMismatch:
      opts.onSwapTypeMismatch === null
        ? undefined
        : vi.fn(opts.onSwapTypeMismatch ?? ((() => {}) as never)),
  }
  // No <StrictMode> — would double-fire onMutate.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(
    () =>
      useCrosswalkMutations({
        projectId: 1,
        onSwapSuccess: callbacks.onSwapSuccess,
        onMoveSuccess: callbacks.onMoveSuccess,
        onMoveSnapshot: callbacks.onMoveSnapshot,
        onScoreMetricFailed: callbacks.onScoreMetricFailed,
        onScoreMetricRecovered: callbacks.onScoreMetricRecovered,
        onSwapTypeMismatch: callbacks.onSwapTypeMismatch as unknown as
          | ((payload: ColumnSwap[], error: SwapError) => void)
          | undefined,
      }),
    { wrapper },
  )
  return { result, qc, callbacks, invalidateSpy }
}

/** True if invalidateQueries was ever called with a queryKey deep-equal to
 * `key`. TanStack v5 always passes an options object; we match `queryKey`. */
function wasInvalidatedWith(spy: ReturnType<typeof vi.spyOn>, key: unknown[]): boolean {
  for (const call of spy.mock.calls) {
    const filter = call[0] as { queryKey?: unknown[] } | undefined
    if (filter?.queryKey && JSON.stringify(filter.queryKey) === JSON.stringify(key)) {
      return true
    }
  }
  return false
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════════════════════
// 1. moveColumnMutation
// ═══════════════════════════════════════════════════════════════════════════════

describe('moveColumnMutation', () => {
  const moveVars = {
    columnId: 5001,
    sourceEgId: 200 as number | null,
    targetEgId: 300,
    datasetId: 100,
    datasetName: 'Survey 2024',
    columnCode: 'Q1',
  }

  it('1.1 success: removes from source then adds to target, fires onMoveSuccess', async () => {
    const { result, callbacks } = setupHook()
    vi.mocked(equivalenceApi.removeColumns).mockResolvedValueOnce({
      group: null,
      dissolved: false,
    })
    vi.mocked(equivalenceApi.addColumns).mockResolvedValueOnce({} as never)

    act(() => {
      result.current.moveColumnMutation.mutate(moveVars)
    })

    await waitFor(() =>
      expect(result.current.moveColumnMutation.isSuccess).toBe(true),
    )

    expect(equivalenceApi.removeColumns).toHaveBeenCalledWith(1, 200, [5001])
    expect(equivalenceApi.addColumns).toHaveBeenCalledWith(1, 300, [5001])
    expect(callbacks.onMoveSuccess).toHaveBeenCalledTimes(1)
    const moveInfo = callbacks.onMoveSuccess.mock.calls[0][0] as Record<string, unknown>
    expect(moveInfo).toMatchObject({
      columnId: 5001,
      sourceEgId: 200,
      targetEgId: 300,
      datasetId: 100,
      datasetName: 'Survey 2024',
      columnCode: 'Q1',
    })
    expect(moveInfo.timestamp).toEqual(expect.any(Number))
    expect(toast.success).toHaveBeenCalledWith(
      'Moved Q1 in Survey 2024',
      expect.objectContaining({ id: 'crosswalk-move-toast' }),
    )
  })

  it('1.2 success with sourceEgId=null: skips remove, only adds', async () => {
    const { result } = setupHook()
    vi.mocked(equivalenceApi.addColumns).mockResolvedValueOnce({} as never)

    act(() => {
      result.current.moveColumnMutation.mutate({ ...moveVars, sourceEgId: null })
    })

    await waitFor(() =>
      expect(result.current.moveColumnMutation.isSuccess).toBe(true),
    )

    expect(equivalenceApi.removeColumns).not.toHaveBeenCalled()
    expect(equivalenceApi.addColumns).toHaveBeenCalledWith(1, 300, [5001])
  })

  it('1.3 optimistic patch sets target EG mid-flight, rolls back on error', async () => {
    const { result, qc } = setupHook()
    qc.setQueryData(['project-columns', 1], {
      columns: [buildColumn({ id: 5001, equivalence_group_id: 200 })],
      total: 1,
    })

    const removeDeferred = deferred<{ group: null; dissolved: boolean }>()
    vi.mocked(equivalenceApi.removeColumns).mockReturnValueOnce(removeDeferred.promise)

    act(() => {
      result.current.moveColumnMutation.mutate(moveVars)
    })

    // Wait for onMutate to apply the optimistic patch.
    await waitFor(() => {
      const data = qc.getQueryData<{ columns: ProjectColumnInfo[] }>(['project-columns', 1])
      expect(data?.columns[0].equivalence_group_id).toBe(300)
    })

    // Reject Phase 1 to drive the rollback path.
    removeDeferred.reject(new Error('boom'))
    await waitFor(() =>
      expect(result.current.moveColumnMutation.isError).toBe(true),
    )

    const after = qc.getQueryData<{ columns: ProjectColumnInfo[] }>(['project-columns', 1])
    expect(after?.columns[0].equivalence_group_id).toBe(200)
  })

  it('1.4 phase=removing error: rollback + generic toast, no Retry action', async () => {
    const { result } = setupHook()
    vi.mocked(equivalenceApi.removeColumns).mockRejectedValueOnce(new Error('removing-failed'))

    act(() => {
      result.current.moveColumnMutation.mutate(moveVars)
    })
    await waitFor(() =>
      expect(result.current.moveColumnMutation.isError).toBe(true),
    )

    expect(equivalenceApi.addColumns).not.toHaveBeenCalled()
    // toastEquivalenceError fallback path (no structured ApiError detail).
    expect(toast.error).toHaveBeenCalledWith('Could not move column to target row')
    // No Retry-add action toast in this branch.
    const errorCalls = vi.mocked(toast.error).mock.calls
    const hasRetryAction = errorCalls.some(
      ([, opts]) =>
        typeof opts === 'object' &&
        opts !== null &&
        (opts as { action?: { label?: string } }).action?.label === 'Retry add',
    )
    expect(hasRetryAction).toBe(false)
  })

  it('1.5 phase=adding error (orphan path): rollback + Retry-add action invokes addColumns only', async () => {
    const { result } = setupHook()
    vi.mocked(equivalenceApi.removeColumns).mockResolvedValueOnce({
      group: null,
      dissolved: false,
    })
    vi.mocked(equivalenceApi.addColumns).mockRejectedValueOnce(new Error('adding-failed'))

    act(() => {
      result.current.moveColumnMutation.mutate(moveVars)
    })
    await waitFor(() =>
      expect(result.current.moveColumnMutation.isError).toBe(true),
    )

    // Phase 1 ran, Phase 2 ran (and failed) — both endpoints touched once.
    expect(equivalenceApi.removeColumns).toHaveBeenCalledTimes(1)
    expect(equivalenceApi.addColumns).toHaveBeenCalledTimes(1)

    // Toast carries the orphan-path id, description, and Retry-add action.
    const errorCall = vi.mocked(toast.error).mock.calls.find(
      ([, opts]) =>
        typeof opts === 'object' &&
        opts !== null &&
        (opts as { action?: { label?: string } }).action?.label === 'Retry add',
    )
    expect(errorCall).toBeDefined()
    const opts = errorCall![1] as {
      id?: string
      description?: string
      action: { label?: string; onClick: () => void }
    }
    expect(opts.id).toBe('crosswalk-move-toast')
    expect(opts.description).toEqual(expect.stringContaining('unassigned'))

    // Invoke the Retry-add action; expect ONLY addColumns to fire (no removeColumns).
    const removeCallsBefore = vi.mocked(equivalenceApi.removeColumns).mock.calls.length
    const addCallsBefore = vi.mocked(equivalenceApi.addColumns).mock.calls.length
    vi.mocked(equivalenceApi.addColumns).mockResolvedValueOnce({} as never)

    act(() => {
      opts.action.onClick()
    })

    await waitFor(() => {
      expect(vi.mocked(equivalenceApi.addColumns).mock.calls.length).toBe(addCallsBefore + 1)
    })
    expect(vi.mocked(equivalenceApi.removeColumns).mock.calls.length).toBe(removeCallsBefore)
    const addCalls = vi.mocked(equivalenceApi.addColumns).mock.calls
    const lastAdd = addCalls[addCalls.length - 1]
    expect(lastAdd).toEqual([1, 300, [5001]])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. swapMutation
// ═══════════════════════════════════════════════════════════════════════════════

describe('swapMutation', () => {
  const colA = buildColumn({
    id: 7001,
    dataset_id: 100,
    equivalence_group_id: 50,
    equivalence_group_label: 'Vision',
  })
  const colB = buildColumn({
    id: 7002,
    dataset_id: 200,
    equivalence_group_id: 60,
    equivalence_group_label: 'Hearing',
  })

  function seedSwapColumns(qc: QueryClient) {
    qc.setQueryData(['project-columns', 1], { columns: [colA, colB], total: 2 })
  }

  it('2.1 optimistic update swaps EG ids and labels mid-flight', async () => {
    const { result, qc } = setupHook()
    seedSwapColumns(qc)

    const d = deferred<EquivalenceGroupSwapResponse>()
    vi.mocked(equivalenceApi.swap).mockReturnValueOnce(d.promise)

    act(() => {
      result.current.swapMutation.mutate([{ column_id_a: 7001, column_id_b: 7002 }])
    })

    await waitFor(() => {
      const data = qc.getQueryData<{ columns: ProjectColumnInfo[] }>(['project-columns', 1])
      expect(data?.columns[0].equivalence_group_id).toBe(60)
      expect(data?.columns[0].equivalence_group_label).toBe('Hearing')
      expect(data?.columns[1].equivalence_group_id).toBe(50)
      expect(data?.columns[1].equivalence_group_label).toBe('Vision')
    })

    d.resolve({ updated_groups: [], recomputed_metric_ids: [] })
    await waitFor(() => expect(result.current.swapMutation.isSuccess).toBe(true))
  })

  it('2.2 onSuccess fires onSwapSuccess with previousColumns + inversePayload + timestamp', async () => {
    const { result, qc, callbacks } = setupHook()
    seedSwapColumns(qc)
    vi.mocked(equivalenceApi.swap).mockResolvedValueOnce({
      updated_groups: [],
      recomputed_metric_ids: [],
    })

    act(() => {
      result.current.swapMutation.mutate([{ column_id_a: 7001, column_id_b: 7002 }])
    })
    await waitFor(() => expect(result.current.swapMutation.isSuccess).toBe(true))

    expect(callbacks.onSwapSuccess).toHaveBeenCalledTimes(1)
    const arg = callbacks.onSwapSuccess.mock.calls[0][0] as {
      previousColumns: unknown
      inversePayload: { column_id_a: number; column_id_b: number }[]
      timestamp: number
    }
    expect(arg.previousColumns).toBeDefined()
    expect(arg.inversePayload).toEqual([{ column_id_a: 7002, column_id_b: 7001 }])
    expect(typeof arg.timestamp).toBe('number')
  })

  it('2.3 rollback restores previousColumns on error', async () => {
    const { result, qc } = setupHook()
    seedSwapColumns(qc)
    vi.mocked(equivalenceApi.swap).mockRejectedValueOnce(makeSwapError('cross_dataset'))

    act(() => {
      result.current.swapMutation.mutate([{ column_id_a: 7001, column_id_b: 7002 }])
    })
    await waitFor(() => expect(result.current.swapMutation.isError).toBe(true))

    const after = qc.getQueryData<{ columns: ProjectColumnInfo[] }>(['project-columns', 1])
    expect(after?.columns[0].equivalence_group_id).toBe(50)
    expect(after?.columns[0].equivalence_group_label).toBe('Vision')
    expect(after?.columns[1].equivalence_group_id).toBe(60)
  })

  it('2.4 type_mismatch with onSwapTypeMismatch callback wired: callback fires, no toast', async () => {
    const onSwapTypeMismatch = vi.fn()
    const { result, qc } = setupHook({ onSwapTypeMismatch })
    seedSwapColumns(qc)
    const err = makeSwapError('type_mismatch', { column_ids: [7001, 7002] })
    vi.mocked(equivalenceApi.swap).mockRejectedValueOnce(err)

    const swaps = [{ column_id_a: 7001, column_id_b: 7002 }]
    act(() => {
      result.current.swapMutation.mutate(swaps)
    })
    await waitFor(() => expect(result.current.swapMutation.isError).toBe(true))

    expect(onSwapTypeMismatch).toHaveBeenCalledTimes(1)
    expect(onSwapTypeMismatch).toHaveBeenCalledWith(
      swaps,
      expect.objectContaining({ error: 'type_mismatch' }),
    )
    // No type-mismatch toast (callback owns the UI).
    const typeMismatchToast = vi
      .mocked(toast.error)
      .mock.calls.find(([title]) => title === 'Type mismatch')
    expect(typeMismatchToast).toBeUndefined()
  })

  it('2.5 type_mismatch without callback: falls back to toast', async () => {
    // Pass null sentinel so setupHook leaves onSwapTypeMismatch undefined.
    const { result, qc } = setupHook({ onSwapTypeMismatch: null })
    seedSwapColumns(qc)
    vi.mocked(equivalenceApi.swap).mockRejectedValueOnce(
      makeSwapError('type_mismatch', { column_ids: [7001, 7002] }),
    )

    act(() => {
      result.current.swapMutation.mutate([{ column_id_a: 7001, column_id_b: 7002 }])
    })
    await waitFor(() => expect(result.current.swapMutation.isError).toBe(true))

    expect(toast.error).toHaveBeenCalledWith(
      'Type mismatch',
      expect.objectContaining({ description: expect.any(String) }),
    )
  })

  it.each([
    ['cross_dataset', 'Cells must be in the same dataset column to swap.', true],
    ['not_linked', null, false],
    [
      'cross_dataset_unpaired',
      'Swap would leave a variable group unpaired',
      true,
    ],
  ] as const)(
    '2.6 [%s] dispatches expected toast (or silent for not_linked)',
    async (errorCode, expectedTitle, shouldToast) => {
      const { result, qc } = setupHook()
      seedSwapColumns(qc)
      vi.mocked(equivalenceApi.swap).mockRejectedValueOnce(
        makeSwapError(errorCode as 'cross_dataset' | 'not_linked' | 'cross_dataset_unpaired'),
      )

      act(() => {
        result.current.swapMutation.mutate([{ column_id_a: 7001, column_id_b: 7002 }])
      })
      await waitFor(() => expect(result.current.swapMutation.isError).toBe(true))

      if (shouldToast && expectedTitle) {
        const matched = vi
          .mocked(toast.error)
          .mock.calls.find(([title]) => title === expectedTitle)
        expect(matched).toBeDefined()
      } else {
        // not_linked is intentionally silent — assert NO error toast was emitted.
        expect(toast.error).not.toHaveBeenCalled()
      }
    },
  )

  it('2.7 onSettled invalidates project-columns, equivalence-groups, analysis-domains, metrics, and per-affected-dataset', async () => {
    const { result, qc, invalidateSpy } = setupHook()
    seedSwapColumns(qc)
    vi.mocked(equivalenceApi.swap).mockResolvedValueOnce({
      updated_groups: [],
      recomputed_metric_ids: [],
    })

    act(() => {
      result.current.swapMutation.mutate([{ column_id_a: 7001, column_id_b: 7002 }])
    })
    await waitFor(() => expect(result.current.swapMutation.isSuccess).toBe(true))

    expect(wasInvalidatedWith(invalidateSpy, ['project-columns', 1])).toBe(true)
    expect(wasInvalidatedWith(invalidateSpy, ['equivalence-groups', 1])).toBe(true)
    expect(wasInvalidatedWith(invalidateSpy, ['analysis-domains', 1])).toBe(true)
    // Per-dataset invalidation: dataset 100 (colA) and 200 (colB) were both touched.
    expect(wasInvalidatedWith(invalidateSpy, ['dataset-data', 100])).toBe(true)
    expect(wasInvalidatedWith(invalidateSpy, ['dataset-data', 200])).toBe(true)
    // #335: backend equivalence.py:755 calls mark_metrics_stale + sync
    // recompute, so frontend MUST invalidate ['metrics', 1] to keep the
    // Σ scale-score badge in sync.
    expect(wasInvalidatedWith(invalidateSpy, ['metrics', 1])).toBe(true)
  })

  it('2.8 unparseable error (raw Error, not structured): generic fallback toast', async () => {
    const { result, qc } = setupHook()
    seedSwapColumns(qc)
    vi.mocked(equivalenceApi.swap).mockRejectedValueOnce(new Error('network down'))

    act(() => {
      result.current.swapMutation.mutate([{ column_id_a: 7001, column_id_b: 7002 }])
    })
    await waitFor(() => expect(result.current.swapMutation.isError).toBe(true))

    expect(toast.error).toHaveBeenCalledWith('Swap failed. Please try again.')
  })

  // ─────────────────────────────────────────────────────────────────────
  // #336 (Batch B) — optimistic membership patch
  // ─────────────────────────────────────────────────────────────────────
  // The swap mutation now atomically swaps domain membership server-side;
  // the optimistic onMutate mirrors that with a symmetric-difference
  // update on ['analysis-domains', pid] so the UI doesn't briefly render
  // the phantom-cell state during the round-trip.

  function seedDomainsForMembershipSwap(qc: QueryClient) {
    // Domain D1 has col 7001 (Vision); Domain D2 has col 7002 (Hearing).
    // No overlap. After swap: D1 should have col 7002, D2 should have col 7001.
    const list: AnalysisDomainListResponse = {
      domains: [
        {
          ...buildDomain(801, 'D1'),
          members: [
            {
              id: 9001,
              member_type: 'column',
              member_id: 7001,
              label: 'C7001',
              dataset_id: 100,
              dataset_name: 'Dataset 100',
              column_code: 'C7001',
              column_type: 'ordinal',
              scale_points: 5,
              scale_labels: null,
              equivalence_group_id: 50,
            },
          ],
          member_count: 1,
        },
        {
          ...buildDomain(802, 'D2'),
          members: [
            {
              id: 9002,
              member_type: 'column',
              member_id: 7002,
              label: 'C7002',
              dataset_id: 200,
              dataset_name: 'Dataset 200',
              column_code: 'C7002',
              column_type: 'ordinal',
              scale_points: 5,
              scale_labels: null,
              equivalence_group_id: 60,
            },
          ],
          member_count: 1,
        },
      ],
      total: 2,
    }
    qc.setQueryData(['analysis-domains', 1], list)
  }

  it('2.9 #336 optimistic membership swap: D1 gets col 7002, D2 gets col 7001 mid-flight', async () => {
    const { result, qc } = setupHook()
    seedSwapColumns(qc)
    seedDomainsForMembershipSwap(qc)

    const d = deferred<EquivalenceGroupSwapResponse>()
    vi.mocked(equivalenceApi.swap).mockReturnValueOnce(d.promise)

    act(() => {
      result.current.swapMutation.mutate([{ column_id_a: 7001, column_id_b: 7002 }])
    })

    await waitFor(() => {
      const domains = qc.getQueryData<AnalysisDomainListResponse>(['analysis-domains', 1])
      const d1 = domains?.domains.find((d) => d.id === 801)
      const d2 = domains?.domains.find((d) => d.id === 802)
      // D1's only member was col 7001; now it should be col 7002.
      expect(d1?.members.map((m) => m.member_id)).toEqual([7002])
      // D2's only member was col 7002; now it should be col 7001.
      expect(d2?.members.map((m) => m.member_id)).toEqual([7001])
    })

    d.resolve({ updated_groups: [], recomputed_metric_ids: [] })
    await waitFor(() => expect(result.current.swapMutation.isSuccess).toBe(true))
  })

  it('2.10 #336 rollback on error restores both project-columns AND analysis-domains', async () => {
    const { result, qc } = setupHook()
    seedSwapColumns(qc)
    seedDomainsForMembershipSwap(qc)
    vi.mocked(equivalenceApi.swap).mockRejectedValueOnce(makeSwapError('cross_dataset'))

    act(() => {
      result.current.swapMutation.mutate([{ column_id_a: 7001, column_id_b: 7002 }])
    })
    await waitFor(() => expect(result.current.swapMutation.isError).toBe(true))

    const domains = qc.getQueryData<AnalysisDomainListResponse>(['analysis-domains', 1])
    const d1 = domains?.domains.find((d) => d.id === 801)
    const d2 = domains?.domains.find((d) => d.id === 802)
    // Rollback: D1 has col 7001 again; D2 has col 7002 again.
    expect(d1?.members.map((m) => m.member_id)).toEqual([7001])
    expect(d2?.members.map((m) => m.member_id)).toEqual([7002])
  })

  it('2.11 #336 same-domain swap (both cols members of D): no membership change', async () => {
    const { result, qc } = setupHook()
    seedSwapColumns(qc)
    // Domain D contains BOTH columns (typical same-bracket swap scenario).
    qc.setQueryData<AnalysisDomainListResponse>(['analysis-domains', 1], {
      domains: [
        {
          ...buildDomain(803, 'D'),
          members: [
            {
              id: 9011,
              member_type: 'column',
              member_id: 7001,
              label: 'C7001',
              dataset_id: 100,
              dataset_name: 'Dataset 100',
              column_code: 'C7001',
              column_type: 'ordinal',
              scale_points: 5,
              scale_labels: null,
              equivalence_group_id: 50,
            },
            {
              id: 9012,
              member_type: 'column',
              member_id: 7002,
              label: 'C7002',
              dataset_id: 200,
              dataset_name: 'Dataset 200',
              column_code: 'C7002',
              column_type: 'ordinal',
              scale_points: 5,
              scale_labels: null,
              equivalence_group_id: 60,
            },
          ],
          member_count: 2,
        },
      ],
      total: 1,
    })

    const d = deferred<EquivalenceGroupSwapResponse>()
    vi.mocked(equivalenceApi.swap).mockReturnValueOnce(d.promise)

    act(() => {
      result.current.swapMutation.mutate([{ column_id_a: 7001, column_id_b: 7002 }])
    })

    // Wait long enough for onMutate to settle. Then assert membership unchanged.
    await waitFor(() => expect(result.current.swapMutation.isPending).toBe(true))
    const domains = qc.getQueryData<AnalysisDomainListResponse>(['analysis-domains', 1])
    const d_domain = domains?.domains.find((d) => d.id === 803)
    expect(d_domain?.members.map((m) => m.member_id).sort()).toEqual([7001, 7002])

    d.resolve({ updated_groups: [], recomputed_metric_ids: [] })
    await waitFor(() => expect(result.current.swapMutation.isSuccess).toBe(true))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. reorderDomainsMutation
// ═══════════════════════════════════════════════════════════════════════════════

describe('reorderDomainsMutation', () => {
  function seedDomains(qc: QueryClient, ids: number[]) {
    const list: AnalysisDomainListResponse = {
      domains: ids.map((id) => buildDomain(id, `D${id}`)),
      total: ids.length,
    } as AnalysisDomainListResponse
    qc.setQueryData(['analysis-domains', 1], list)
  }

  it('3.1 optimistic reorder applies new domain order mid-flight', async () => {
    const { result, qc } = setupHook()
    seedDomains(qc, [1, 2, 3])
    const d = deferred<unknown>()
    vi.mocked(domainsApi.reorder).mockReturnValueOnce(d.promise as Promise<unknown>)

    act(() => {
      result.current.reorderDomainsMutation.mutate({ domainIds: [3, 1, 2] })
    })

    await waitFor(() => {
      const data = qc.getQueryData<AnalysisDomainListResponse>(['analysis-domains', 1])
      expect(data?.domains.map((d) => d.id)).toEqual([3, 1, 2])
    })

    d.resolve({})
    await waitFor(() =>
      expect(result.current.reorderDomainsMutation.isSuccess).toBe(true),
    )
  })

  it('3.2 onError rolls back to previous order + error toast', async () => {
    const { result, qc } = setupHook()
    seedDomains(qc, [1, 2, 3])
    vi.mocked(domainsApi.reorder).mockRejectedValueOnce(new Error('fail'))

    act(() => {
      result.current.reorderDomainsMutation.mutate({ domainIds: [3, 1, 2] })
    })
    await waitFor(() =>
      expect(result.current.reorderDomainsMutation.isError).toBe(true),
    )

    const after = qc.getQueryData<AnalysisDomainListResponse>(['analysis-domains', 1])
    expect(after?.domains.map((d) => d.id)).toEqual([1, 2, 3])
    expect(toast.error).toHaveBeenCalledWith('Could not reorder variable groups.')
  })

  it('3.3 missing IDs filtered out of optimistic order', async () => {
    const { result, qc } = setupHook()
    seedDomains(qc, [1, 2, 3])
    const d = deferred<unknown>()
    vi.mocked(domainsApi.reorder).mockReturnValueOnce(d.promise as Promise<unknown>)

    act(() => {
      // 999 is not in the cache — should be filtered.
      result.current.reorderDomainsMutation.mutate({ domainIds: [3, 999, 1] })
    })

    await waitFor(() => {
      const data = qc.getQueryData<AnalysisDomainListResponse>(['analysis-domains', 1])
      expect(data?.domains.map((d) => d.id)).toEqual([3, 1])
    })

    d.resolve({})
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 4. bulkAssignMutation
// ═══════════════════════════════════════════════════════════════════════════════

describe('bulkAssignMutation', () => {
  const cols = [
    buildColumn({ id: 9001, column_text: 'Item one' }),
    buildColumn({ id: 9002, column_text: 'Item two' }),
    buildColumn({ id: 9003, column_text: 'Item three' }),
  ]
  const targetDomainId = 42
  const targetDomainName = 'Wellbeing'

  it('4.1 all succeed: success toast + Undo action label', async () => {
    const { result } = setupHook()
    vi.mocked(equivalenceApi.create)
      .mockResolvedValueOnce({ id: 501 } as never)
      .mockResolvedValueOnce({ id: 502 } as never)
      .mockResolvedValueOnce({ id: 503 } as never)
    vi.mocked(domainsApi.addMembers).mockResolvedValue({} as never)

    act(() => {
      result.current.bulkAssignMutation.mutate({
        domainId: targetDomainId,
        domainName: targetDomainName,
        columnIds: cols.map((c) => c.id),
        allColumns: cols,
      })
    })
    await waitFor(() =>
      expect(result.current.bulkAssignMutation.isSuccess).toBe(true),
    )

    const successCalls = vi.mocked(toast.success).mock.calls
    const matched = successCalls.find(([title]) =>
      String(title).includes('3 added to "Wellbeing"'),
    )
    expect(matched).toBeDefined()
    const opts = matched![1] as { action?: { label?: string }; id?: string }
    expect(opts.action?.label).toBe('Undo')
    expect(opts.id).toBe('crosswalk-bulk-assign')
  })

  it.each([
    ['all-fail', 3, 0],
    ['partial', 1, 2],
  ] as const)(
    '4.2 [%s] reports correct succeeded/failed counts',
    async (_label, failingCount, succeedingCount) => {
      const { result } = setupHook()
      // First call always fails; subsequent pass/fail based on counts.
      const createMock = vi.mocked(equivalenceApi.create)
      const addMembersMock = vi.mocked(domainsApi.addMembers)
      createMock.mockReset()
      addMembersMock.mockReset()
      // For each column: either reject the create OR succeed both.
      // Order of allSettled calls preserves index ⇒ deterministic.
      const numCols = cols.length
      const totalFailing = failingCount
      for (let i = 0; i < numCols; i++) {
        if (i < totalFailing) {
          createMock.mockRejectedValueOnce(new Error(`create-fail-${i}`))
        } else {
          createMock.mockResolvedValueOnce({ id: 600 + i } as never)
          addMembersMock.mockResolvedValueOnce({} as never)
        }
      }

      act(() => {
        result.current.bulkAssignMutation.mutate({
          domainId: targetDomainId,
          domainName: targetDomainName,
          columnIds: cols.map((c) => c.id),
          allColumns: cols,
        })
      })
      await waitFor(() =>
        expect(result.current.bulkAssignMutation.isSuccess).toBe(true),
      )

      const errorCalls = vi.mocked(toast.error).mock.calls
      expect(errorCalls.length).toBeGreaterThanOrEqual(1)
      if (succeedingCount === 0) {
        // all-fail: no Undo
        const [, opts] = errorCalls[0] as [unknown, { action?: unknown }]
        expect(opts.action).toBeUndefined()
      } else {
        // partial: Undo partial action present
        const partial = errorCalls.find(
          ([, opts]) =>
            (opts as { action?: { label?: string } })?.action?.label === 'Undo partial',
        )
        expect(partial).toBeDefined()
      }
    },
  )

  it('4.3 undo invokes equivalenceApi.delete once per succeeded.groupId entry', async () => {
    const { result } = setupHook()
    vi.mocked(equivalenceApi.create)
      .mockResolvedValueOnce({ id: 701 } as never)
      .mockResolvedValueOnce({ id: 702 } as never)
      .mockResolvedValueOnce({ id: 703 } as never)
    vi.mocked(domainsApi.addMembers).mockResolvedValue({} as never)
    vi.mocked(equivalenceApi.delete).mockResolvedValue({} as never)

    act(() => {
      result.current.bulkAssignMutation.mutate({
        domainId: targetDomainId,
        domainName: targetDomainName,
        columnIds: cols.map((c) => c.id),
        allColumns: cols,
      })
    })
    await waitFor(() =>
      expect(result.current.bulkAssignMutation.isSuccess).toBe(true),
    )

    const successCalls = vi.mocked(toast.success).mock.calls
    const successCall = successCalls.find(([title]) =>
      String(title).includes('3 added to "Wellbeing"'),
    )
    const action = (successCall![1] as unknown as { action: { onClick: () => Promise<void> } }).action

    await act(async () => {
      await action.onClick()
    })

    expect(equivalenceApi.delete).toHaveBeenCalledTimes(3)
    expect(equivalenceApi.delete).toHaveBeenCalledWith(1, 701)
    expect(equivalenceApi.delete).toHaveBeenCalledWith(1, 702)
    expect(equivalenceApi.delete).toHaveBeenCalledWith(1, 703)
    // Final "Undone" toast follows.
    expect(
      vi.mocked(toast.success).mock.calls.find(([title]) => title === 'Undone'),
    ).toBeDefined()
  })

  it('4.4 #335: undo deletes orphan EGs when domainsApi.addMembers fails after equivalenceApi.create succeeded', async () => {
    // All 3 columns: equivalenceApi.create succeeds, domainsApi.addMembers
    // rejects → all-fail branch with 3 leaked EGs that the partial-groupId
    // capture path now surfaces for cleanup via the conditional Undo action.
    const { result } = setupHook()
    vi.mocked(equivalenceApi.create)
      .mockResolvedValueOnce({ id: 801 } as never)
      .mockResolvedValueOnce({ id: 802 } as never)
      .mockResolvedValueOnce({ id: 803 } as never)
    vi.mocked(domainsApi.addMembers).mockRejectedValue(new Error('addMembers failed'))
    vi.mocked(equivalenceApi.delete).mockResolvedValue({} as never)

    act(() => {
      result.current.bulkAssignMutation.mutate({
        domainId: targetDomainId,
        domainName: targetDomainName,
        columnIds: cols.map((c) => c.id),
        allColumns: cols,
      })
    })
    await waitFor(() =>
      expect(result.current.bulkAssignMutation.isSuccess).toBe(true),
    )

    // All-fail branch fires the error toast WITH a conditional Undo action
    // because there are 3 orphan groupIds to clean up.
    const errorCall = vi
      .mocked(toast.error)
      .mock.calls.find(([title]) =>
        String(title).includes('Could not add 3 columns to "Wellbeing"'),
      )
    expect(errorCall).toBeDefined()
    const opts = errorCall![1] as unknown as {
      action: { label: string; onClick: () => Promise<void> }
    }
    expect(opts.action.label).toBe('Undo')

    // Undo deletes all 3 orphan EGs (the partial-success groupIds 801, 802, 803).
    await act(async () => {
      await opts.action.onClick()
    })

    expect(equivalenceApi.delete).toHaveBeenCalledTimes(3)
    expect(equivalenceApi.delete).toHaveBeenCalledWith(1, 801)
    expect(equivalenceApi.delete).toHaveBeenCalledWith(1, 802)
    expect(equivalenceApi.delete).toHaveBeenCalledWith(1, 803)
  })

  it('4.5 #335: onSettled invalidates ["metrics", 1] (matches addMembers fanout)', async () => {
    const { result, invalidateSpy } = setupHook()
    vi.mocked(equivalenceApi.create).mockResolvedValueOnce({ id: 901 } as never)
    vi.mocked(domainsApi.addMembers).mockResolvedValueOnce({} as never)

    act(() => {
      result.current.bulkAssignMutation.mutate({
        domainId: targetDomainId,
        domainName: targetDomainName,
        columnIds: [cols[0].id],
        allColumns: cols,
      })
    })
    await waitFor(() =>
      expect(result.current.bulkAssignMutation.isSuccess).toBe(true),
    )

    expect(wasInvalidatedWith(invalidateSpy, ['metrics', 1])).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5. moveMembersMutation (added to guard the 684f6cc same-domain regression)
// ═══════════════════════════════════════════════════════════════════════════════

describe('moveMembersMutation', () => {
  it('5.1 success: onMoveSnapshot fires with dissolvedCount and target label', async () => {
    const { result, qc, callbacks } = setupHook()
    qc.setQueryData(['analysis-domains', 1], {
      domains: [buildDomain(11, 'Engagement')],
      total: 1,
    })
    vi.mocked(crosswalkApi.moveMembers).mockResolvedValueOnce({
      source_domain: null,
      target_domain: buildDomain(11, 'Engagement'),
      dissolved_eg_ids: [201],
      recomputed_metric_ids: [],
    } as MoveMembersResponse)

    act(() => {
      result.current.moveMembersMutation.mutate({
        column_ids: [9001],
        source_domain_id: null,
        target_domain_id: 11,
        target_mode: 'existing_eg',
        target_eg_id: 300,
      })
    })
    await waitFor(() =>
      expect(result.current.moveMembersMutation.isSuccess).toBe(true),
    )

    expect(callbacks.onMoveSnapshot).toHaveBeenCalledTimes(1)
    const snap = callbacks.onMoveSnapshot.mock.calls[0][0] as { dissolvedCount: number; columnIds: number[]; targetLabel: string | null }
    expect(snap.dissolvedCount).toBe(1)
    expect(snap.columnIds).toEqual([9001])
    expect(snap.targetLabel).toBe('Engagement')
  })

  it('5.2 onSettled invalidates metrics (invalidateWithMetrics — consistent with #335 fix across the hook)', async () => {
    const { result, invalidateSpy } = setupHook()
    vi.mocked(crosswalkApi.moveMembers).mockResolvedValueOnce({
      source_domain: null,
      target_domain: buildDomain(11, 'D'),
      dissolved_eg_ids: [],
      recomputed_metric_ids: [],
    })

    act(() => {
      result.current.moveMembersMutation.mutate({
        column_ids: [9001],
        source_domain_id: null,
        target_domain_id: 11,
        target_mode: 'strip',
      })
    })
    await waitFor(() =>
      expect(result.current.moveMembersMutation.isSuccess).toBe(true),
    )

    expect(wasInvalidatedWith(invalidateSpy, ['metrics', 1])).toBe(true)
  })

  // ── #342 Undo behavior ─────────────────────────────────────────────────

  it('5.3 single-source: inversePlan restores columns to their pre-move EG/domain', async () => {
    const { result, qc, callbacks } = setupHook()
    // Pre-mutation: col 9001 lives in EG 200 (in domain 10).
    qc.setQueryData(['project-columns', 1], {
      columns: [
        buildColumn({
          id: 9001,
          equivalence_group_id: 200,
          equivalence_group_label: 'Wave1 Q3',
        }),
      ],
      total: 1,
    })
    qc.setQueryData(['analysis-domains', 1], {
      domains: [buildDomain(10, 'Source'), buildDomain(11, 'Target')],
      total: 2,
    })
    vi.mocked(crosswalkApi.moveMembers).mockResolvedValueOnce({
      source_domain: buildDomain(10, 'Source'),
      target_domain: buildDomain(11, 'Target'),
      dissolved_eg_ids: [],
      recomputed_metric_ids: [],
    })

    act(() => {
      result.current.moveMembersMutation.mutate({
        column_ids: [9001],
        source_domain_id: 10,
        target_domain_id: 11,
        target_mode: 'existing_eg',
        target_eg_id: 300,
      })
    })
    await waitFor(() => expect(result.current.moveMembersMutation.isSuccess).toBe(true))

    expect(callbacks.onMoveSnapshot).toHaveBeenCalledTimes(1)
    const snap = callbacks.onMoveSnapshot.mock.calls[0][0] as { inversePlan: { source_domain_id: number | null; target_domain_id: number | null; target_mode: string; target_eg_id?: number | null } | null }
    expect(snap.inversePlan).not.toBeNull()
    // Inverse swaps source/target and lands the column back in its pre-EG.
    expect(snap.inversePlan!.source_domain_id).toBe(11)
    expect(snap.inversePlan!.target_domain_id).toBe(10)
    expect(snap.inversePlan!.target_mode).toBe('existing_eg')
    expect(snap.inversePlan!.target_eg_id).toBe(200)
  })

  it('5.4 multi-source (mixed prev_eg_id across columns): inversePlan is null', async () => {
    const { result, qc, callbacks } = setupHook()
    // Two cols from DIFFERENT source EGs land on the same target.
    qc.setQueryData(['project-columns', 1], {
      columns: [
        buildColumn({ id: 9001, equivalence_group_id: 200, equivalence_group_label: 'A' }),
        buildColumn({ id: 9002, equivalence_group_id: 201, equivalence_group_label: 'B' }),
      ],
      total: 2,
    })
    qc.setQueryData(['analysis-domains', 1], {
      domains: [buildDomain(10, 'Source'), buildDomain(11, 'Target')],
      total: 2,
    })
    vi.mocked(crosswalkApi.moveMembers).mockResolvedValueOnce({
      source_domain: null,
      target_domain: buildDomain(11, 'Target'),
      dissolved_eg_ids: [],
      recomputed_metric_ids: [],
    })

    act(() => {
      result.current.moveMembersMutation.mutate({
        column_ids: [9001, 9002],
        source_domain_id: 10,
        target_domain_id: 11,
        target_mode: 'existing_eg',
        target_eg_id: 300,
      })
    })
    await waitFor(() => expect(result.current.moveMembersMutation.isSuccess).toBe(true))

    const snap = callbacks.onMoveSnapshot.mock.calls[0][0] as { inversePlan: unknown }
    expect(snap.inversePlan).toBeNull()
  })

  it('5.5 dissolved source EG: inversePlan switches existing_eg → new_eg with captured label', async () => {
    const { result, qc, callbacks } = setupHook()
    qc.setQueryData(['project-columns', 1], {
      columns: [
        buildColumn({
          id: 9001,
          equivalence_group_id: 200,
          equivalence_group_label: 'Original Wave1',
        }),
      ],
      total: 1,
    })
    qc.setQueryData(['analysis-domains', 1], {
      domains: [buildDomain(10, 'Source'), buildDomain(11, 'Target')],
      total: 2,
    })
    // Backend response says EG 200 was dissolved by this move.
    vi.mocked(crosswalkApi.moveMembers).mockResolvedValueOnce({
      source_domain: null,
      target_domain: buildDomain(11, 'Target'),
      dissolved_eg_ids: [200],
      recomputed_metric_ids: [],
    })

    act(() => {
      result.current.moveMembersMutation.mutate({
        column_ids: [9001],
        source_domain_id: 10,
        target_domain_id: 11,
        target_mode: 'existing_eg',
        target_eg_id: 300,
      })
    })
    await waitFor(() => expect(result.current.moveMembersMutation.isSuccess).toBe(true))

    const snap = callbacks.onMoveSnapshot.mock.calls[0][0] as { inversePlan: { target_mode: string; target_eg_id?: number | null; target_eg_label?: string | null } | null }
    expect(snap.inversePlan).not.toBeNull()
    // Source EG was dissolved → undo must recreate it via new_eg with the label.
    expect(snap.inversePlan!.target_mode).toBe('new_eg')
    expect(snap.inversePlan!.target_eg_id).toBeUndefined()
    expect(snap.inversePlan!.target_eg_label).toBe('Original Wave1')
  })

  it('5.6 onError rollback restores both project-columns and analysis-domains snapshots', async () => {
    const { result, qc } = setupHook()
    const seedColumns = { columns: [buildColumn({ id: 9001 })], total: 1 }
    const seedDomains = { domains: [buildDomain(11, 'D')], total: 1 }
    qc.setQueryData(['project-columns', 1], seedColumns)
    qc.setQueryData(['analysis-domains', 1], seedDomains)

    vi.mocked(crosswalkApi.moveMembers).mockRejectedValueOnce(new Error('boom'))

    act(() => {
      result.current.moveMembersMutation.mutate({
        column_ids: [9001],
        source_domain_id: null,
        target_domain_id: 11,
        target_mode: 'strip',
      })
    })
    await waitFor(() => expect(result.current.moveMembersMutation.isError).toBe(true))

    // Snapshots restored — even though we don't optimistically patch today,
    // the rollback path must keep cache consistent for future optimistic
    // additions.
    expect(qc.getQueryData(['project-columns', 1])).toEqual(seedColumns)
    expect(qc.getQueryData(['analysis-domains', 1])).toEqual(seedDomains)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5b. addMembersMutation / removeMembersMutation (#335 metric invalidation)
// ═══════════════════════════════════════════════════════════════════════════════

describe('addMembersMutation + removeMembersMutation', () => {
  it('5b.1 #335: addMembersMutation onSettled invalidates ["metrics", 1]', async () => {
    const { result, invalidateSpy } = setupHook()
    vi.mocked(domainsApi.addMembers).mockResolvedValueOnce(
      buildDomain(20, 'D'),
    )

    act(() => {
      result.current.addMembersMutation.mutate({
        domainId: 20,
        members: [{ member_type: 'column', member_id: 5001 }],
      })
    })
    await waitFor(() =>
      expect(result.current.addMembersMutation.isSuccess).toBe(true),
    )

    expect(wasInvalidatedWith(invalidateSpy, ['metrics', 1])).toBe(true)
  })

  it('5b.2 #335: removeMembersMutation onSettled invalidates ["metrics", 1]', async () => {
    const { result, invalidateSpy } = setupHook()
    vi.mocked(domainsApi.removeMembers).mockResolvedValueOnce(
      buildDomain(20, 'D'),
    )

    act(() => {
      result.current.removeMembersMutation.mutate({
        domainId: 20,
        members: [{ member_type: 'column', member_id: 5001 }],
      })
    })
    await waitFor(() =>
      expect(result.current.removeMembersMutation.isSuccess).toBe(true),
    )

    expect(wasInvalidatedWith(invalidateSpy, ['metrics', 1])).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 6. createDomainMutation + createScoreMetricMutation chain
// ═══════════════════════════════════════════════════════════════════════════════

describe('createDomainMutation + createScoreMetricMutation chain', () => {
  function buildScoreMetricResponse(domainId: number): CreateScoreMetricResponse {
    return {
      metric: {
        id: 12345,
        name: 'Score',
        metric_type: 'domain_aggregate',
        input_source_type: 'dataset_domain',
        input_source_id: domainId,
        grouping_column_id: null,
        grouping_column_id_2: null,
        stale: false,
        origin: 'human',
        origin_context: 'crosswalk_auto',
      },
      computed: true,
    }
  }

  it('6.1 createDomain success → chain fires createScoreMetric', async () => {
    const { result } = setupHook()
    const domain = buildDomain(77, 'Resilience')
    vi.mocked(domainsApi.create).mockResolvedValueOnce(domain)
    vi.mocked(domainsApi.createScoreMetric).mockResolvedValueOnce(
      buildScoreMetricResponse(77),
    )

    act(() => {
      result.current.createDomainMutation.mutate({ name: 'Resilience' })
    })

    await waitFor(() =>
      expect(result.current.createDomainMutation.isSuccess).toBe(true),
    )
    // Chain fires after createDomain success; await its settle.
    await waitFor(() => {
      expect(domainsApi.createScoreMetric).toHaveBeenCalledWith(1, 77)
    })

    expect(toast.success).toHaveBeenCalledWith(
      'Created "Resilience"',
      expect.objectContaining({ id: 'crosswalk-create-domain' }),
    )
  })

  it('6.2 createDomain error → no chain, structured error toast', async () => {
    const { result } = setupHook()
    const err = makeApiError({
      error: 'cross_dataset_unpaired',
      message: 'Cross-dataset members must be paired',
      unpaired_columns: [1, 2],
    })
    vi.mocked(domainsApi.create).mockRejectedValueOnce(err)

    act(() => {
      result.current.createDomainMutation.mutate({ name: 'Bad' })
    })
    await waitFor(() =>
      expect(result.current.createDomainMutation.isError).toBe(true),
    )

    expect(domainsApi.createScoreMetric).not.toHaveBeenCalled()
    // toastEquivalenceError dispatches the cross_dataset_unpaired branch.
    const matched = vi
      .mocked(toast.error)
      .mock.calls.find(([title]) => String(title).includes('paired'))
    expect(matched).toBeDefined()
  })

  it('6.3 chained createScoreMetric success patches metrics cache + onScoreMetricRecovered', async () => {
    // No vi.useFakeTimers here — TanStack Query's chained-mutation lifecycle
    // relies on microtasks that don't drain cleanly under fake timers. The
    // patched metric's `created_at` / `updated_at` are asserted via
    // `expect.any(String)` so deterministic time isn't needed.
    const { result, qc, callbacks } = setupHook()
    // Seed empty metrics cache so the onSuccess patch path runs.
    qc.setQueryData(['metrics', 1], { metrics: [], total: 0 } satisfies MetricListResponse)

    const domain = buildDomain(77, 'Resilience')
    vi.mocked(domainsApi.create).mockResolvedValueOnce(domain)
    vi.mocked(domainsApi.createScoreMetric).mockResolvedValueOnce(
      buildScoreMetricResponse(77),
    )

    act(() => {
      result.current.createDomainMutation.mutate({ name: 'Resilience' })
    })

    await waitFor(() =>
      expect(result.current.createScoreMetricMutation.isSuccess).toBe(true),
    )

    const metrics = qc.getQueryData<MetricListResponse>(['metrics', 1])
    expect(metrics?.total).toBe(1)
    expect(metrics?.metrics[0]).toMatchObject<Partial<MetricDefinitionSummaryResponse>>({
      id: 12345,
      project_id: 1,
      name: 'Score',
      metric_type: 'domain_aggregate',
      input_source_type: 'dataset_domain',
      input_source_id: 77,
      origin: 'human',
      origin_context: 'crosswalk_auto',
      stale: false,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    })
    expect(callbacks.onScoreMetricRecovered).toHaveBeenCalledWith(77)
  })

  it('6.4 chained createScoreMetric success when metrics cache empty: silent skip, no error', async () => {
    const { result, qc, callbacks } = setupHook()
    // No setQueryData for ['metrics', 1] — cache is undefined.
    expect(qc.getQueryData(['metrics', 1])).toBeUndefined()

    const domain = buildDomain(77, 'Resilience')
    vi.mocked(domainsApi.create).mockResolvedValueOnce(domain)
    vi.mocked(domainsApi.createScoreMetric).mockResolvedValueOnce(
      buildScoreMetricResponse(77),
    )

    act(() => {
      result.current.createDomainMutation.mutate({ name: 'Resilience' })
    })

    await waitFor(() =>
      expect(result.current.createScoreMetricMutation.isSuccess).toBe(true),
    )

    // Cache stays undefined (patch silently skipped) but recovered callback still fires.
    expect(qc.getQueryData(['metrics', 1])).toBeUndefined()
    expect(callbacks.onScoreMetricRecovered).toHaveBeenCalledWith(77)
  })

  it.each([
    [
      'cross_dataset_unpaired',
      makeApiError({
        error: 'cross_dataset_unpaired',
        message: 'Pairing required',
        unpaired_columns: [1, 2],
      }),
      /Pairing required/,
      'Retry',
    ],
    [
      'generic',
      new Error('compute fail'),
      /could not be computed/i,
      'Create scale score manually',
    ],
  ] as const)(
    '6.5 [%s] chained createScoreMetric error → onScoreMetricFailed + degraded toast with action',
    async (_label, error, titlePattern, expectedActionLabel) => {
      const { result, callbacks } = setupHook()
      const domain = buildDomain(77, 'Resilience')
      vi.mocked(domainsApi.create).mockResolvedValueOnce(domain)
      vi.mocked(domainsApi.createScoreMetric).mockRejectedValueOnce(error)

      act(() => {
        result.current.createDomainMutation.mutate({ name: 'Resilience' })
      })

      await waitFor(() =>
        expect(result.current.createScoreMetricMutation.isError).toBe(true),
      )

      expect(callbacks.onScoreMetricFailed).toHaveBeenCalledWith(77)

      const matched = vi
        .mocked(toast.error)
        .mock.calls.find(([title]) =>
          typeof title === 'string' ? titlePattern.test(title) : false,
        )
      expect(matched).toBeDefined()
      const opts = matched![1] as {
        id?: string
        action?: { label?: string; onClick?: () => void }
      }
      expect(opts.id).toBe('crosswalk-score-metric-77')
      expect(opts.action?.label).toBe(expectedActionLabel)

      // Invoking the action re-fires createScoreMetric with the same domainId.
      vi.mocked(domainsApi.createScoreMetric).mockClear()
      vi.mocked(domainsApi.createScoreMetric).mockResolvedValueOnce(
        {
          metric: {
            id: 999,
            name: 'Score',
            metric_type: 'domain_aggregate',
            input_source_type: 'dataset_domain',
            input_source_id: 77,
            grouping_column_id: null,
            grouping_column_id_2: null,
            stale: false,
            origin: 'human',
            origin_context: 'crosswalk_auto',
          },
          computed: true,
        } satisfies CreateScoreMetricResponse,
      )
      act(() => {
        opts.action!.onClick!()
      })
      await waitFor(() => {
        expect(domainsApi.createScoreMetric).toHaveBeenCalledWith(1, 77)
      })
    },
  )
})
