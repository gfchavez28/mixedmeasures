/**
 * #1456 — the Ratings page against a server that BEHAVES like the real one: a rated entry
 * LEAVES the queue (`services/rating_queue.py` lists only unrated applications), so every
 * answer fetched after a rating already excludes it.
 *
 * ⚠️ **`RatingSweep.test.tsx`'s mocks serve the same payload before and after a rating**, the
 * one arrangement in which "the server's total less this pass's tally" is right whenever the
 * page re-reads the queue. This fake is stateful, and every case below re-reads the queue
 * AFTER a rating, by each of the four routes that do it: a filter change, *Load the next
 * batch*, an invalidation of `rating-queue` while the page is open (the codebook slide-out's
 * `invalidateDerivedCounts`, a root overlay on every project page), and a window refocus once
 * the answer is older than the app's 60 s `staleTime`.
 *
 * The fixture scale is −1…+1, so ZERO is interior (`magnitude-coding.md` §2).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { RatingQueueEntry, RatingQueueResponse } from '@/lib/api/coding'
import { invalidateDerivedCounts } from '@/lib/coding-cache'

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

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, setBreadcrumbLabel: vi.fn() }),
}))

import RatingSweep from './RatingSweep'

const BIPOLAR = {
  min: -1, max: 1, step: 0.5,
  anchors: [{ value: -1, label: 'strongly negative' }, { value: 1, label: 'strongly positive' }],
}
const NAMES: Record<number, string> = { 7: 'District support', 9: 'Pacing adherence' }

const entry = (segmentId: number, codeId = 7): RatingQueueEntry => ({
  code_id: codeId, code_name: NAMES[codeId], code_color: null, scale: BIPOLAR,
  target_kind: 'segment', segment_id: segmentId, dataset_value_id: null,
  source_type: 'conversation', source_id: 3, source_label: 'Interview one',
  text: `Passage ${segmentId}.`,
  start_time: null, end_time: null, record_identifier: null, n_targets: 1,
})

/** The server: what is still unrated, in the server's stable order. */
let unrated: RatingQueueEntry[] = []
let serverBatch = 50

function serve(codeId: number | undefined, limit: number | undefined): RatingQueueResponse {
  const scoped = codeId == null ? unrated : unrated.filter(e => e.code_id === codeId)
  const n = Math.min(limit ?? 50, serverBatch)
  const per = new Map<number, number>()
  for (const e of unrated) per.set(e.code_id, (per.get(e.code_id) ?? 0) + 1)
  return {
    entries: scoped.slice(0, n),
    total: scoped.length,
    truncated: scoped.length > n,
    // Unfiltered whatever the filter (#979).
    per_code: [...per].map(([code_id, outstanding]) => ({ code_id, code_name: NAMES[code_id], outstanding })),
  }
}

/** The app's own query defaults (`main.tsx`): a 60 s staleTime, one retry. */
function renderSweep(
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } }),
) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><RatingSweep /></MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

function pressInStrip(key: string) {
  const target = document.activeElement
  expect(target).not.toBe(document.body)
  fireEvent.keyDown(target as Element, { key, bubbles: true })
}

/** Rate the passage on screen and wait for the page to move past it. */
async function rateCurrent(text: string) {
  await screen.findByText(text)
  const calls = setMagnitude.mock.calls.length
  pressInStrip('1')
  await waitFor(() => expect(setMagnitude.mock.calls.length).toBe(calls + 1))
  await waitFor(() => expect(screen.queryByText(text)).not.toBeInTheDocument())
}

const header = () => screen.getByText(/waiting|Nothing waiting|Loading…/, { selector: 'header p' })

beforeEach(() => {
  serverBatch = 50
  getRatingQueue.mockReset().mockImplementation(
    (_pid: unknown, opts?: { codeId?: number; limit?: number }) => Promise.resolve(serve(opts?.codeId, opts?.limit)),
  )
  setMagnitude.mockReset().mockImplementation((segmentId: number, codeId: number, value: number | null) => {
    if (value !== null) unrated = unrated.filter(e => !(e.segment_id === segmentId && e.code_id === codeId))
    return Promise.resolve({})
  })
})
afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
  vi.useRealTimers()
})

