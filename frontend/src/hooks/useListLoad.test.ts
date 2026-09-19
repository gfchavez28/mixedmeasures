/**
 * #961 — `useListLoad` combines the lists a claim rests on and owns the retry.
 *
 * The retry state is the load-bearing part: with nothing cached, React Query v5
 * resets an errored query to `pending` the moment it refetches (measured under
 * #957), so a surface reading `status` alone would swap its failure notice for
 * a loading line and unmount the Retry button under the keyboard user who
 * pressed it. `retrying` is what keeps the notice up.
 */
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useListLoad, type ListLoadQuery } from './useListLoad'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

const q = (over: Partial<ListLoadQuery>): ListLoadQuery => ({
  data: undefined, isError: false, error: null, refetch: vi.fn(() => Promise.resolve()), ...over,
})

describe('useListLoad', () => {
  it('reports the combined status and the error of the list that FAILED', () => {
    const boom = new Error('boom')
    const { result } = renderHook(() => useListLoad(
      q({ data: { codes: [] } }),
      q({ isError: true, error: boom }),
    ))
    expect(result.current.status).toBe('failed')
    expect(result.current.error).toBe(boom)
  })

  it('does not report the error of a list that still HAS an answer', () => {
    // A failed refetch over cached data is `ready`; its error must not become
    // the reason printed for some other list's wait.
    const stale = new Error('refetch failed')
    const { result } = renderHook(() => useListLoad(
      q({ data: { codes: [] }, isError: true, error: stale }),
      q({}),
    ))
    expect(result.current.status).toBe('loading')
    expect(result.current.error).toBeNull()
  })

  it('retry refetches ONLY the lists with no answer', () => {
    const answered = q({ data: { codes: [] } })
    const failed = q({ isError: true, error: new Error('x') })
    const { result } = renderHook(() => useListLoad(answered, failed))
    act(() => { result.current.retry() })
    expect(failed.refetch).toHaveBeenCalledTimes(1)
    expect(answered.refetch).not.toHaveBeenCalled()
  })

  it('stays retrying until every refetch settles, then clears', async () => {
    const d = deferred()
    const failed = q({ isError: true, error: new Error('x'), refetch: vi.fn(() => d.promise) })
    const { result } = renderHook(() => useListLoad(failed))

    act(() => { result.current.retry() })
    expect(result.current.retrying).toBe(true)

    await act(async () => { d.resolve(); await d.promise })
    expect(result.current.retrying).toBe(false)
  })

  it('a second press during a retry cannot clear `retrying` early', async () => {
    const first = deferred()
    const second = deferred()
    const refetch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const failed = q({ isError: true, error: new Error('x'), refetch })
    const { result } = renderHook(() => useListLoad(failed))

    act(() => { result.current.retry() })
    act(() => { result.current.retry() })
    await act(async () => { first.resolve(); await first.promise })
    expect(result.current.retrying).toBe(true)

    await act(async () => { second.resolve(); await second.promise })
    expect(result.current.retrying).toBe(false)
  })

  it('a REJECTED refetch still clears `retrying`', async () => {
    const failed = q({ isError: true, error: new Error('x'), refetch: vi.fn(() => Promise.reject(new Error('y'))) })
    const { result } = renderHook(() => useListLoad(failed))
    await act(async () => { result.current.retry() })
    expect(result.current.retrying).toBe(false)
  })

  it('reads the LATEST queries at press time, not the ones from the first render', () => {
    const first = q({ isError: true, error: new Error('x') })
    const later = q({ isError: true, error: new Error('x') })
    const { result, rerender } = renderHook(({ query }) => useListLoad(query), { initialProps: { query: first } })
    rerender({ query: later })
    act(() => { result.current.retry() })
    expect(later.refetch).toHaveBeenCalledTimes(1)
    expect(first.refetch).not.toHaveBeenCalled()
  })
})
