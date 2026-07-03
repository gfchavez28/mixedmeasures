/**
 * Track J · J2-5 — the `layerScope` URL-state slice of useQualitativeAnalysis.
 * Mirrors the existing `coderIds` plumbing: default 'human', URL param 'layer'
 * dropped at the default, round-trips through buildCurrentConfig / loadMaterial.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { MaterialResponse } from '@/lib/api'
import { useQualitativeAnalysis } from './useQualitativeAnalysis'

afterEach(cleanup)

const wrapper = (initial: string) =>
  ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  )

describe('useQualitativeAnalysis — layerScope', () => {
  it('defaults to human when there is no ?layer param', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/') })
    expect(result.current.layerScope).toBe('human')
  })

  it('reads ?layer=consensus from the URL', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/?layer=consensus') })
    expect(result.current.layerScope).toBe('consensus')
  })

  it('coerces an unknown ?layer value to human', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/?layer=bogus') })
    expect(result.current.layerScope).toBe('human')
  })

  it('setLayerScope round-trips and drops the param at the human default', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/') })
    act(() => result.current.setLayerScope('consensus'))
    expect(result.current.layerScope).toBe('consensus')
    act(() => result.current.setLayerScope('human'))
    expect(result.current.layerScope).toBe('human')
  })

  it('buildCurrentConfig carries layer_scope', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/?layer=consensus') })
    expect(result.current.buildCurrentConfig().layer_scope).toBe('consensus')
  })

  it('loadMaterial restores layer_scope=consensus into the URL state', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/') })
    act(() => result.current.loadMaterial({ id: 1, config: { layer_scope: 'consensus' } } as unknown as MaterialResponse))
    expect(result.current.layerScope).toBe('consensus')
  })
})
