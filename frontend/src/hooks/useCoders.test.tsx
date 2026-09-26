/**
 * #964 — the roster says whether it has ANSWERED, and an import resets it.
 *
 * `coders` is `[]` both before the server answers and after the request fails,
 * which is the shape of a one-person roster — and a one-person roster turns
 * blind mode off. So consumers ask `status`, and anything that may have added
 * coders RESETS the roster rather than invalidating it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const listCoders = vi.fn()
vi.mock('@/lib/api', () => ({
  authApi: { listCoders: (...a: unknown[]) => listCoders(...a) },
}))

import { useCoders, resetCoderRoster, CODERS_QUERY_KEY } from './useCoders'

const ME = { id: 1, username: 'Me', display_color: null, archived: false }
const PRIYA = { id: 2, username: 'Priya', display_color: null, archived: false }

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return { qc, ...renderHook(() => useCoders(), { wrapper }) }
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

describe('useCoders — status', () => {
  it('is loading, with an empty roster that reads as single-coder, until the server answers', async () => {
    let answer!: (v: unknown) => void
    listCoders.mockReturnValue(new Promise(r => { answer = r }))
    const { result } = setup()
    expect(result.current.status).toBe('loading')
    expect(result.current.multiCoder).toBe(false) // the trap `status` exists for
    answer([ME, PRIYA])
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.multiCoder).toBe(true)
  })

  it('is failed — not ready — when the request fails', async () => {
    listCoders.mockRejectedValue(new Error('network'))
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(result.current.coders).toEqual([])
  })
})

describe('resetCoderRoster — after something may have added coders', () => {
  it('makes the roster honestly UNKNOWN until the new one answers', async () => {
    listCoders.mockResolvedValueOnce([ME])
    const { result, qc } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))

    let answer!: (v: unknown) => void
    listCoders.mockReturnValueOnce(new Promise(r => { answer = r }))
    act(() => { void resetCoderRoster(qc) })
    await waitFor(() => expect(result.current.status).toBe('loading'))

    answer([ME, PRIYA])
    await waitFor(() => expect(result.current.multiCoder).toBe(true))
  })

  it('counterfactual: an INVALIDATE keeps serving the one-coder roster as an answer while it refetches', async () => {
    // Why the call sites reset rather than invalidate — measured live, the stale
    // one-coder roster kept blind mode off in a just-imported project.
    listCoders.mockResolvedValueOnce([ME])
    const { result, qc } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))

    listCoders.mockReturnValueOnce(new Promise(() => {}))
    act(() => { void qc.invalidateQueries({ queryKey: CODERS_QUERY_KEY }) })
    await waitFor(() => expect(listCoders).toHaveBeenCalledTimes(2))
    expect(result.current.status).toBe('ready')
    expect(result.current.multiCoder).toBe(false)
  })
})

describe('#989 — the selectable subset', () => {
  it('excludes machine coders from the switcher list while keeping them on the roster', async () => {
    // The roster must KEEP the machine (its codings have to be attributable and
    // filterable); only the switcher list drops it. Driven live before this
    // existed: the TopRail menu offered "Code as GPT-4o" and the server 404'd.
    const MACHINE = { id: 9, username: 'GPT-4o', display_color: null, archived: false, coder_type: 'ai' }
    listCoders.mockResolvedValue([ME, PRIYA, MACHINE])
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.coders.map(c => c.id)).toEqual([1, 2, 9])
    expect(result.current.selectableCoders.map(c => c.id)).toEqual([1, 2])
    expect(result.current.machineCoders.map(c => c.id)).toEqual([9])
  })

  it('counts a machine for multiCoder and NOT for multiHumanCoder', async () => {
    // One person + one machine: attribution UI yes, reliability/blind no.
    const MACHINE = { id: 9, username: 'GPT-4o', display_color: null, archived: false, coder_type: 'ai' }
    listCoders.mockResolvedValue([ME, MACHINE])
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.multiCoder).toBe(true)
    expect(result.current.multiHumanCoder).toBe(false)
  })

  it('treats an UNKNOWN coder_type as a person, so it stays selectable', async () => {
    // The client's fail-closed direction is the opposite of the server's: an
    // unrecognised kind must not silently vanish from the switcher.
    const ODD = { id: 9, username: 'Odd', display_color: null, archived: false, coder_type: 'robot' }
    listCoders.mockResolvedValue([ME, ODD])
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.selectableCoders.map(c => c.id)).toEqual([1, 9])
    expect(result.current.multiHumanCoder).toBe(true)
  })
})
