/**
 * #1168 R7 — a Relationships & Comparisons result built from out-of-date scale
 * scores says so, names the groups, and offers the recompute.
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const api = vi.hoisted(() => ({ createScoreMetric: vi.fn() }))
vi.mock('@/lib/api', () => ({
  domainsApi: { createScoreMetric: api.createScoreMetric },
  extractApiError: (_e: unknown, fallback: string) => fallback,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import StaleScaleScoresNotice from './StaleScaleScoresNotice'
import { staleScaleScoresSentence } from '@/lib/stale-scale-scores'

afterEach(() => {
  cleanup()
  api.createScoreMetric.mockReset()
})

const DOMAINS = [
  { id: 4, name: 'Wellbeing' },
  { id: 6, name: 'Local' },
  { id: 8, name: 'Trust' },
]

function mount(staleDomainIds: number[], client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <main id="main-content" tabIndex={-1}>
        <StaleScaleScoresNotice pid={3} staleDomainIds={staleDomainIds} domains={DOMAINS} />
      </main>
    </QueryClientProvider>,
  )
  return client
}

describe('staleScaleScoresSentence', () => {
  it('names the groups from the page list', () => {
    expect(staleScaleScoresSentence([4, 6], DOMAINS))
      .toBe('Out of date: the Wellbeing and Local scale scores were computed before their data changed.')
    expect(staleScaleScoresSentence([8], DOMAINS))
      .toBe('Out of date: the Trust scale score was computed before its data changed.')
  })

  it('counts rather than guesses when the list cannot name one yet', () => {
    expect(staleScaleScoresSentence([4, 99], DOMAINS))
      .toBe('Out of date: 2 scale scores were computed before their data changed.')
    expect(staleScaleScoresSentence([4], undefined))
      .toBe('Out of date: 1 scale score was computed before its data changed.')
  })
})

describe('#1168 R7 — the out-of-date notice', () => {
  it('renders from the payload, naming the groups, with the recompute', () => {
    mount([4, 6])
    expect(screen.getByText(
      'Out of date: the Wellbeing and Local scale scores were computed before their data changed.',
    )).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recompute scale scores' })).toBeInTheDocument()
  })

  it('is ABSENT when nothing is out of date', () => {
    mount([])
    expect(screen.queryByText(/Out of date/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Recompute/ })).toBeNull()
  })

  it('recomputes ONCE PER stale group, then refreshes every reader of a score', async () => {
    api.createScoreMetric.mockResolvedValue({})
    const client = new QueryClient()
    for (const key of [
      ['correlation-matrix', 3, [], [4, 6], 'pearson', false],
      ['scatter-matrix', 3, [], [4, 6], true],
      ['group-comparison', 3, [], [4, 6], 2, null],
      ['metrics', 3],
      ['codes', 3],                     // unrelated — must stay fresh
    ]) client.setQueryData(key, {})
    mount([4, 6], client)
    fireEvent.click(screen.getByRole('button', { name: 'Recompute scale scores' }))
    await waitFor(() =>
      expect(client.getQueryState(['metrics', 3])?.isInvalidated).toBe(true))
    expect(api.createScoreMetric).toHaveBeenCalledTimes(2)
    expect(api.createScoreMetric).toHaveBeenNthCalledWith(1, 3, 4)
    expect(api.createScoreMetric).toHaveBeenNthCalledWith(2, 3, 6)
    expect(client.getQueryState(['correlation-matrix', 3, [], [4, 6], 'pearson', false])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['scatter-matrix', 3, [], [4, 6], true])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['group-comparison', 3, [], [4, 6], 2, null])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['codes', 3])?.isInvalidated).toBe(false)
  })

  it('busy: aria-disabled and refused, never `disabled` (focus stays, #959)', async () => {
    let resolve: () => void = () => {}
    api.createScoreMetric.mockReturnValue(new Promise<void>(r => { resolve = r }))
    mount([4])
    fireEvent.click(screen.getByRole('button', { name: 'Recompute scale scores' }))
    const busy = await screen.findByRole('button', { name: 'Recomputing…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).not.toBeDisabled()
    fireEvent.click(busy)
    expect(api.createScoreMetric).toHaveBeenCalledTimes(1)
    resolve()
  })
})
