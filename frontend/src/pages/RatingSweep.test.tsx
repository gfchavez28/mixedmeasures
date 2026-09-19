/**
 * RatingSweep — the second-pass rating surface (#35 variant B, row 45 (ii)).
 *
 * What only a page test can prove, and each pin is a decision from the build:
 *
 *   · a segment entry and a dataset-cell entry commit through DIFFERENT
 *     endpoints, chosen in ONE place (`lib/rating-commit.ts`) — the routing is
 *     the whole reason that module exists, and a page that got it wrong would
 *     404 on half its queue;
 *   · Esc SKIPS and writes NOTHING — an unrated application is already unrated,
 *     and a `null` PATCH would clear a merge-conflict flag the coder never
 *     adjudicated;
 *   · the strip opens with NO cursor here, so Enter alone commits nothing (the
 *     component half is pinned in `MagnitudeStrip.test.tsx`; this is the pin
 *     that the PAGE passes the mode);
 *   · the per-code chips are named from the SERVER's counts, never from the
 *     batch — the defect the named counts were introduced to fix.
 *
 * 🔴 **The fixture scale is −1…+1, so ZERO is interior**, matching the backend
 * suite: on 0–10 a falsy-zero slip and a correct implementation agree.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { RatingQueueEntry, RatingQueueResponse } from '@/lib/api/coding'

const getRatingQueue = vi.fn()
const setMagnitude = vi.fn()
const setTextMagnitude = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    codingApi: {
      ...actual.codingApi,
      getRatingQueue: (...a: unknown[]) => getRatingQueue(...a),
      setMagnitude: (...a: unknown[]) => setMagnitude(...a),
    },
    textCodingApi: {
      ...actual.textCodingApi,
      setMagnitude: (...a: unknown[]) => setTextMagnitude(...a),
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

const entry = (over: Partial<RatingQueueEntry> = {}): RatingQueueEntry => ({
  code_id: 7, code_name: 'District support', code_color: null, scale: BIPOLAR,
  target_kind: 'segment', segment_id: 51, dataset_value_id: null,
  source_type: 'conversation', source_id: 3, source_label: 'Interview one',
  text: 'The district has been supportive throughout.',
  start_time: null, end_time: null, record_identifier: null, n_targets: 1,
  ...over,
})

const queue = (over: Partial<RatingQueueResponse> = {}): RatingQueueResponse => ({
  entries: [entry()],
  total: 1,
  truncated: false,
  per_code: [{ code_id: 7, code_name: 'District support', outstanding: 1 }],
  ...over,
})

function renderSweep() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><RatingSweep /></MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Press a key on whatever the strip focused — autoFocus is the mechanism. */
function pressInStrip(key: string) {
  const target = document.activeElement
  expect(target).not.toBe(document.body)
  fireEvent.keyDown(target as Element, { key, bubbles: true })
}

beforeEach(() => {
  getRatingQueue.mockReset().mockResolvedValue(queue())
  setMagnitude.mockReset().mockResolvedValue({})
  setTextMagnitude.mockReset().mockResolvedValue({})
})
afterEach(cleanup)

describe('RatingSweep — the passage and its instrument', () => {
  it('shows one passage with its source and its declared scale', async () => {
    renderSweep()
    expect(await screen.findByText(/district has been supportive/i)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Interview one/ })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /District support/ })).toBeInTheDocument()
  })

  it('says how many are waiting rather than a percentage', async () => {
    getRatingQueue.mockResolvedValue(queue({ total: 12, truncated: true }))
    renderSweep()
    expect(await screen.findByText(/12 waiting/)).toBeInTheDocument()
  })

  it('🔴 opens with NO cursor, so Enter alone commits nothing', async () => {
    renderSweep()
    await screen.findByRole('radiogroup')
    pressInStrip('Enter')
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(setMagnitude).not.toHaveBeenCalled()
  })

  it('says what a GROUPED rating will cover, since the siblings are off screen', async () => {
    getRatingQueue.mockResolvedValue(queue({ entries: [entry({ n_targets: 3 })] }))
    renderSweep()
    expect(await screen.findByText(/covers 3 grouped segments/i)).toBeInTheDocument()
  })

  it('a clip with no label says so rather than rendering an empty quote', async () => {
    getRatingQueue.mockResolvedValue(queue({
      entries: [entry({ text: '', source_type: 'observation', start_time: 12, end_time: 20 })],
    }))
    renderSweep()
    expect(await screen.findByText(/no text on this clip/i)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /0:12–0:20/ })).toBeInTheDocument()
  })
})

