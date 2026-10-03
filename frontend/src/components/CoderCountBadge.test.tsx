/**
 * Track J · Group A (#3) — CoderCountBadge: "N coders" beside the blind pill,
 * derived from coverage. Hidden for ≤1 coder; archived coders labeled in the
 * tooltip; gated off (no query) in single-coder instances.
 */
import { it, expect, vi, afterEach } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const coverage = vi.fn()
vi.mock('@/lib/api', () => ({
  codeAnalysisApi: { coderCoverage: (...a: unknown[]) => coverage(...a) },
}))

import CoderCountBadge from './CoderCountBadge'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderBadge(props: Partial<ComponentProps<typeof CoderCountBadge>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CoderCountBadge projectId={1} conversationId={5} withholding={false} {...props} />
    </QueryClientProvider>,
  )
}

it('renders the count and an archived-labeled tooltip when > 1 coder', async () => {
  coverage.mockResolvedValue({
    count: 3,
    coders: [
      { user_id: 1, username: 'Alice', display_color: null, archived: false },
      { user_id: 2, username: 'Ben', display_color: null, archived: false },
      { user_id: 9, username: 'Kwame', display_color: null, archived: true },
    ],
  })
  renderBadge()
  const badge = await screen.findByTitle(/3 coders on this source: .*Kwame \(archived\)/)
  expect(badge).toHaveTextContent('3 coders')
})

it('renders nothing for a single coder', async () => {
  coverage.mockResolvedValue({
    count: 1,
    coders: [{ user_id: 1, username: 'Alice', display_color: null, archived: false }],
  })
  renderBadge()
  await waitFor(() => expect(coverage).toHaveBeenCalled())
  expect(screen.queryByTitle(/coders on this source/)).toBeNull()
})

it('does not query in a single-coder instance (enabled=false)', async () => {
  renderBadge({ enabled: false })
  await new Promise(r => setTimeout(r, 0))
  expect(coverage).not.toHaveBeenCalled()
})

it('passes text_column_ids for text-coding sources', async () => {
  coverage.mockResolvedValue({
    count: 2,
    coders: [
      { user_id: 1, username: 'Alice', display_color: null, archived: false },
      { user_id: 2, username: 'Ben', display_color: null, archived: false },
    ],
  })
  renderBadge({ conversationId: undefined, textColumnIds: [7, 8] })
  await screen.findByTitle(/2 coders on this source/)
  expect(coverage).toHaveBeenCalledWith(1, expect.objectContaining({ text_column_ids: '7,8' }))
})

// ── #1078 — while colleagues' work is withheld, so are their names ──────────

const THREE = {
  count: 3,
  coders: [
    { user_id: 1, username: 'Alice', display_color: null, archived: false },
    { user_id: 2, username: 'Ben', display_color: null, archived: false },
    { user_id: 9, username: 'Kwame', display_color: null, archived: true },
  ],
}

it('#1078: while WITHHOLDING the tooltip names nobody, keeps the count, and says why', async () => {
  coverage.mockResolvedValue(THREE)
  renderBadge({ withholding: true })
  // The title IS the badge's accessible name, so this is what a screen reader reads.
  const badge = await screen.findByTitle(/3 coders on this source/)
  expect(badge).toHaveTextContent('3 coders')
  const title = badge.getAttribute('title') ?? ''
  for (const name of ['Alice', 'Ben', 'Kwame']) expect(title).not.toContain(name)
  expect(title).toMatch(/names are hidden while colleagues' work is hidden/)
})

it('#1078 positive control: the SAME fixture names everyone when not withholding', async () => {
  // Proves the negative assertion above could fail — the names are there to leak.
  coverage.mockResolvedValue(THREE)
  renderBadge({ withholding: false })
  const badge = await screen.findByTitle(/3 coders on this source/)
  expect(badge.getAttribute('title')).toMatch(/Alice, Ben, Kwame \(archived\)/)
})
