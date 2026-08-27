/**
 * Track J · J2-5 — the `layerScope` URL-state slice of useQualitativeAnalysis.
 * Mirrors the existing `coderIds` plumbing: default 'human', URL param 'layer'
 * dropped at the default, round-trips through buildCurrentConfig / loadMaterial.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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
    expect(result.current.buildCurrentConfig([]).layer_scope).toBe('consensus')
  })

  it('loadMaterial restores layer_scope=consensus into the URL state', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/') })
    act(() => result.current.loadMaterial({ id: 1, config: { layer_scope: 'consensus' } } as unknown as MaterialResponse))
    expect(result.current.layerScope).toBe('consensus')
  })
})

/**
 * #683 — the coder scope a material persists.
 *
 * `buildCurrentConfig` takes the EFFECTIVE (blind-forced) scope as a REQUIRED
 * argument. The requirement is the fix: the hook cannot see blind mode, so an
 * optional override would leave the old `[]` = "no filter" behaviour one
 * forgotten call site away — and that is precisely how a material saved while
 * blind came to replay more than the researcher saw.
 */
describe('useQualitativeAnalysis — #683 effective coder scope', () => {
  it('persists the scope it is GIVEN, not the raw ?coders filter', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/?coders=') })
    // Raw filter empty (what a blind view shows), effective scope = just me.
    expect(result.current.buildCurrentConfig([7]).coder_ids).toEqual([7])
  })

  it('an empty effective scope still means "no filter"', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/') })
    expect(result.current.buildCurrentConfig([]).coder_ids).toEqual([])
  })

  it('does not silently fall back to the raw filter', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/?coders=3,4') })
    // The raw filter is 3,4; the effective scope passed in wins.
    expect(result.current.buildCurrentConfig([9]).coder_ids).toEqual([9])
  })
})

/**
 * #685 — the Timeline's table breakdown is a per-CHART property.
 *
 * Mirrors the layerScope slice above: default 'code', URL param 'timedMode'
 * dropped at the default, round-trips through buildCurrentConfig / loadMaterial.
 */
describe('useQualitativeAnalysis — #685 timelineTableMode', () => {
  it('defaults to code when there is no ?timedMode param', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/') })
    expect(result.current.timelineTableMode).toBe('code')
  })

  it('reads ?timedMode=coder from the URL', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/?timedMode=coder') })
    expect(result.current.timelineTableMode).toBe('coder')
  })

  it('coerces an unknown ?timedMode value to code', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/?timedMode=bogus') })
    expect(result.current.timelineTableMode).toBe('code')
  })

  it('setTimelineTableMode round-trips', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/') })
    act(() => result.current.setTimelineTableMode('coder'))
    expect(result.current.timelineTableMode).toBe('coder')
    act(() => result.current.setTimelineTableMode('code'))
    expect(result.current.timelineTableMode).toBe('code')
  })

  it('buildCurrentConfig carries timeline_table_mode', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/?timedMode=coder') })
    expect(result.current.buildCurrentConfig([]).timeline_table_mode).toBe('coder')
  })

  it('loadMaterial restores timeline_table_mode=coder into the URL state', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/') })
    act(() => result.current.loadMaterial({ id: 1, config: { timeline_table_mode: 'coder' } } as unknown as MaterialResponse))
    expect(result.current.timelineTableMode).toBe('coder')
  })

  it('loadMaterial on a PRE-#685 material (no key) falls back to code', () => {
    const { result } = renderHook(() => useQualitativeAnalysis(), { wrapper: wrapper('/?timedMode=coder') })
    act(() => result.current.loadMaterial({ id: 1, config: {} } as unknown as MaterialResponse))
    expect(result.current.timelineTableMode).toBe('code')
  })
})
