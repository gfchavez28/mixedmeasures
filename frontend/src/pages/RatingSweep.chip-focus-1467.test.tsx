/**
 * #1467 — choosing a code on the Ratings page keeps the chip the coder pressed (D132).
 *
 * Name-sweep run 15 (2026-10-29) measured it with the queue request held 3 s:
 * pressing *Supervisor support 6* by keyboard left `document.activeElement` on
 * `<body>`, and the filter row read *"All codes 0"* until the answer arrived. The
 * chip row was built from the NEW filter's query, which had no answer yet, so it
 * held only *All codes* — and the pressed chip unmounted.
 *
 * The chip row now reads the last ANSWERED queue. `per_code` is UNFILTERED
 * (#979), so that answer counts what the chips count; only the chips read it —
 * the walk still waits for the new filter. Each case holds the filtered request
 * open, because an answer that lands at once hides the window entirely.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { RatingQueueEntry, RatingQueueResponse } from '@/lib/api/coding'

const getRatingQueue = vi.fn()
const setMagnitude = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    codingApi: {
      ...actual.codingApi,
      getRatingQueue: (...a: unknown[]) => getRatingQueue(...a),
      setMagnitude: (...a: unknown[]) => setMagnitude(...a),
    },
  }
})

let projectId = 1
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId, setBreadcrumbLabel: vi.fn() }),
}))

import RatingSweep from './RatingSweep'

const BIPOLAR = {
  min: -1, max: 1, step: 0.5,
  anchors: [{ value: -1, label: 'strongly negative' }, { value: 1, label: 'strongly positive' }],
}
const NAMES: Record<number, string> = { 7: 'District support', 9: 'Supervisor support' }

const entry = (segmentId: number, codeId: number): RatingQueueEntry => ({
  code_id: codeId, code_name: NAMES[codeId], code_color: null, scale: BIPOLAR,
  target_kind: 'segment', segment_id: segmentId, dataset_value_id: null,
  source_type: 'conversation', source_id: 3, source_label: 'Interview one',
  text: `Passage ${segmentId}.`,
  start_time: null, end_time: null, record_identifier: null, n_targets: 1,
})

/** The server's unrated applications (a test may add one, as another screen would). */
let unrated: RatingQueueEntry[] = []

function answer(codeId: number | undefined): RatingQueueResponse {
  const scoped = codeId == null ? unrated : unrated.filter(e => e.code_id === codeId)
  const per = new Map<number, number>()
  for (const e of unrated) per.set(e.code_id, (per.get(e.code_id) ?? 0) + 1)
  return {
    entries: scoped, total: scoped.length, truncated: false,
    // Unfiltered whatever the filter (#979).
    per_code: [...per].map(([code_id, outstanding]) => ({ code_id, code_name: NAMES[code_id], outstanding })),
  }
}

/** The requests held open, as `project:code` (`all` = no code), until the test lets one answer. */
let held = new Set<string>()
let release: (() => void) | null = null

function renderSweep() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } })
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter><RatingSweep /></MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(tree())
  return { rerender: () => view.rerender(tree()) }
}

const chip = (name: RegExp) => screen.getByRole('button', { name })
const chipNames = () =>
  Array.from(screen.getByRole('group', { name: 'Work through one code' }).querySelectorAll('button'))
    .map(b => b.textContent)

/** Press a chip the way a keyboard does: focus it, then activate it. */
function pressByKeyboard(button: HTMLElement) {
  button.focus()
  expect(document.activeElement).toBe(button)
  fireEvent.click(button)
}

beforeEach(() => {
  projectId = 1
  unrated = [entry(1, 7), entry(2, 7), entry(3, 9), entry(4, 9), entry(5, 9)]
  // Supervisor support's queue, and project 2's first answer, wait for the test.
  held = new Set(['1:9', '2:all'])
  release = null
  setMagnitude.mockReset().mockResolvedValue({})
  getRatingQueue.mockReset().mockImplementation(
    (pid: number, opts?: { codeId?: number }) => {
      const key = `${pid}:${opts?.codeId ?? 'all'}`
      if (!held.has(key)) return Promise.resolve(answer(opts?.codeId))
      return new Promise<RatingQueueResponse>(resolve => { release = () => resolve(answer(opts?.codeId)) })
    },
  )
})
afterEach(cleanup)

