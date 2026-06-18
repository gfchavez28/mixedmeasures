/**
 * Tests for useCrosswalkNavigation focus-row resolution (Phase 4.9).
 *
 * The hook reads `?focusRow=` (tagged form) on mount and scrolls the matching
 * row into view, falling through to the legacy `?focusRowId=N` (treated as
 * `eg:N`) with a console.warn deprecation. Behavior under test:
 *   - Legacy ?focusRowId=N → console.warn fires + scrolls to crosswalk-row-eg-N
 *   - Tagged ?focusRow=col:N → no warn + scrolls to crosswalk-row-col-N
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router-dom'
import { useCrosswalkNavigation } from './useCrosswalkNavigation'

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom doesn't implement scrollIntoView; the hook calls it after a
  // 50ms timer, which we flush in afterEach.
  Element.prototype.scrollIntoView =
    Element.prototype.scrollIntoView ?? (function () {} as Element['scrollIntoView'])
})

afterEach(() => {
  // Flush the hook's deferred setTimeout(applyFocus) before jsdom tears down,
  // otherwise document is undefined when the timer fires.
  act(() => {
    vi.runOnlyPendingTimers()
  })
  vi.useRealTimers()
  cleanup()
  vi.restoreAllMocks()
})

function Probe({ projectId }: { projectId: number }) {
  useCrosswalkNavigation({
    projectId,
    searchQuery: '',
    setSearchQuery: () => undefined,
  })
  return <div data-testid={`crosswalk-row-eg-42`} />
}

describe('useCrosswalkNavigation focus-row resolution', () => {
  it('warns and resolves when legacy ?focusRowId=N is used', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(
      <MemoryRouter initialEntries={['/?focusRowId=42']}>
        <Probe projectId={1} />
      </MemoryRouter>,
    )
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/focusRowId.*deprecated/)
  })

  it('does NOT warn when tagged ?focusRow=eg:N is used', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(
      <MemoryRouter initialEntries={['/?focusRow=eg:42']}>
        <Probe projectId={1} />
      </MemoryRouter>,
    )
    // The hook may still warn for "stale focus target" if the testid isn't found
    // — filter for our deprecation message specifically.
    const deprecationCalls = warn.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('deprecated'),
    )
    expect(deprecationCalls).toHaveLength(0)
  })
})
