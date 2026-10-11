/**
 * #1145 — the Variables view's bulk type change says what it is doing and how
 * long it has been at it, rather than a disabled button alone.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BulkTypeChangeStatus } from './RecodeWorkbench'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('#1145 — the bulk type change wait', () => {
  it('names the work and the elapsed time, from the shared helpers', () => {
    vi.useFakeTimers()
    render(<BulkTypeChangeStatus count={12} />)
    act(() => { vi.advanceTimersByTime(8_000) })
    expect(screen.getByText('Changing the type of 12 variables — 8s elapsed.')).toBeInTheDocument()
  })

  it('one variable is singular', () => {
    render(<BulkTypeChangeStatus count={1} />)
    expect(screen.getByText(/^Changing the type of 1 variable — /)).toBeInTheDocument()
  })

  it('speaks once at the start, not on every tick (the live region is a sentence)', () => {
    vi.useFakeTimers()
    render(<BulkTypeChangeStatus count={3} />)
    act(() => { vi.advanceTimersByTime(8_000) })
    expect(screen.getByRole('status')).toHaveTextContent('Changing the type of 3 variables.')
    act(() => { vi.advanceTimersByTime(25_000) })
    expect(screen.getByRole('status')).toHaveTextContent('Still working — 30 seconds elapsed.')
  })
})
