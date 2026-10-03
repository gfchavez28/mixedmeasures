/**
 * #1070 — a code-set choice on a GROUPED segment fans out to the whole group
 * (the selection endpoint passes the group's ids to `apply_selection`), and the
 * members routinely held DIFFERENT values before. The one-target undo re-selected
 * the pressed segment's previous value, so every member came back holding it.
 * With `groupSiblings` the undo gives each member back its own — through the bulk
 * door, which acts on exactly the segment it is given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CodeSet, CodeSetMember } from '@/lib/api'
import type { SelectionDetail } from '@/lib/code-sets'
import { useEffect } from 'react'

const api = vi.hoisted(() => ({
  listSets: vi.fn(),
  selectOnSegment: vi.fn(),
  bulkCode: vi.fn(),
  setMagnitude: vi.fn(),
  applyCode: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    codeSetsApi: {
      list: (...a: unknown[]) => api.listSets(...a),
      selectOnSegment: (...a: unknown[]) => api.selectOnSegment(...a),
    },
    codingApi: {
      bulkCode: (...a: unknown[]) => api.bulkCode(...a),
      setMagnitude: (...a: unknown[]) => api.setMagnitude(...a),
      applyCode: (...a: unknown[]) => api.applyCode(...a),
    },
  }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }))

import { CodeSetStrip, type GroupMember } from './CodeSetStrip'
import { useHistory } from '@/hooks/useHistory'

const SELF = 5
const POSITIVE = 11
const NEGATIVE = 23
const NEUTRAL = 47
const X = 61  // the sibling
const Y = 62  // the pressed segment

const member = (id: number, name: string): CodeSetMember => ({
  id, numeric_id: id, name, description: null, color: null, is_active: true, is_universal: false,
})
const STANCE: CodeSet = {
  id: 7, project_id: 1, label: 'Stance', description: null, exhaustive: false,
  members: [member(POSITIVE, 'Positive'), member(NEGATIVE, 'Negative'), member(NEUTRAL, 'Neutral')],
  set_basis: 'inclusive_with_none', composition_warnings: [],
  claimants: [POSITIVE, NEGATIVE, NEUTRAL].map((id) => ({ code_id: id, value_id: id })),
  created_at: '', updated_at: '',
}
const LIVE = STANCE.members.map(({ id, name }) => ({ id, name, is_active: true, is_universal: false }))
const held = (code_id: number, magnitude: number | null = null): SelectionDetail =>
  ({ code_id, user_id: SELF, magnitude })

let history!: ReturnType<typeof useHistory>

function Host({ yDetails, siblings }: { yDetails: SelectionDetail[]; siblings: GroupMember[] }) {
  const stack = useHistory()
  // Exposed after every commit, the sibling file's pattern: `act` flushes it.
  useEffect(() => { history = stack }, [stack])
  return (
    <CodeSetStrip
      projectId={1}
      target={{ kind: 'segment', segmentId: Y }}
      appliedCodeDetails={yDetails}
      activeCoderId={SELF}
      codes={LIVE}
      history={stack}
      groupSiblings={siblings}
    />
  )
}

function renderHost(yDetails: SelectionDetail[], siblings: GroupMember[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}><Host yDetails={yDetails} siblings={siblings} /></QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listSets.mockResolvedValue({ sets: [STANCE] })
  api.selectOnSegment.mockResolvedValue({ set_id: 7, code_id: NEGATIVE, removed: 1 })
  api.bulkCode.mockResolvedValue({ results: [], success_count: 1, error_count: 0, failed_segment_ids: [] })
  api.setMagnitude.mockResolvedValue({ applied: true })
})
afterEach(cleanup)

describe('a choice on a grouped segment, undone (#1070)', () => {
  it('gives each member back its OWN value and rating, never the pressed one’s', async () => {
    // X held Positive rated 0; Y held Neutral. Choosing Negative on Y fans out.
    renderHost([held(NEUTRAL)], [{ segmentId: X, appliedCodeDetails: [held(POSITIVE, 0)] }])
    fireEvent.click(await screen.findByRole('radio', { name: /Negative/ }))
    await waitFor(() => expect(api.selectOnSegment).toHaveBeenCalledWith(Y, 7, NEGATIVE))
    await waitFor(() => expect(history.canUndo).toBe(true))

    await act(async () => { await history.undo() })

    expect(api.bulkCode).toHaveBeenCalledWith([Y], NEUTRAL, 'apply')
    expect(api.bulkCode).toHaveBeenCalledWith([X], POSITIVE, 'apply')
    expect(api.setMagnitude).toHaveBeenCalledWith(X, POSITIVE, 0)
    // The one-target undo re-selected Neutral across the whole group.
    expect(api.selectOnSegment).toHaveBeenCalledTimes(1)
  })

  it('a member that held NO value has the choice removed; one that held it is left alone', async () => {
    const Z = 63
    renderHost([held(NEUTRAL)], [
      { segmentId: X, appliedCodeDetails: [] },
      { segmentId: Z, appliedCodeDetails: [held(NEGATIVE)] },
    ])
    fireEvent.click(await screen.findByRole('radio', { name: /Negative/ }))
    await waitFor(() => expect(history.canUndo).toBe(true))

    await act(async () => { await history.undo() })

    expect(api.bulkCode).toHaveBeenCalledWith([Y], NEUTRAL, 'apply')
    expect(api.bulkCode).toHaveBeenCalledWith([X], NEGATIVE, 'remove')
    expect(api.bulkCode).not.toHaveBeenCalledWith([Z], expect.anything(), expect.anything())
    expect(api.bulkCode).toHaveBeenCalledTimes(2)
  })

  it('CONTROL — with no group the undo is the one-target re-selection, as before', async () => {
    renderHost([held(NEUTRAL)], [])
    fireEvent.click(await screen.findByRole('radio', { name: /Negative/ }))
    await waitFor(() => expect(history.canUndo).toBe(true))
    await act(async () => { await history.undo() })
    expect(api.selectOnSegment).toHaveBeenLastCalledWith(Y, 7, NEUTRAL)
    expect(api.bulkCode).not.toHaveBeenCalled()
  })
})
