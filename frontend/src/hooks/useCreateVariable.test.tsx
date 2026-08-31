/**
 * `useCreateVariable` — the shared create-a-variable chokepoint (#830f).
 *
 * ## What is actually being pinned here
 *
 * 🔴 **A live defect the extraction surfaced.** Both create mutations
 * hand-listed `['dataset-data']` + `['dataset-columns']` while they were
 * single-call-site code in `DatasetView`. A new variable also has to appear in
 * `['project-columns']` (the crosswalk's Unassigned panel) and
 * `['analysis-columns']` (the analysis picker) — and the global `staleTime` is
 * **60 s**, with `ColumnPicker` setting its own 60 s on top. So a researcher who
 * created a variable and walked to either screen inside a minute was served a
 * cached list without it.
 *
 * This is the exact hazard `invalidateColumnRemoved`'s docstring records from
 * #812: *a copy does not only DRIFT, it propagates the original's defect
 * verbatim (#733)*. Copying the mutation to a second surface would have shipped
 * the bug twice; extracting it is what made anyone look.
 *
 * The assertions below are therefore about the KEY SET, not about the mutation
 * firing — a test that only checked "the API was called" passes just as well
 * against the hand-list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useCreateVariable } from './useCreateVariable'
import { datasetsApi } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  datasetsApi: { createManualColumn: vi.fn(), createComputedColumn: vi.fn() },
  extractApiError: (_e: unknown, fallback: string) => fallback,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

const NEW_COLUMN = { id: 42, column_text: 'Age band' } as Awaited<
  ReturnType<typeof datasetsApi.createManualColumn>
>

/** The keys a NEW variable must reach, and the two the hand-list missed. */
const REQUIRED_KEYS = [
  ['dataset-data', 1, 2],
  ['dataset-columns', 1, 2],
  // 🔴 The two the hand-listed set never invalidated.
  ['project-columns', 1],
  ['analysis-columns', 1],
]

describe('useCreateVariable', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['manual', 'computed'] as const)(
    'a created %s variable invalidates every list that must show it',
    async (kind) => {
      const qc = makeClient()
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
      vi.mocked(datasetsApi.createManualColumn).mockResolvedValue(NEW_COLUMN)
      vi.mocked(datasetsApi.createComputedColumn).mockResolvedValue(NEW_COLUMN)

      const { result } = renderHook(() => useCreateVariable(1, 2), {
        wrapper: makeWrapper(qc),
      })
      const props = kind === 'manual'
        ? result.current.manualDialogProps
        : result.current.computedDialogProps
      props.onSubmit({ column_text: 'Age band' })

      await waitFor(() => expect(invalidateSpy).toHaveBeenCalled())

      const invalidated = invalidateSpy.mock.calls.map(c => JSON.stringify(c[0]?.queryKey))
      for (const key of REQUIRED_KEYS) {
        expect(invalidated, `a new variable must invalidate ${JSON.stringify(key)}`)
          .toContain(JSON.stringify(key))
      }
    },
  )

  it('hands the new column id to onCreated so a surface can select it', async () => {
    const qc = makeClient()
    vi.mocked(datasetsApi.createManualColumn).mockResolvedValue(NEW_COLUMN)
    const onCreated = vi.fn()

    const { result } = renderHook(() => useCreateVariable(1, 2, onCreated), {
      wrapper: makeWrapper(qc),
    })
    result.current.manualDialogProps.onSubmit({ column_text: 'Age band' })

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(42))
  })

  it('opens exactly one kind at a time', () => {
    // The three dialogs share one `openKind`, so they cannot stack. A boolean
    // per dialog could, and two open dialogs over one act is a state nobody
    // designed.
    const qc = makeClient()
    const { result } = renderHook(() => useCreateVariable(1, 2), {
      wrapper: makeWrapper(qc),
    })

    act(() => result.current.open('computed'))
    expect(result.current.openKind).toBe('computed')

    act(() => result.current.open('recoded'))
    expect(result.current.openKind).toBe('recoded')
    expect(result.current.manualDialogProps.open).toBe(false)
    expect(result.current.computedDialogProps.open).toBe(false)
  })

  it('a failed create keeps its dialog open and reports into it', async () => {
    // ⚠️ The error belongs IN the form, not in a toast that outlives it: the
    // researcher's typed values are still on screen and the fix is usually one
    // field. Closing on failure would discard them.
    const qc = makeClient()
    vi.mocked(datasetsApi.createManualColumn).mockRejectedValue(new Error('nope'))

    const { result } = renderHook(() => useCreateVariable(1, 2), {
      wrapper: makeWrapper(qc),
    })
    act(() => result.current.open('manual'))
    result.current.manualDialogProps.onSubmit({ column_text: 'Age band' })

    await waitFor(() =>
      expect(result.current.manualDialogProps.submitError).toBe('Failed to create variable'))
    expect(result.current.manualDialogProps.open).toBe(true)
  })
})
