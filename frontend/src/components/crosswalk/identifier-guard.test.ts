/**
 * #556b — the shared identifier/skip rejection used by BOTH the drag gestures
 * and the keyboard/dialog fallback. If this guard ever became drag-only, keyboard
 * users would be the only ones able to create the broken state it prevents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { toast } from 'sonner'

import {
  ineligibleColumns,
  rejectIneligibleAssignment,
  type GuardableColumn,
} from './identifier-guard'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const COLS: GuardableColumn[] = [
  { id: 1, column_type: 'ordinal', column_code: 'Q1', column_text: 'Satisfaction' },
  { id: 2, column_type: 'identifier', column_code: 'PID', column_text: 'Participant ID' },
  { id: 3, column_type: 'numeric', column_code: 'AGE', column_text: 'Age' },
  { id: 4, column_type: 'skip', column_code: 'X', column_text: 'Ignored' },
]
const byId = new Map(COLS.map(c => [c.id, c]))

beforeEach(() => vi.clearAllMocks())

describe('ineligibleColumns', () => {
  it('finds identifier and skip columns', () => {
    expect(ineligibleColumns([1, 2, 3, 4], byId).map(c => c.id)).toEqual([2, 4])
  })

  it('returns nothing for an all-measurement selection', () => {
    expect(ineligibleColumns([1, 3], byId)).toEqual([])
  })

  it('ignores ids that are not in the map', () => {
    expect(ineligibleColumns([99], byId)).toEqual([])
  })
})

describe('rejectIneligibleAssignment', () => {
  it('lets a clean selection through without a toast', () => {
    expect(rejectIneligibleAssignment([1, 3], byId)).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('rejects a single identifier column, naming it and saying why', () => {
    expect(rejectIneligibleAssignment([2], byId)).toBe(true)
    expect(toast.error).toHaveBeenCalledTimes(1)
    const [message, opts] = vi.mocked(toast.error).mock.calls[0]
    expect(message).toContain('PID')
    // The actionable half: identity vs measurement, and where to fix it.
    expect(opts?.description).toMatch(/identity/i)
    expect(opts?.description).toMatch(/Dataset View/i)
  })

  it('rejects a mixed multi-select, counting the offenders', () => {
    expect(rejectIneligibleAssignment([1, 2, 3], byId)).toBe(true)
    const [message] = vi.mocked(toast.error).mock.calls[0]
    expect(message).toContain('1 of 3')
  })

  it('a PARTIAL rejection says nothing moved (the gesture is atomic)', () => {
    // 2 of the 3 were eligible — but the whole drop is refused, so the copy has
    // to say so or the user assumes those two landed.
    rejectIneligibleAssignment([1, 2, 3], byId)
    const [, opts] = vi.mocked(toast.error).mock.calls[0]
    expect(opts?.description).toContain('nothing was moved')
    expect(opts?.description).toContain('PID')
  })

  it('an all-ineligible selection does NOT claim a partial move', () => {
    rejectIneligibleAssignment([2, 4], byId)
    const [, opts] = vi.mocked(toast.error).mock.calls[0]
    expect(opts?.description).not.toContain('nothing was moved')
  })

  it('flashes the first offending column so the eye lands on it', () => {
    const flash = vi.fn()
    rejectIneligibleAssignment([1, 2, 3], byId, flash)
    expect(flash).toHaveBeenCalledWith(2)
  })

  it('does not flash when the selection is clean', () => {
    const flash = vi.fn()
    rejectIneligibleAssignment([1, 3], byId, flash)
    expect(flash).not.toHaveBeenCalled()
  })

  it('uses skip-specific copy when the offender is a skip column', () => {
    expect(rejectIneligibleAssignment([4], byId)).toBe(true)
    const [, opts] = vi.mocked(toast.error).mock.calls[0]
    expect(opts?.description).toMatch(/Skipped columns/i)
  })

  it('NEVER passes a reusable toast id — a repeat rejection must not be swallowed', () => {
    // Live-found in Batch 4: with a fixed `id`, a second rejection later in the
    // same session rendered NOTHING (sonner treated it as an update to the
    // retired toast) — the refusal went silent, which is worse than the state
    // the guard prevents. Every rejection must surface its own toast.
    rejectIneligibleAssignment([2], byId)
    rejectIneligibleAssignment([2], byId)
    expect(toast.error).toHaveBeenCalledTimes(2)
    for (const [, opts] of vi.mocked(toast.error).mock.calls) {
      expect(opts?.id).toBeUndefined()
    }
  })
})