describe('#1467 — the chip pressed stays while its queue loads', () => {
  it('focus stays on the pressed chip, and the row keeps its counts — never "All codes 0"', async () => {
    renderSweep()
    await screen.findByText('Passage 1.')
    expect(chipNames()).toEqual(['All codes 5', 'District support 2', 'Supervisor support 3'])

    const pressed = chip(/^Supervisor support/)
    pressByKeyboard(pressed)

    // The filtered request is out and unanswered.
    await waitFor(() => expect(getRatingQueue).toHaveBeenCalledWith(1, expect.objectContaining({ codeId: 9 })))
    expect(screen.getByText('Loading the queue…')).toBeInTheDocument()

    // HEAD: the row held only "All codes 0" and focus was on <body>.
    expect(pressed).toBeInTheDocument()
    expect(document.activeElement).toBe(pressed)
    expect(document.activeElement).not.toBe(document.body)
    expect(pressed).toHaveAttribute('aria-pressed', 'true')
    expect(chipNames()).toEqual(['All codes 5', 'District support 2', 'Supervisor support 3'])
  })

  it('only the chips read the last answer: the walk waits for the new filter', async () => {
    renderSweep()
    await screen.findByText('Passage 1.')
    pressByKeyboard(chip(/^Supervisor support/))
    await waitFor(() => expect(release).not.toBeNull())
    // No passage of the old (All codes) batch is offered under the new filter.
    expect(screen.queryByText('Passage 1.')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.getByText('Loading…', { selector: 'header p' })).toBeInTheDocument()
  })

  it('when the queue answers, the strip takes focus as before', async () => {
    renderSweep()
    await screen.findByText('Passage 1.')
    pressByKeyboard(chip(/^Supervisor support/))
    await waitFor(() => expect(release).not.toBeNull())
    await act(async () => { release!() })
    await screen.findByText('Passage 3.')
    await waitFor(() => expect(document.activeElement?.closest('[role="radiogroup"]')).not.toBeNull())
    expect(chipNames()).toEqual(['All codes 5', 'District support 2', 'Supervisor support 3'])
  })

  it('a rating this pass made is still taken off the held counts — the row reads what it read a moment ago', async () => {
    renderSweep()
    await screen.findByText('Passage 1.')
    // Rate the passage on screen (District support): the strip has focus.
    fireEvent.keyDown(document.activeElement as Element, { key: '1', bubbles: true })
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledTimes(1))
    await screen.findByText('Passage 2.')
    expect(chipNames()).toEqual(['All codes 4', 'District support 1', 'Supervisor support 3'])

    pressByKeyboard(chip(/^Supervisor support/))
    await waitFor(() => expect(release).not.toBeNull())
    // The held answer listed the rated entry, so the rating is subtracted against it.
    expect(chipNames()).toEqual(['All codes 4', 'District support 1', 'Supervisor support 3'])
  })

  it('the row holds the LATEST answer, not the first one', async () => {
    renderSweep()
    await screen.findByText('Passage 1.')
    expect(chipNames()).toEqual(['All codes 5', 'District support 2', 'Supervisor support 3'])
    // Another screen applies a scaled code: the next answer counts one more.
    unrated = [...unrated, entry(6, 9)]
    pressByKeyboard(chip(/^District support/))
    await waitFor(() => expect(chipNames()).toEqual(['All codes 6', 'District support 2', 'Supervisor support 4']))

    pressByKeyboard(chip(/^Supervisor support/))
    await waitFor(() => expect(release).not.toBeNull())
    expect(document.activeElement).toBe(chip(/^Supervisor support/))
    expect(chipNames()).toEqual(['All codes 6', 'District support 2', 'Supervisor support 4'])
  })

  it('D133 — a CACHED filter whose walk starts on the same passage still moves focus to the strip', async () => {
    // The 2026-10-29d `/ux-audit` case: no loading window (the answer is cached
    // and fresh), and the new walk's first passage is the one already showing.
    renderSweep()
    await screen.findByText('Passage 1.')
    // District support answers at once; its walk starts on Passage 1 too.
    pressByKeyboard(chip(/^District support/))
    await waitFor(() => expect(document.activeElement?.closest('[role="radiogroup"]')).not.toBeNull())
    expect(screen.getByText('Passage 1.')).toBeInTheDocument()

    // Back to All codes — CACHED and fresh, so the walk is re-taken in the same
    // render, again on Passage 1. HEAD: focus stayed on the chip.
    const all = chip(/^All codes/)
    pressByKeyboard(all)
    await waitFor(() => expect(document.activeElement?.closest('[role="radiogroup"]')).not.toBeNull())
    expect(document.activeElement).not.toBe(all)
    expect(screen.getByText('Passage 1.')).toBeInTheDocument()
    expect(getRatingQueue.mock.calls.filter(c => c[1]?.codeId == null)).toHaveLength(1) // no re-read: the cached path
  })

  it('pressing the chip already selected moves nothing (positive control: no new walk)', async () => {
    renderSweep()
    await screen.findByText('Passage 1.')
    const all = chip(/^All codes/)
    pressByKeyboard(all) // already selected — returns early (#1480 D20)
    expect(document.activeElement).toBe(all)
  })

  it('another project\'s chips are never this one\'s', async () => {
    const view = renderSweep()
    await screen.findByText('Passage 1.')
    projectId = 2 // its first answer is held open
    view.rerender()
    await waitFor(() => expect(getRatingQueue).toHaveBeenCalledWith(2, expect.anything()))
    expect(screen.queryByRole('group', { name: 'Work through one code' })).not.toBeInTheDocument()
  })
})