describe('#1456 — re-reading the queue after a rating', () => {
  it('🔴 a FILTER CHANGE does not subtract the rating twice from the other code’s chip', async () => {
    unrated = [entry(51), entry(52), entry(53), ...[90, 91, 92, 93, 94].map(s => entry(s, 9))]
    renderSweep()
    await rateCurrent('Passage 51.')
    expect(await screen.findByRole('button', { name: /^District support 2$/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Pacing adherence 5$/ }))
    await screen.findByText('Passage 90.')
    // The server's answer for the filter was read AFTER the rating, so its counts
    // already exclude it: District support has 2 left, the whole queue 7.
    expect(screen.getByRole('button', { name: /^District support 2$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^All codes 7$/ })).toBeInTheDocument()
    expect(header()).toHaveTextContent(/^5 waiting$/)
  })

  it('🔴 LOAD THE NEXT BATCH does not subtract the pass’s ratings twice', async () => {
    serverBatch = 2
    unrated = [entry(51), entry(52), entry(53)]
    renderSweep()
    await rateCurrent('Passage 51.')
    await rateCurrent('Passage 52.')
    expect(await screen.findByText('That batch is done — 1 still waiting.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /load the next batch/i }))
    await screen.findByText('Passage 53.')
    expect(header()).toHaveTextContent(/^1 waiting · 2 rated in this pass$/)
  })

  it('🔴 an INVALIDATION while the page is open keeps the coder’s place and the count', async () => {
    unrated = [entry(51), entry(52), entry(53), entry(54)]
    const client = renderSweep()
    await rateCurrent('Passage 51.')
    expect(screen.getByText('Passage 52.')).toBeInTheDocument()
    const before = getRatingQueue.mock.calls.length
    // The codebook slide-out (a root overlay) calls this on any code edit.
    act(() => { invalidateDerivedCounts(client, 1) })
    await waitFor(() => expect(getRatingQueue.mock.calls.length).toBe(before + 1))
    await waitFor(() => expect(header()).toHaveTextContent(/rated in this pass/))
    // Still on the passage the coder was looking at — not the one after it.
    expect(screen.getByText('Passage 52.')).toBeInTheDocument()
    expect(header()).toHaveTextContent(/^3 waiting · 1 rated in this pass$/)
    // And Previous still reaches the passage rated before the refetch.
    fireEvent.click(screen.getByRole('button', { name: /previous passage/i }))
    expect(await screen.findByText('Passage 51.')).toBeInTheDocument()
    expect(screen.getByText(/^Recorded /)).toBeInTheDocument()
  })

  it('🔴 a WINDOW REFOCUS once the answer is a minute old keeps the coder’s place and the count', async () => {
    unrated = [entry(51), entry(52), entry(53), entry(54)]
    renderSweep()
    await rateCurrent('Passage 51.')
    const before = getRatingQueue.mock.calls.length
    // Only Date is faked: TanStack decides staleness from Date.now(), and the
    // app's staleTime is 60 s. Timers stay real so the refetch can run.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
    // v5's focus manager listens to `visibilitychange` (minimise and restore).
    act(() => { focusManager.setFocused(false) })
    act(() => { focusManager.setFocused(true) })
    await waitFor(() => expect(getRatingQueue.mock.calls.length).toBe(before + 1))
    await waitFor(() => expect(header()).toHaveTextContent(/rated in this pass/))
    expect(screen.getByText('Passage 52.')).toBeInTheDocument()
    expect(header()).toHaveTextContent(/^3 waiting · 1 rated in this pass$/)
  })

  it('🔴 a STALE cached answer is not walked — the page waits for the re-read (a passage rated on a workbench since)', async () => {
    // The guard on the snapshot: taken from the cache a workbench rating had marked
    // stale (#1425's helper), the walk would offer passage 51 — already rated —
    // for the whole batch. HEAD shows it only until the mount's refetch lands.
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } })
    unrated = [entry(51), entry(52), entry(53)]
    client.setQueryData(['rating-queue', 1, null], serve(undefined, 50))
    unrated = [entry(52), entry(53)]                     // 51 rated elsewhere since
    await client.invalidateQueries({ queryKey: ['rating-queue', 1], refetchType: 'none' })
    renderSweep(client)
    await waitFor(() => expect(getRatingQueue).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Passage 52.')).toBeInTheDocument()
    expect(screen.queryByText('Passage 51.')).not.toBeInTheDocument()
    expect(header()).toHaveTextContent(/^2 waiting$/)
  })

  it('🔴 #1425 — a rating here marks what it moves elsewhere, and does NOT refetch its own queue', async () => {
    unrated = [entry(51), entry(52)]
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } })
    const moved = [
      ['irr', 1, null, null], ['reconciliation', 1, null, false], ['consensus-status', 1],
      ['dataset-data', 1, 9, 0],                                   // the participant table's marker
      ['segments', 3], ['document', 1, 5], ['observation-segments', 1, 2], ['text-data', 1, '6'],
    ]
    const control = ['code-frequencies', 1, {}]                    // a rating moves no coded count
    for (const k of [...moved, control]) client.setQueryData(k, {})
    renderSweep(client)
    await rateCurrent('Passage 51.')
    const stale = (k: unknown[]) => client.getQueryState(k)?.isInvalidated
    expect(moved.filter(k => !stale(k)).map(k => k[0])).toEqual([])
    expect(stale(control)).toBe(false)
    expect(stale(['rating-queue', 1, null])).toBe(true)            // marked…
    expect(getRatingQueue).toHaveBeenCalledTimes(1)                // …not re-read per keypress
  })

  it('control: with NO re-read, the header and the walk are right on HEAD as well', async () => {
    unrated = [entry(51), entry(52), entry(53), entry(54)]
    renderSweep()
    await rateCurrent('Passage 51.')
    expect(screen.getByText('Passage 52.')).toBeInTheDocument()
    expect(header()).toHaveTextContent(/^3 waiting · 1 rated in this pass$/)
    expect(getRatingQueue).toHaveBeenCalledTimes(1)
  })
})

