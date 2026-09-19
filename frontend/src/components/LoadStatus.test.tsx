/**
 * #961 — the two things a list surface says before it can show the list.
 *
 *   · loading is a live status, with the slow-load hint after `SLOW_HINT_MS`;
 *   · a failure says the LOAD failed — in words true of the request (timeout,
 *     refusal, anything else) — and that nothing in the project changed;
 *   · Retry stays mounted, focused and inert while it runs (`aria-disabled`,
 *     click-guarded: a disabled button loses focus in Chrome);
 *   · when a Retry SUCCEEDS the notice unmounts with the focused button, so
 *     focus moves to the caller's landing — only after a press, only when lost.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useRef, useState } from 'react'
import { ApiError } from '@/lib/api/client'
import { LoadFailedNotice, LoadingNotice, LoadState, SLOW_HINT_MS } from './LoadStatus'
import { loadFailureReason, type ListLoad } from '@/lib/list-status'

afterEach(() => { cleanup(); vi.useRealTimers() })

const load = (over: Partial<ListLoad> = {}): ListLoad => ({
  status: 'failed', error: new ApiError(500, { detail: 'Internal Server Error' }, {}), retry: vi.fn(), retrying: false, ...over,
})

describe('LoadingNotice', () => {
  it('is a status with its label, and says a long wait is normal only after the delay', () => {
    vi.useFakeTimers()
    render(<LoadingNotice label="Loading codes…" />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Loading codes…')
    expect(status).not.toHaveTextContent(/large project/)

    act(() => { vi.advanceTimersByTime(SLOW_HINT_MS) })
    expect(status).toHaveTextContent('On a large project this can take a minute or more.')
  })
})

describe('loadFailureReason', () => {
  it('a timeout is not called a server fault', () => {
    const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })
    expect(loadFailureReason(timeout)).toMatch(/took too long/)
  })

  it("a refusal carries the server's own words", () => {
    expect(loadFailureReason(new ApiError(404, { detail: 'Project not found' }, {}))).toBe('Project not found')
  })

  it('a 5xx body is never shown — it says nothing', () => {
    expect(loadFailureReason(new ApiError(500, { detail: 'Internal Server Error' }, {}))).toBe('Something went wrong while loading.')
  })

  it('an error with no status (a dropped connection) gets the generic sentence', () => {
    expect(loadFailureReason(new TypeError('Failed to fetch'))).toBe('Something went wrong while loading.')
  })
})

describe('LoadFailedNotice', () => {
  it('says the load failed and that the project is unchanged, as an alert', () => {
    render(<LoadFailedNotice title="Codes could not be loaded." load={load()} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Codes could not be loaded.')
    expect(alert).toHaveTextContent('Nothing in your project has changed.')
    // The button is OUTSIDE the alert, so a label change is not re-announced as one.
    expect(alert).not.toContainElement(screen.getByRole('button', { name: 'Retry' }))
  })

  it('Retry calls the load’s retry', () => {
    const l = load()
    render(<LoadFailedNotice title="x" load={l} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(l.retry).toHaveBeenCalledTimes(1)
  })

  it('while retrying the button stays focusable, announces it, and does nothing', () => {
    const l = load({ retrying: true })
    render(<LoadFailedNotice title="x" load={l} />)
    const button = screen.getByRole('button', { name: 'Retrying…' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    button.focus()
    fireEvent.click(button)
    expect(l.retry).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button)
  })
})

/** A surface in miniature: the notice while not ready, a list once it is. */
function Surface({ initial }: { initial: ListLoad }) {
  const landingRef = useRef<HTMLButtonElement>(null)
  const [l, setL] = useState(initial)
  return (
    <div>
      <button ref={landingRef}>Landing</button>
      <button onClick={() => setL({ ...l, status: 'ready', retrying: false })}>resolve</button>
      {l.status === 'ready'
        ? <p>the list</p>
        : <LoadState
            load={{ ...l, retry: () => setL({ ...l, status: 'loading', retrying: true }) }}
            loadingLabel="Loading…"
            failedTitle="Failed."
            landingRef={landingRef}
          />}
    </div>
  )
}

describe('LoadState', () => {
  it('keeps the failure notice — and the focused Retry — up through the retry, then lands focus', () => {
    render(<Surface initial={load()} />)
    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    fireEvent.click(retry)

    // The query is `pending` underneath, yet the SAME button is still here and focused.
    const same = screen.getByRole('button', { name: 'Retrying…' })
    expect(same).toBe(retry)
    expect(document.activeElement).toBe(retry)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    // The retry succeeds: the notice unmounts with the focused button.
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'resolve' })) })
    expect(screen.getByText('the list')).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Landing' }))
  })

  it('does NOT pull focus when a FAILURE notice goes away without a Retry press', () => {
    // A background refetch (window focus, an invalidation) can answer a failed
    // list with nobody pressing anything. Focus is on <body> throughout — the
    // "lost" condition holds — so only the press guard stops a stray landing.
    // ⚠️ It must start from `failed`: a LOADING notice never runs this cleanup,
    // and the first draft of this test started there and certified nothing.
    render(<Surface initial={load()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Failed.')
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'resolve' })) })
    expect(screen.getByText('the list')).toBeInTheDocument()
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Landing' }))
  })

  it('does NOT move focus a researcher has already moved elsewhere', () => {
    render(<Surface initial={load()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const elsewhere = screen.getByRole('button', { name: 'resolve' })
    elsewhere.focus()
    act(() => { fireEvent.click(elsewhere) })
    expect(document.activeElement).toBe(elsewhere)
  })
})
