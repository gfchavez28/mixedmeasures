/**
 * useCellDragIdRegistry — dev-mode F1 invariant defensive check (#341).
 *
 * Tests verify:
 *   - Single registration is silent (the legitimate case for one Cell or
 *     one UnassignedCard mounting with a unique drag-id).
 *   - Two surfaces registering the same drag-id triggers console.error
 *     with a message naming both surfaces (the bug class — drift in the
 *     panel exclusion filter or a future third surface).
 *   - StrictMode-style mount → cleanup → remount on a single component
 *     does NOT false-positive (the registry uses per-surface counts so
 *     a balanced cycle leaves total surfaces at 1).
 *   - Cleanup removes registrations so a subsequent same-id registration
 *     after both unmounted is silent again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {
  __resetCellDragIdRegistryForTests,
  useCellDragIdRegistry,
} from './useCellDragIdRegistry'

function Probe({ id, label }: { id: string; label: string }) {
  useCellDragIdRegistry(id, label)
  return null
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  __resetCellDragIdRegistryForTests()
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  consoleErrorSpy.mockRestore()
})

describe('useCellDragIdRegistry — F1 invariant defensive check (#341)', () => {
  it('single registration of a drag-id is silent', () => {
    render(<Probe id="cell-42" label="Cell" />)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('two surfaces registering the same drag-id console.error with both labels', () => {
    render(
      <>
        <Probe id="cell-42" label="Cell" />
        <Probe id="cell-42" label="UnassignedCard" />
      </>,
    )
    expect(consoleErrorSpy).toHaveBeenCalled()
    const message = String(consoleErrorSpy.mock.calls[0][0])
    expect(message).toContain('cell-42')
    expect(message).toContain('Cell')
    expect(message).toContain('UnassignedCard')
    expect(message).toContain('F1 invariant')
  })

  it('two registrations on different drag-ids are silent', () => {
    render(
      <>
        <Probe id="cell-42" label="Cell" />
        <Probe id="cell-43" label="UnassignedCard" />
      </>,
    )
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('cleanup releases the registration — subsequent re-mount is silent', () => {
    const { unmount } = render(<Probe id="cell-42" label="Cell" />)
    unmount()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    render(<Probe id="cell-42" label="UnassignedCard" />)
    // Different surface, but the previous one is unmounted so no collision.
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('two surfaces, one unmounts → no warning on the survivor', () => {
    const { unmount: unmountA } = render(<Probe id="cell-42" label="Cell" />)
    const { unmount: unmountB } = render(<Probe id="cell-42" label="UnassignedCard" />)
    // Initial collision warning fires.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    consoleErrorSpy.mockClear()
    unmountA()
    // The survivor is alone now — no further warnings.
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    unmountB()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })
})
