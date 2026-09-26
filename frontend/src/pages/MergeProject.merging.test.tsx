import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MergingStep } from './MergeProject'

afterEach(() => { cleanup(); vi.useRealTimers() })

/**
 * #1015 — the merge's wait was a spinner and "Merging…" with nothing spoken.
 * These pin what replaced it: a status a screen reader hears at the start and
 * every 30 s, never a percentage, and an admission when the usual time passes.
 */
describe('MergingStep', () => {
  const tick = (seconds: number) => act(() => { vi.advanceTimersByTime(seconds * 1000) })

  it('says what is happening and how long it usually takes, as a status', () => {
    vi.useFakeTimers()
    render(<MergingStep fileSizeBytes={10_100_000} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Merging. This usually takes about 30 seconds for a file this size.',
    )
    expect(screen.getByText(/A safety copy of your project is saved first/)).toBeInTheDocument()
  })

  it('claims no percentage: there is no progressbar for a screen reader to read', () => {
    vi.useFakeTimers()
    render(<MergingStep fileSizeBytes={10_100_000} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('speaks again only at 30 s, and then admits the usual time has passed', () => {
    vi.useFakeTimers()
    render(<MergingStep fileSizeBytes={5_000_000} />) // ~15 s estimate
    tick(29)
    expect(screen.getByRole('status')).toHaveTextContent(/^Merging\./)
    tick(2)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Still working — 30 seconds elapsed. This is taking longer than usual for this file.',
    )
    expect(screen.getByText(/longer than the usual ~15s/)).toBeInTheDocument()
  })

  it('stays on the usual wording while within the estimate', () => {
    vi.useFakeTimers()
    render(<MergingStep fileSizeBytes={40_000_000} />) // ~120 s estimate
    tick(31)
    expect(screen.getByRole('status')).toHaveTextContent('Still working — 30 seconds elapsed.')
    expect(screen.getByRole('status')).not.toHaveTextContent(/longer than usual/)
    expect(screen.getByText(/usually about 120s/)).toBeInTheDocument()
  })
})