describe('RatingSweep — committing routes to the right endpoint', () => {
  it('a SEGMENT entry commits through the segment endpoint', async () => {
    renderSweep()
    await screen.findByRole('radiogroup')
    pressInStrip('1')
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(51, 7, 1))
    expect(setTextMagnitude).not.toHaveBeenCalled()
  })

  it('🔴 a DATASET CELL entry commits through the text-coding endpoint', async () => {
    // The two endpoints differ in shape as well as in path — this one is
    // body-keyed on the cell — so a page that routed by habit would 404.
    getRatingQueue.mockResolvedValue(queue({
      entries: [entry({
        target_kind: 'dataset_value', segment_id: null, dataset_value_id: 88,
        source_type: 'column', source_label: 'Staff survey › changed',
        record_identifier: 'R0007',
      })],
    }))
    renderSweep()
    await screen.findByRole('radiogroup')
    pressInStrip('1')
    await waitFor(() => expect(setTextMagnitude).toHaveBeenCalledWith(
      1, { dataset_value_id: 88, code_id: 7, magnitude: 1 },
    ))
    expect(setMagnitude).not.toHaveBeenCalled()
  })

  it('🔴 commits a rating of ZERO — it is a judgement, not an absence', async () => {
    renderSweep()
    await screen.findByRole('radiogroup')
    pressInStrip('0')
    await waitFor(() => expect(setMagnitude).toHaveBeenCalledWith(51, 7, 0))
  })

  it('advances to the next passage after a commit', async () => {
    getRatingQueue.mockResolvedValue(queue({
      entries: [entry(), entry({ segment_id: 52, text: 'A second passage.' })],
      total: 2,
    }))
    renderSweep()
    await screen.findByText(/district has been supportive/i)
    pressInStrip('1')
    expect(await screen.findByText('A second passage.')).toBeInTheDocument()
  })

  it('shows the SERVER’s reason when a rating is refused', async () => {
    setMagnitude.mockRejectedValue({
      response: { data: { detail: '“District support” is inactive. Restore it before rating it.' } },
    })
    const { toast } = await import('sonner')
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '' as never)
    renderSweep()
    await screen.findByRole('radiogroup')
    pressInStrip('1')
    await waitFor(() => expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Restore it before rating it'),
    ))
    error.mockRestore()
  })
})

describe('RatingSweep — skipping writes nothing', () => {
  it('🔴 Esc advances WITHOUT a request', async () => {
    // The application is already unrated, so a `null` PATCH would change no
    // state — and would clear a merge-conflict flag as a side effect, which is
    // an adjudication the coder did not make by pressing skip.
    getRatingQueue.mockResolvedValue(queue({
      entries: [entry(), entry({ segment_id: 52, text: 'A second passage.' })],
      total: 2,
    }))
    renderSweep()
    await screen.findByText(/district has been supportive/i)
    pressInStrip('Escape')
    expect(await screen.findByText('A second passage.')).toBeInTheDocument()
    expect(setMagnitude).not.toHaveBeenCalled()
    expect(setTextMagnitude).not.toHaveBeenCalled()
  })

  it('the Skip button does the same and names what it does', async () => {
    getRatingQueue.mockResolvedValue(queue({
      entries: [entry(), entry({ segment_id: 52, text: 'A second passage.' })],
      total: 2,
    }))
    renderSweep()
    await screen.findByText(/district has been supportive/i)
    fireEvent.click(screen.getByRole('button', { name: /leave unrated and go to the next passage/i }))
    expect(await screen.findByText('A second passage.')).toBeInTheDocument()
    expect(setMagnitude).not.toHaveBeenCalled()
  })

  it('Previous is disabled on the first passage and reachable after moving on', async () => {
    getRatingQueue.mockResolvedValue(queue({
      entries: [entry(), entry({ segment_id: 52, text: 'A second passage.' })],
      total: 2,
    }))
    renderSweep()
    await screen.findByText(/district has been supportive/i)
    const back = () => screen.getByRole('button', { name: /previous passage/i })
    expect(back()).toBeDisabled()
    pressInStrip('Escape')
    await screen.findByText('A second passage.')
    fireEvent.click(back())
    expect(await screen.findByText(/district has been supportive/i)).toBeInTheDocument()
  })
})

