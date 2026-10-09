import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { useAnalysisUrlState } from './useAnalysisUrlState'

/**
 * #1146 — Quantitative's URL state is composable (`url-state.md`): two writes made in
 * one tick both land. `AnalysisView.url-compose.test.tsx` drives the page, where the
 * invalid-params effect's own fix (write only when invalid) would ALSO make its three
 * cases pass — so this pins the hook half on its own, the way
 * `useQualitativeAnalysis.test.tsx` §#1129 pins its sibling.
 */

afterEach(cleanup)

const wrapper = (initial: string) => ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
)

describe('useAnalysisUrlState — two writes in one tick', () => {
  it('both land through setUrlParam', () => {
    const { result } = renderHook(() => useAnalysisUrlState(), { wrapper: wrapper('/?columns=5') })
    act(() => {
      result.current.setUrlParam('groupBy', '7')
      result.current.setUrlParam('display', 'count')
    })
    expect(result.current.groupingColumnId).toBe(7)
    expect(result.current.display).toBe('count')
  })

  it('both land through the raw setter the sidebar is handed', () => {
    const { result } = renderHook(() => useAnalysisUrlState(), { wrapper: wrapper('/?columns=5&groupBy=7&groupMode=dataset') })
    act(() => {
      result.current.setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete('groupBy'); return n }, { replace: true })
      result.current.setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete('groupMode'); return n }, { replace: true })
    })
    expect(result.current.groupingColumnId).toBeNull()
    expect(result.current.groupingMode).toBe('column')
    expect(result.current.columnsRaw).toBe('5')
  })
})
