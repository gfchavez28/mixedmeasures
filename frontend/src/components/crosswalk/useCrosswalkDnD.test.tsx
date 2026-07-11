/**
 * useCrosswalkDnD — handleDragEnd branch coverage.
 *
 * The hook's drop branches are pure dispatch: each branch decides which
 * mutation to call and with what payload. We test by rendering the hook
 * with mock mutations, calling `_handleDragEnd` directly with a
 * constructed DragEndEvent, then asserting which mutation was invoked.
 *
 * Why not Playwright: per the internal design notes, Playwright's
 * `dragTo` does NOT fire dnd-kit's PointerSensor reliably. Synthetic
 * dispatch via direct hook calls is the canonical pattern for these
 * branches.
 *
 * Coverage targets (the new ones from the drag-first redesign):
 *   - LATENT BUG FIX: drag-from-unassigned to existing-EG empty cell
 *     hits moveMembersMutation (existing_eg), NOT moveColumnMutation.
 *   - NEW: drag to add-row-{domainId} fires move_members(target_mode='strip').
 *   - NEW: same-bracket cell → add-row of same bracket is silent no-op.
 *   - NEW: cross-dataset bracket + foreign-dataset source on add-row
 *     pre-blocks (flashConflict, no mutation).
 *   - NEW: multi-select with mixed datasets on existing-eg pre-blocks.
 *   - NEW: multi-select with mixed types on existing-eg pre-blocks.
 *   - NEW: multi-select on promote-to-paired (empty-unlinked) pre-blocks.
 *   - NEW: panel multi-select (selectedUnassignedColumnIds) drives drag
 *     fanout into one move_members call.
 *
 * Existing branches are also covered for regression safety:
 *   - cell drag → cell drop (swap)
 *   - cell drag → empty-eg same-bracket → moveColumnMutation
 *   - cell drag → empty-eg cross-bracket → moveMembersMutation
 *   - cell drag → empty-unlinked (promote to paired)
 *   - cell drag → panel (full unassign vs sever-EG fallback)
 *   - cell drag → new-bracket-tile
 *   - bracket-sort drag → reorderDomainsMutation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  useCrosswalkDnD,
  type CrosswalkDnDHandlerRefs,
} from './useCrosswalkDnD'
import {
  makeAddRowDropId,
  makeBracketSortId,
  makeCellDragId,
  makeEmptyCellDropId,
  DRAWER_DROP_ID,
  NEW_BRACKET_TILE_DROP_ID,
} from './drop-ids'
import type { ProjectColumnInfo } from './crosswalk-types'

// Build a minimal column shape — only fields useCrosswalkDnD reads
// matter; everything else gets a sensible default.
function col(overrides: Partial<ProjectColumnInfo> & { id: number; dataset_id: number }): ProjectColumnInfo {
  return {
    id: overrides.id,
    dataset_id: overrides.dataset_id,
    dataset_name: overrides.dataset_name ?? `Dataset ${overrides.dataset_id}`,
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

function buildEvent(activeId: string, overId: string | null): DragEndEvent {
  return {
    active: {
      id: activeId,
      data: { current: undefined },
      rect: {
        current: { initial: null, translated: null },
      },
    } as unknown as DragEndEvent['active'],
    over: overId == null ? null : ({ id: overId, data: { current: undefined } } as DragEndEvent['over']),
    delta: { x: 0, y: 0 },
    collisions: null,
    activatorEvent: new Event('pointerdown'),
  }
}

interface MockMutations {
  swapMutation: { mutate: ReturnType<typeof vi.fn> }
  removeColumnFromRowMutation: { mutate: ReturnType<typeof vi.fn> }
  moveColumnMutation: { mutate: ReturnType<typeof vi.fn> }
  moveMembersMutation: { mutate: ReturnType<typeof vi.fn> }
  reorderDomainsMutation: { mutate: ReturnType<typeof vi.fn> }
}

function buildMockMutations(): MockMutations {
  return {
    swapMutation: { mutate: vi.fn() },
    removeColumnFromRowMutation: { mutate: vi.fn() },
    moveColumnMutation: { mutate: vi.fn() },
    moveMembersMutation: { mutate: vi.fn() },
    reorderDomainsMutation: { mutate: vi.fn() },
  }
}

// useCrosswalkDnD's `mutations` option is typed as `Pick<CrosswalkMutations,
// ...>` — the full TanStack-Query mutation result shape. Tests only
// exercise `.mutate`, so cast the structural mock through `unknown` to
// satisfy the strict prop type without recreating dozens of unused fields.
type DnDMutations = Parameters<typeof useCrosswalkDnD>[0]['mutations']
function asMutations(m: MockMutations): DnDMutations {
  return m as unknown as DnDMutations
}

// Suppress sonner's runtime error toast spam in test output (the toast
// import lives at module scope; we don't mock it because individual
// branches test it indirectly via flashConflict + no mutation).
beforeEach(() => {
  vi.useRealTimers()
})

describe('useCrosswalkDnD — add-row drop branch (NEW)', () => {
  it('drops a single unassigned column on add-row → moveMembers(strip, target_domain)', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 10 }), // unassigned, no domain
      col({ id: 2, dataset_id: 10, equivalence_group_id: 100 }), // domain D=50
    ]
    const domainByColumnId = new Map([[2, 50]])
    const domainByEgId = new Map([[100, 50]])
    const bracketDatasetsByDomainId = new Map([[50, new Set([10])]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        domainByColumnId,
        domainByEgId,
        bracketDatasetsByDomainId,
      }),
    )

    // Drag column 1 (unassigned) onto bracket 50's add-row target.
    result.current._handleDragEnd(
      buildEvent(makeCellDragId(1), makeAddRowDropId(50)),
    )

    expect(m.moveMembersMutation.mutate).toHaveBeenCalledTimes(1)
    const [payload] = m.moveMembersMutation.mutate.mock.calls[0]
    expect(payload).toMatchObject({
      column_ids: [1],
      source_domain_id: null,
      target_domain_id: 50,
      target_mode: 'strip',
    })
    expect(m.moveColumnMutation.mutate).not.toHaveBeenCalled()
  })

  it('same-bracket cell → its own bracket\'s add-row is a silent no-op', () => {
    const m = buildMockMutations()
    const allColumns = [col({ id: 1, dataset_id: 10, equivalence_group_id: 100 })]
    const domainByColumnId = new Map([[1, 50]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        domainByColumnId,
      }),
    )

    result.current._handleDragEnd(
      buildEvent(makeCellDragId(1), makeAddRowDropId(50)),
    )

    expect(m.moveMembersMutation.mutate).not.toHaveBeenCalled()
    expect(m.moveColumnMutation.mutate).not.toHaveBeenCalled()
  })

  it('cross-dataset bracket + foreign-dataset source pre-blocks (no mutation)', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 30 }), // unassigned, dataset D=30
    ]
    // Bracket 50 already spans datasets 10 and 20 → cross-dataset.
    const bracketDatasetsByDomainId = new Map([[50, new Set([10, 20])]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10, 20, 30],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        bracketDatasetsByDomainId,
      }),
    )

    result.current._handleDragEnd(
      buildEvent(makeCellDragId(1), makeAddRowDropId(50)),
    )

    expect(m.moveMembersMutation.mutate).not.toHaveBeenCalled()
  })

  it('cross-dataset bracket + matching-dataset source allows the drop', () => {
    const m = buildMockMutations()
    const allColumns = [col({ id: 1, dataset_id: 10 })] // matches existing dataset 10
    const bracketDatasetsByDomainId = new Map([[50, new Set([10, 20])]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10, 20],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        bracketDatasetsByDomainId,
      }),
    )

    result.current._handleDragEnd(
      buildEvent(makeCellDragId(1), makeAddRowDropId(50)),
    )

    expect(m.moveMembersMutation.mutate).toHaveBeenCalledTimes(1)
  })
})

describe('useCrosswalkDnD — empty-eg drop branch (LATENT BUG FIX)', () => {
  it('unassigned source dropped on existing-EG empty cell → moveMembers (NOT moveColumn)', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 10 }), // unassigned source
      col({ id: 2, dataset_id: 11, equivalence_group_id: 100 }), // existing EG, dataset 11
    ]
    const domainByColumnId = new Map([[2, 50]])
    const domainByEgId = new Map([[100, 50]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10, 11],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        domainByColumnId,
        domainByEgId,
      }),
    )

    // Drag unassigned column 1 (dataset 10) onto EG 100's empty cell for
    // dataset 10. The empty-eg drop ID encodes (egId=100, datasetId=10).
    result.current._handleDragEnd(
      buildEvent(
        makeCellDragId(1),
        makeEmptyCellDropId({ kind: 'eg', egId: 100, datasetId: 10 }),
      ),
    )

    // Latent bug fix: must hit moveMembers, NOT moveColumn — moveColumn
    // would orphan the column (EG set without AnalysisDomainMember row).
    expect(m.moveMembersMutation.mutate).toHaveBeenCalledTimes(1)
    expect(m.moveColumnMutation.mutate).not.toHaveBeenCalled()
    const [payload] = m.moveMembersMutation.mutate.mock.calls[0]
    expect(payload).toMatchObject({
      column_ids: [1],
      source_domain_id: null,
      target_domain_id: 50,
      target_mode: 'existing_eg',
      target_eg_id: 100,
    })
  })

  it('cross-bracket cell → existing-EG empty cell still hits moveMembers', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 10, equivalence_group_id: 200 }), // bracket 60
      col({ id: 2, dataset_id: 11, equivalence_group_id: 100 }), // bracket 50
    ]
    const domainByColumnId = new Map([
      [1, 60],
      [2, 50],
    ])
    const domainByEgId = new Map([
      [100, 50],
      [200, 60],
    ])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10, 11],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        domainByColumnId,
        domainByEgId,
      }),
    )

    result.current._handleDragEnd(
      buildEvent(
        makeCellDragId(1),
        makeEmptyCellDropId({ kind: 'eg', egId: 100, datasetId: 10 }),
      ),
    )

    expect(m.moveMembersMutation.mutate).toHaveBeenCalledTimes(1)
    expect(m.moveColumnMutation.mutate).not.toHaveBeenCalled()
  })

  it('same-bracket EG re-link still uses moveColumnMutation', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 10, equivalence_group_id: 200 }),
      col({ id: 2, dataset_id: 11, equivalence_group_id: 100 }),
    ]
    // Both EGs in the same domain → same-bracket re-link.
    const domainByColumnId = new Map([
      [1, 50],
      [2, 50],
    ])
    const domainByEgId = new Map([
      [100, 50],
      [200, 50],
    ])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10, 11],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        domainByColumnId,
        domainByEgId,
      }),
    )

    result.current._handleDragEnd(
      buildEvent(
        makeCellDragId(1),
        makeEmptyCellDropId({ kind: 'eg', egId: 100, datasetId: 10 }),
      ),
    )

    expect(m.moveColumnMutation.mutate).toHaveBeenCalledTimes(1)
    expect(m.moveMembersMutation.mutate).not.toHaveBeenCalled()
  })
})

describe('useCrosswalkDnD — multi-select pre-validation (NEW)', () => {
  it('panel multi-select fans out into one move_members call', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 10 }),
      col({ id: 2, dataset_id: 11 }),
      col({ id: 3, dataset_id: 12 }),
    ]
    const bracketDatasetsByDomainId = new Map([[50, new Set<number>()]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10, 11, 12],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        bracketDatasetsByDomainId,
        selectedUnassignedColumnIds: new Set([1, 2, 3]),
      }),
    )

    // Drag column 1 (which is in the panel selection) onto bracket 50's
    // add-row → all 3 move atomically.
    result.current._handleDragEnd(
      buildEvent(makeCellDragId(1), makeAddRowDropId(50)),
    )

    expect(m.moveMembersMutation.mutate).toHaveBeenCalledTimes(1)
    const [payload] = m.moveMembersMutation.mutate.mock.calls[0]
    expect(payload.column_ids.sort()).toEqual([1, 2, 3])
  })

  // Audit Batch C, P6 step 2 regression guard: when CrosswalkView re-renders
  // with a changed selection set, the next drag must use the post-rerender
  // value, not a stale closure capture. Locks in the optionsRef sync timing
  // (single useEffect with no dep array, runs after every commit). Prior
  // pattern (one useEffect per prop, with that prop in its dep array) gave
  // the same guarantee; this test ensures the consolidation didn't drift.
  it('hook reads latest selectedUnassignedColumnIds after re-render', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 10 }),
      col({ id: 2, dataset_id: 11 }),
      col({ id: 3, dataset_id: 12 }),
    ]
    const bracketDatasetsByDomainId = new Map([[50, new Set<number>()]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result, rerender } = renderHook(
      ({ selected }: { selected: Set<number> }) =>
        useCrosswalkDnD({
          activeDatasetIds: [10, 11, 12],
          allColumns,
          mutations: asMutations(m),
          handlerRefs,
          bracketDatasetsByDomainId,
          selectedUnassignedColumnIds: selected,
        }),
      { initialProps: { selected: new Set([1]) } },
    )

    // Re-render with an expanded selection BEFORE dispatching the drag.
    rerender({ selected: new Set([1, 2, 3]) })

    result.current._handleDragEnd(
      buildEvent(makeCellDragId(1), makeAddRowDropId(50)),
    )

    expect(m.moveMembersMutation.mutate).toHaveBeenCalledTimes(1)
    const [payload] = m.moveMembersMutation.mutate.mock.calls[0]
    expect(payload.column_ids.sort()).toEqual([1, 2, 3])
  })

  it('multi-select with 2+ same-dataset columns on existing-eg pre-blocks', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 10 }), // source
      col({ id: 2, dataset_id: 10 }), // SAME DATASET — would 409 (1:1)
    ]
    const domainByEgId = new Map([[100, 50]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        domainByEgId,
        selectedUnassignedColumnIds: new Set([1, 2]),
      }),
    )

    result.current._handleDragEnd(
      buildEvent(
        makeCellDragId(1),
        makeEmptyCellDropId({ kind: 'eg', egId: 100, datasetId: 10 }),
      ),
    )

    // Pre-blocked → no mutation fires.
    expect(m.moveMembersMutation.mutate).not.toHaveBeenCalled()
    expect(m.moveColumnMutation.mutate).not.toHaveBeenCalled()
  })

  it('multi-select with mixed types on existing-eg pre-blocks', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 10, column_type: 'ordinal' }),
      col({ id: 2, dataset_id: 11, column_type: 'nominal' }), // mixed type
    ]
    const domainByEgId = new Map([[100, 50]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10, 11],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        domainByEgId,
        selectedUnassignedColumnIds: new Set([1, 2]),
      }),
    )

    result.current._handleDragEnd(
      buildEvent(
        makeCellDragId(1),
        makeEmptyCellDropId({ kind: 'eg', egId: 100, datasetId: 10 }),
      ),
    )

    expect(m.moveMembersMutation.mutate).not.toHaveBeenCalled()
  })

  it('multi-select on promote-to-paired (empty-unlinked) pre-blocks', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 10 }),
      col({ id: 2, dataset_id: 11 }),
      col({ id: 3, dataset_id: 12 }),
      // Synthetic row anchor in dataset 11
      col({ id: 99, dataset_id: 11 }),
    ]
    const domainByColumnId = new Map([[99, 50]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10, 11, 12],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        domainByColumnId,
        selectedUnassignedColumnIds: new Set([1, 2, 3]),
      }),
    )

    // Source 1 (dataset 10) onto column 99's empty cell in dataset 10.
    result.current._handleDragEnd(
      buildEvent(
        makeCellDragId(1),
        makeEmptyCellDropId({ kind: 'unlinked', columnId: 99, datasetId: 10 }),
      ),
    )

    // Multi-select on promote-to-paired is rejected as a 2-column gesture.
    expect(m.moveMembersMutation.mutate).not.toHaveBeenCalled()
  })
})

describe('useCrosswalkDnD — existing branch regressions', () => {
  it('panel drop with sourceDomainId set → moveMembers strip', () => {
    const m = buildMockMutations()
    const allColumns = [
      col({ id: 1, dataset_id: 10, equivalence_group_id: 100 }),
    ]
    const domainByColumnId = new Map([[1, 50]])
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        domainByColumnId,
      }),
    )

    result.current._handleDragEnd(
      buildEvent(makeCellDragId(1), DRAWER_DROP_ID),
    )

    expect(m.moveMembersMutation.mutate).toHaveBeenCalledTimes(1)
    const [payload] = m.moveMembersMutation.mutate.mock.calls[0]
    expect(payload).toMatchObject({
      column_ids: [1],
      source_domain_id: 50,
      target_domain_id: null,
      target_mode: 'strip',
    })
  })

  it('panel drop with no source domain + no EG → silent no-op', () => {
    const m = buildMockMutations()
    const allColumns = [col({ id: 1, dataset_id: 10 })]
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
      }),
    )

    result.current._handleDragEnd(
      buildEvent(makeCellDragId(1), DRAWER_DROP_ID),
    )

    expect(m.moveMembersMutation.mutate).not.toHaveBeenCalled()
    expect(m.removeColumnFromRowMutation.mutate).not.toHaveBeenCalled()
  })

  it('new-bracket-tile drop calls onNewBracketDrop with column ids', () => {
    const m = buildMockMutations()
    const onNewBracketDrop = vi.fn()
    const allColumns = [col({ id: 1, dataset_id: 10 })]
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        onNewBracketDrop,
      }),
    )

    result.current._handleDragEnd(
      buildEvent(makeCellDragId(1), NEW_BRACKET_TILE_DROP_ID),
    )

    expect(onNewBracketDrop).toHaveBeenCalledWith([1])
  })

  it('bracket-sort drag → reorderDomainsMutation', () => {
    const m = buildMockMutations()
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }

    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10],
        allColumns: [],
        mutations: asMutations(m),
        handlerRefs,
        bracketIds: [50, 60, 70],
      }),
    )

    // Move 50 → after 70 (target.id = 70, so newOrder is [60, 70, 50])
    result.current._handleDragEnd(
      buildEvent(makeBracketSortId(50), makeBracketSortId(70)),
    )

    expect(m.reorderDomainsMutation.mutate).toHaveBeenCalledTimes(1)
    const [payload] = m.reorderDomainsMutation.mutate.mock.calls[0]
    expect(payload.domainIds).toEqual([60, 70, 50])
  })
})

describe('useCrosswalkDnD — flash timer race (#339)', () => {
  // Earlier identity-guard implementation (`prev === flashed`) lost when a
  // second swap/move landed within 1300ms — the first timer fired but its
  // captured Set was no longer the current state, so it no-op'd and the
  // second flash never cleared. The generation-counter fix below is verified
  // by simulating two rapid handler invocations with fake timers.

  it('single swap clears flash after 1300ms', () => {
    vi.useFakeTimers()
    try {
      const m = buildMockMutations()
      const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }
      const { result } = renderHook(() =>
        useCrosswalkDnD({
          activeDatasetIds: [10],
          allColumns: [col({ id: 1, dataset_id: 10 })],
          mutations: asMutations(m),
          handlerRefs,
        }),
      )
      act(() => {
        handlerRefs.current.onSwapSuccess?.({
          inversePayload: [{ column_id_a: 1, column_id_b: 2 }],
          timestamp: Date.now(),
        })
      })
      expect(result.current.swapFlashColumnIds.has(1)).toBe(true)
      expect(result.current.swapFlashColumnIds.has(2)).toBe(true)

      act(() => {
        vi.advanceTimersByTime(1300)
      })
      expect(result.current.swapFlashColumnIds.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('two rapid swaps within 1300ms — second flash clears cleanly (no stuck flash)', () => {
    vi.useFakeTimers()
    try {
      const m = buildMockMutations()
      const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }
      const { result } = renderHook(() =>
        useCrosswalkDnD({
          activeDatasetIds: [10],
          allColumns: [col({ id: 1, dataset_id: 10 })],
          mutations: asMutations(m),
          handlerRefs,
        }),
      )
      // First swap: flashes columns 1, 2.
      act(() => {
        handlerRefs.current.onSwapSuccess?.({
          inversePayload: [{ column_id_a: 1, column_id_b: 2 }],
          timestamp: Date.now(),
        })
      })
      // Halfway through the first timer, fire a second swap with different
      // columns. The second handler bumps the generation; the first timer's
      // captured generation no longer matches and will silently no-op when
      // it eventually fires.
      act(() => {
        vi.advanceTimersByTime(600)
      })
      act(() => {
        handlerRefs.current.onSwapSuccess?.({
          inversePayload: [{ column_id_a: 3, column_id_b: 4 }],
          timestamp: Date.now(),
        })
      })
      expect(result.current.swapFlashColumnIds.has(3)).toBe(true)
      expect(result.current.swapFlashColumnIds.has(4)).toBe(true)
      // The pre-fix bug: at t=1300 (700ms into second timer) the first timer
      // fires; its `prev === flashed1` check fails (state is flashed2 now)
      // and it no-ops. The second timer would never have a chance to clear
      // flashed2 — bug. Post-fix: first timer's generation is stale, no-op.
      act(() => {
        vi.advanceTimersByTime(700)
      })
      // Second timer is at 700ms (of its own 1300ms window). Flash should
      // still be present.
      expect(result.current.swapFlashColumnIds.size).toBe(2)
      // Advance to second timer's expiry. Second timer matches its captured
      // generation and clears the flash.
      act(() => {
        vi.advanceTimersByTime(700)
      })
      expect(result.current.swapFlashColumnIds.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('two rapid moves within 1300ms — second flash clears cleanly', () => {
    vi.useFakeTimers()
    try {
      const m = buildMockMutations()
      const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }
      const { result } = renderHook(() =>
        useCrosswalkDnD({
          activeDatasetIds: [10],
          allColumns: [col({ id: 1, dataset_id: 10 })],
          mutations: asMutations(m),
          handlerRefs,
        }),
      )
      const baseInfo = {
        targetEgId: 100,
        datasetId: 10,
        datasetName: 'Wave 1',
        columnCode: 'q1',
        sourceEgId: null,
      }
      act(() => {
        handlerRefs.current.onMoveSuccess?.({
          ...baseInfo,
          columnId: 1,
          timestamp: Date.now(),
        })
      })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      act(() => {
        handlerRefs.current.onMoveSuccess?.({
          ...baseInfo,
          columnId: 2,
          timestamp: Date.now(),
        })
      })
      expect(result.current.swapFlashColumnIds.has(2)).toBe(true)
      // Advance past the first timer (would have no-op'd with stale gen).
      act(() => {
        vi.advanceTimersByTime(700)
      })
      expect(result.current.swapFlashColumnIds.size).toBe(1)
      // Advance past the second timer.
      act(() => {
        vi.advanceTimersByTime(700)
      })
      expect(result.current.swapFlashColumnIds.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useCrosswalkDnD — identifier/skip assignment rejection (#556b)', () => {
  // An identifier column holds row identity, not a measurement: it carries no
  // value_numeric, so a group containing one either can't compute its scale
  // score (400 → "failed" Σ badge) or silently averages a NULL member. The drop
  // is refused client-side rather than 409'd server-side, so the user gets a
  // reason instead of a red badge.
  const IDENT = { id: 9, dataset_id: 10, column_type: 'identifier', column_code: 'PID' }

  function harness(m: MockMutations, extraCols: ProjectColumnInfo[] = []) {
    const allColumns = [
      col(IDENT),
      col({ id: 1, dataset_id: 10 }),                              // unassigned ordinal
      col({ id: 2, dataset_id: 11, equivalence_group_id: 100 }),   // member of domain 50
      ...extraCols,
    ]
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }
    return renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10, 11],
        allColumns,
        mutations: asMutations(m),
        handlerRefs,
        domainByColumnId: new Map([[2, 50]]),
        domainByEgId: new Map([[100, 50]]),
        bracketDatasetsByDomainId: new Map([[50, new Set([11])]]),
      }),
    )
  }

  function assertNoMutation(m: MockMutations) {
    expect(m.moveMembersMutation.mutate).not.toHaveBeenCalled()
    expect(m.moveColumnMutation.mutate).not.toHaveBeenCalled()
    expect(m.swapMutation.mutate).not.toHaveBeenCalled()
  }

  it('rejects an identifier dropped on "+ Add variable row"', () => {
    const m = buildMockMutations()
    const { result } = harness(m)
    result.current._handleDragEnd(buildEvent(makeCellDragId(9), makeAddRowDropId(50)))
    assertNoMutation(m)
  })

  it('rejects an identifier dropped on an existing EG empty cell', () => {
    const m = buildMockMutations()
    const { result } = harness(m)
    result.current._handleDragEnd(
      buildEvent(makeCellDragId(9), makeEmptyCellDropId({ kind: 'eg', egId: 100, datasetId: 10 })),
    )
    assertNoMutation(m)
  })

  it('rejects an identifier dropped on an empty-unlinked cell (promote-to-paired)', () => {
    const m = buildMockMutations()
    const { result } = harness(m)
    result.current._handleDragEnd(
      buildEvent(
        makeCellDragId(9),
        makeEmptyCellDropId({ kind: 'unlinked', columnId: 2, datasetId: 10 }),
      ),
    )
    assertNoMutation(m)
  })

  it('rejects an identifier dropped on the "+ New variable group" tile', () => {
    const m = buildMockMutations()
    const onNewBracketDrop = vi.fn()
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }
    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10],
        allColumns: [col(IDENT), col({ id: 1, dataset_id: 10 })],
        mutations: asMutations(m),
        handlerRefs,
        domainByColumnId: new Map(),
        domainByEgId: new Map(),
        bracketDatasetsByDomainId: new Map(),
        onNewBracketDrop,
      }),
    )
    result.current._handleDragEnd(
      buildEvent(makeCellDragId(9), NEW_BRACKET_TILE_DROP_ID),
    )
    // The dialog must not even OPEN pre-seeded with an ineligible column.
    expect(onNewBracketDrop).not.toHaveBeenCalled()
  })

  it('STILL ALLOWS dragging an identifier OUT to the Unassigned panel', () => {
    // The repair gesture. A guard that also blocked this would trap a
    // mis-assigned identifier inside its group forever.
    const m = buildMockMutations()
    const handlerRefs: { current: CrosswalkDnDHandlerRefs } = { current: {} }
    const { result } = renderHook(() =>
      useCrosswalkDnD({
        activeDatasetIds: [10],
        allColumns: [col({ ...IDENT, equivalence_group_id: 100 })],
        mutations: asMutations(m),
        handlerRefs,
        domainByColumnId: new Map([[9, 50]]),
        domainByEgId: new Map([[100, 50]]),
        bracketDatasetsByDomainId: new Map([[50, new Set([10])]]),
      }),
    )
    result.current._handleDragEnd(buildEvent(makeCellDragId(9), DRAWER_DROP_ID))

    expect(m.moveMembersMutation.mutate).toHaveBeenCalledTimes(1)
    const [payload] = m.moveMembersMutation.mutate.mock.calls[0]
    expect(payload).toMatchObject({ column_ids: [9], target_mode: 'strip' })
  })

  it('lets an ordinary ordinal column through the same drop unharmed', () => {
    // The exclusion must be surgical: if this fails, the guard is over-broad.
    const m = buildMockMutations()
    const { result } = harness(m)
    result.current._handleDragEnd(buildEvent(makeCellDragId(1), makeAddRowDropId(50)))
    expect(m.moveMembersMutation.mutate).toHaveBeenCalledTimes(1)
  })
})