describe('RatingSweep — the per-code filter', () => {
  it('🔴 names a chip from the SERVER’s counts, not from the batch', async () => {
    // `entries` is one batch and the counts span the queue, so the second code
    // has nothing on screen to be named from. A client deriving names from
    // `entries` would label this chip with a bare id.
    getRatingQueue.mockResolvedValue(queue({
      total: 9,
      per_code: [
        { code_id: 7, code_name: 'District support', outstanding: 5 },
        { code_id: 9, code_name: 'Pacing adherence', outstanding: 4 },
      ],
    }))
    renderSweep()
    // 🔴 Queried by ACCESSIBLE NAME, never by text. The two DIFFER here: the
    // count sits in its own span and the name algorithm trims each text node
    // before joining, so a space typed inside that span vanishes. A text
    // assertion passes over a control that announces "Pacing adherence4".
    expect(await screen.findByRole('button', { name: /Pacing adherence 4/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Code 9/ })).not.toBeInTheDocument()
  })

  it('choosing a code refetches scoped to it and restarts the walk', async () => {
    getRatingQueue.mockResolvedValue(queue({
      total: 9,
      per_code: [
        { code_id: 7, code_name: 'District support', outstanding: 5 },
        { code_id: 9, code_name: 'Pacing adherence', outstanding: 4 },
      ],
    }))
    renderSweep()
    fireEvent.click(await screen.findByRole('button', { name: /Pacing adherence 4/ }))
    await waitFor(() => expect(getRatingQueue).toHaveBeenLastCalledWith(
      1, expect.objectContaining({ codeId: 9 }),
    ))
  })

  it('the All chip is pressed to begin with', async () => {
    renderSweep()
    const all = await screen.findByRole('button', { name: /All codes/ })
    expect(all).toHaveAttribute('aria-pressed', 'true')
  })

  /**
   * 🔴 **#979 — the filter narrows the QUEUE and never the PICKER.**
   *
   * ⚠️ **The mock has to reproduce that asymmetry or none of this is visible.**
   * The test above serves ONE payload to every call, so the filtered and the
   * unfiltered answers are identical — the single arrangement in which all
   * three symptoms disappear. These serve them differently: `entries`/`total`
   * narrow, `per_code` spans the whole queue (`services/rating_queue.py`).
   */
  const serveNarrowedQueue = (pacing = 5) => {
    const both = [
      { code_id: 7, code_name: 'District support', outstanding: 3 },
      { code_id: 9, code_name: 'Pacing adherence', outstanding: pacing },
    ]
    getRatingQueue.mockImplementation((_pid: unknown, opts: { codeId?: number }) =>
      Promise.resolve(opts?.codeId === 9
        ? queue({
            entries: [entry({ code_id: 9, code_name: 'Pacing adherence', segment_id: 90 })],
            total: pacing,
            per_code: both,
          })
        : queue({ entries: [entry()], total: 3 + pacing, per_code: both })))
  }

  it('🔴 the "All codes" chip counts EVERY code while a filter is active', async () => {
    serveNarrowedQueue()
    renderSweep()
    fireEvent.click(await screen.findByRole('button', { name: /Pacing adherence 5/ }))
    // 3 + 5. Reading the FILTERED total here put one code's number on a chip
    // whose label says "All codes".
    expect(await screen.findByRole('button', { name: /All codes 8/ })).toBeInTheDocument()
  })

  it('🔴 a code worked to zero keeps the chip row — it is the only way out', async () => {
    serveNarrowedQueue(1)
    renderSweep()
    fireEvent.click(await screen.findByRole('button', { name: /Pacing adherence 1/ }))
    await screen.findByRole('radiogroup')
    pressInStrip('1')
    await waitFor(() => expect(setMagnitude).toHaveBeenCalled())
    // The row was gated on having chips to list; with `per_code` narrowed it
    // emptied here and took the "All codes" chip — the only control that
    // clears the filter — off the screen with it.
    expect(await screen.findByRole('button', { name: /All codes 3/ })).toBeInTheDocument()
    // The selected code keeps its chip at zero, so the active filter is still
    // visible. This 0 is measured, not a placeholder for an unanswered list.
    expect(screen.getByRole('button', { name: /Pacing adherence 0/ })).toBeInTheDocument()
  })

  it('a finished code says where the rest of the work is', async () => {
    serveNarrowedQueue(1)
    renderSweep()
    fireEvent.click(await screen.findByRole('button', { name: /Pacing adherence 1/ }))
    await screen.findByRole('radiogroup')
    pressInStrip('1')
    expect(await screen.findByText(
      /Nothing left to rate for this code — 3 still waiting on other codes\./,
    )).toBeInTheDocument()
  })

  it('🔴 with the WHOLE queue finished, the filter is still clearable', async () => {
    // The row's own gate. With nothing outstanding anywhere `per_code` is
    // empty, so there are no chips to list — and gated purely on having them
    // the row disappears with the filter still set and no control to clear it.
    // This is the one state the unfiltered `per_code` does not already cover.
    getRatingQueue.mockImplementation((_pid: unknown, opts: { codeId?: number }) =>
      Promise.resolve(opts?.codeId === 9
        ? queue({ entries: [], total: 0, per_code: [] })
        : queue({
            entries: [entry()],
            total: 1,
            per_code: [{ code_id: 9, code_name: 'Pacing adherence', outstanding: 1 }],
          })))
    renderSweep()
    fireEvent.click(await screen.findByRole('button', { name: /Pacing adherence 1/ }))
    expect(await screen.findByRole('button', { name: /All codes/ })).toBeInTheDocument()
  })

  it('🔴 the count does not subtract a rating given on ANOTHER code', async () => {
    serveNarrowedQueue()
    renderSweep()
    await screen.findByRole('radiogroup')
    pressInStrip('1')                       // rates one on code 7, unfiltered
    await waitFor(() => expect(setMagnitude).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /Pacing adherence 5/ }))
    // Pacing has five outstanding and none of them was just rated. Subtracting
    // the whole pass tally from a scoped total read "4 waiting" — against five
    // entries, and against Pacing's own chip saying 5.
    expect(await screen.findByText(/^5 waiting$/)).toBeInTheDocument()
  })
})

