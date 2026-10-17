/**
 * #1054 review §4 #9 — one component says a long request's wait: what is
 * happening, the elapsed seconds (hidden from readers — they tick), and a spoken
 * line that changes only every 30 seconds.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import LongWaitStatus from './LongWaitStatus'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('LongWaitStatus', () => {
  it('says what is happening, then "still working" only when 30 seconds have passed', () => {
    render(
      <LongWaitStatus label="Deleting “P”…" firstAnnouncement="Deleting the project. Keep it open.">
        A large project takes a little while.
      </LongWaitStatus>,
    )
    expect(screen.getByText('Deleting “P”…')).toBeInTheDocument()
    expect(screen.getByText('A large project takes a little while.')).toBeInTheDocument()
    const spoken = screen.getByRole('status')
    expect(spoken).toHaveTextContent('Deleting the project. Keep it open.')
    act(() => { vi.advanceTimersByTime(12_000) })
    expect(spoken).toHaveTextContent('Deleting the project. Keep it open.')
    expect(screen.getByText('12s elapsed.')).toHaveAttribute('aria-hidden', 'true')
    act(() => { vi.advanceTimersByTime(19_000) })
    expect(spoken).toHaveTextContent('Still working — 30 seconds elapsed.')
  })
})