/**
 * #1480 — a queue answer that lands for a filter the coder has LEFT. `refetch()`
 * resolves with the observer's CURRENT result (TanStack 5.100.5,
 * `queryObserver.js:168-175`), which after a filter change is the NEW key's, and
 * the handler stored it under the OLD filter and reset the cursor. Each case
 * holds one request open and releases it after the coder has moved.
 */
type Held = { release: () => void }
function holdNext(): Held {
  const h: Held = { release: () => { throw new Error('the held request was never made') } }
  getRatingQueue.mockImplementationOnce((_pid: unknown, opts?: { codeId?: number; limit?: number }) =>
    new Promise(res => { h.release = () => res(serve(opts?.codeId, opts?.limit)) }))
  return h
}
const shown = () => document.querySelector('blockquote')?.textContent
async function settle(release: () => void) {
  await act(async () => { release(); await Promise.resolve() })
  // TanStack notifies observers on a timer (magnitude-coding.md §11).
  await new Promise(r => setTimeout(r, 30))
}

describe('#1480 — a late queue answer never moves the coder', () => {
  beforeEach(() => {
    serverBatch = 2
    unrated = [entry(51), entry(52), entry(53), ...[90, 91, 92].map(s => entry(s, 9))]
  })

  it('🔴 LOAD THE NEXT BATCH, then another code before it lands: the coder stays where they are in the new code', async () => {
    renderSweep()
    await rateCurrent('Passage 51.')
    await rateCurrent('Passage 52.')
    expect(await screen.findByText(/That batch is done/)).toBeInTheDocument()
    const batch = holdNext()
    fireEvent.click(screen.getByRole('button', { name: /load the next batch/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Pacing adherence 3$/ }))
    await rateCurrent('Passage 90.')
    expect(shown()).toBe('Passage 91.')
    await settle(batch.release)
    expect(shown()).toBe('Passage 91.')
    expect(screen.getByText(/^2 of 2 in this batch$/)).toBeInTheDocument()
  })

  it('🔴 …and the late answer is never walked under ANOTHER filter (All codes walks All’s answer)', async () => {
    renderSweep()
    await screen.findByText('Passage 51.')
    fireEvent.click(screen.getByRole('button', { name: /^Pacing adherence 3$/ }))
    await screen.findByText('Passage 90.')
    fireEvent.click(screen.getByRole('button', { name: /^All codes 6$/ }))
    await rateCurrent('Passage 51.')
    await rateCurrent('Passage 52.')
    unrated = unrated.filter(e => e.segment_id !== 90)        // rated on a workbench meanwhile
    const batch = holdNext()
    const nine = holdNext()
    fireEvent.click(await screen.findByRole('button', { name: /load the next batch/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Pacing adherence/ }))
    await settle(batch.release)
    fireEvent.click(screen.getByRole('button', { name: /^All codes/ }))
    await new Promise(r => setTimeout(r, 30))
    expect(shown()).toBe('Passage 53.')                         // never 90, which the server no longer lists
    await settle(nine.release)
    expect(shown()).toBe('Passage 53.')
  })

  it('🔴 a filter ROUND TRIP whose middle answer never landed does not restart the old walk on a rated passage', async () => {
    renderSweep()
    await rateCurrent('Passage 51.')
    expect(shown()).toBe('Passage 52.')
    const nine = holdNext()
    fireEvent.click(screen.getByRole('button', { name: /^Pacing adherence 3$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^All codes/ }))
    await waitFor(() => expect(shown()).toBeDefined())
    expect(shown()).toBe('Passage 52.')
    expect(screen.queryByText(/^Recorded /)).not.toBeInTheDocument()
    await settle(nine.release)
    expect(shown()).toBe('Passage 52.')
  })

  it('🔴 a re-read that REPLACES the batch request (an invalidation) does not put the old batch back on screen', async () => {
    const client = renderSweep()
    await rateCurrent('Passage 51.')
    await rateCurrent('Passage 52.')
    expect(await screen.findByText(/That batch is done/)).toBeInTheDocument()
    const batch = holdNext()
    const reread = holdNext()
    fireEvent.click(screen.getByRole('button', { name: /load the next batch/i }))
    // The codebook slide-out's code edit — `refetchQueries` cancels a fetch in flight.
    act(() => { invalidateDerivedCounts(client, 1) })
    await settle(() => {})
    expect(shown()).not.toBe('Passage 51.')
    expect(shown()).not.toBe('Passage 52.')
    await settle(reread.release)
    await settle(() => { try { batch.release() } catch { /* cancelled before it was answered */ } })
    expect(shown()).not.toBe('Passage 51.')
    expect(shown()).not.toBe('Passage 52.')
  })

  it('pressing the chip that is ALREADY selected does not restart the walk', async () => {
    renderSweep()
    await rateCurrent('Passage 51.')
    fireEvent.click(screen.getByRole('button', { name: /^All codes/ }))
    await new Promise(r => setTimeout(r, 30))
    expect(shown()).toBe('Passage 52.')
  })

  it('control: the batch lands BEFORE the filter changes — the new code’s walk is untouched', async () => {
    renderSweep()
    await rateCurrent('Passage 51.')
    await rateCurrent('Passage 52.')
    fireEvent.click(await screen.findByRole('button', { name: /load the next batch/i }))
    await screen.findByText('Passage 53.')
    expect(screen.getByText(/^1 of 2 in this batch$/)).toBeInTheDocument()   // 53 and 90: All's answer
    fireEvent.click(screen.getByRole('button', { name: /^Pacing adherence 3$/ }))
    await rateCurrent('Passage 90.')
    await new Promise(r => setTimeout(r, 30))
    expect(shown()).toBe('Passage 91.')
  })
})