describe('RatingSweep — the ends of the queue', () => {
  it('an empty queue names the precondition rather than looking broken', async () => {
    getRatingQueue.mockResolvedValue(queue({ entries: [], total: 0, per_code: [] }))
    renderSweep()
    expect(await screen.findByText(/every coded passage .* has been rated/i)).toBeInTheDocument()
    expect(screen.getByText(/only appears here once it declares a rating scale/i)).toBeInTheDocument()
  })

  it('a worked-through batch with more waiting offers the next batch', async () => {
    getRatingQueue.mockResolvedValue(queue({ entries: [], total: 40, truncated: true }))
    renderSweep()
    expect(await screen.findByText(/40 still waiting/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /load the next batch/i })).toBeInTheDocument()
  })

  it('a failed load says so instead of rendering an empty queue', async () => {
    getRatingQueue.mockRejectedValue({ response: { data: { detail: 'Project not found' } } })
    renderSweep()
    expect(await screen.findByRole('alert')).toHaveTextContent('Project not found')
  })
})

describe('RatingSweep — what the controls announce (a11y-name-sweep run 6)', () => {
  it('🔴 Skip and Previous are named STARTING with the word on them (WCAG 2.5.3)', async () => {
    // Measured in Chrome before the fix: the Skip button announced "Leave unrated
    // and go to the next passage", so a voice-control user saying "click Skip"
    // reached nothing. The explanation may follow the visible word; it may not
    // replace it.
    getRatingQueue.mockResolvedValue(queue({
      entries: [entry(), entry({ segment_id: 52, text: 'A second passage.' })],
      total: 2,
    }))
    renderSweep()
    await screen.findByRole('radiogroup')
    for (const visible of ['Skip', 'Previous']) {
      const button = screen.getByRole('button', { name: new RegExp(`^${visible}\\b`) })
      expect(button).toHaveTextContent(visible)
    }
  })

  it('🔴 skipping the LAST passage moves focus to "Load the next batch", described by the sentence', async () => {
    // Before: the strip held focus, the last Esc unmounted it, and focus fell to
    // <body> — the coder was put back at the top of the page and nothing said
    // the batch had ended.
    getRatingQueue.mockResolvedValue(queue({ entries: [entry()], total: 1 }))
    renderSweep()
    await screen.findByRole('radiogroup')
    pressInStrip('Escape')
    const next = await screen.findByRole('button', { name: /load the next batch/i })
    await waitFor(() => expect(document.activeElement).toBe(next))
    expect(next).toHaveAccessibleDescription('That batch is done — 1 still waiting.')
  })

  it('🔴 rating the last one, with nothing left, moves focus to the sentence that says so', async () => {
    getRatingQueue.mockResolvedValue(queue({ entries: [entry()], total: 1 }))
    renderSweep()
    await screen.findByRole('radiogroup')
    pressInStrip('1')
    const message = await screen.findByText(/every coded passage .* has been rated/i)
    await waitFor(() => expect(document.activeElement).toBe(message))
  })

  it('a first load that lands on the end state does NOT pull focus into the page', async () => {
    getRatingQueue.mockResolvedValue(queue({ entries: [], total: 40, truncated: true }))
    renderSweep()
    await screen.findByRole('button', { name: /load the next batch/i })
    expect(document.activeElement).toBe(document.body)
  })
})
