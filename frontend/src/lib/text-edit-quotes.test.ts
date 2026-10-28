/**
 * #1319 — the client's half of a text edit that carries its quotes.
 *
 * The answers turn the D5 choice (keep as shown / remove) and an undo's captured
 * facts into what the server checks; the entry captures the act's own report so
 * undo is EXACT (the planner alone would put a quote back one letter short) and
 * redo replays the act. Every replay case here runs against a door bound to ONE
 * passage, because a stack outlives the selection (#1023).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { TextEditPlan, TextEditQuote } from '@/lib/api/segments'
import { useHistory } from '@/hooks/useHistory'
import {
  buildTextEditEntry,
  canKeepAsShown,
  flaggedQuotes,
  keepAsShownAnswer,
  redoAnswer,
  removeFlaggedAnswer,
  undoAnswer,
  type TextEditDoor,
} from './text-edit-quotes'

const toastWarning = vi.fn()
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    warning: (...a: unknown[]) => toastWarning(...a),
    error: vi.fn(),
    info: vi.fn(),
  }),
}))

const quote = (over: Partial<TextEditQuote>): TextEditQuote => ({
  excerpt_id: 1, outcome: 'silent', old_start: 0, old_end: 5, new_start: 0, new_end: 5,
  old_text: 'alpha', new_text: 'alpha', has_note: false, removed: false, explicit: false,
  ...over,
})

const plan = (quotes: TextEditQuote[], extra: Partial<TextEditPlan> = {}): TextEditPlan => ({
  text: 'new text', quotes, needs_confirmation: quotes.some(q => q.outcome !== 'silent'),
  collisions: [], capped: false, ...extra,
})

const SILENT = quote({ excerpt_id: 1, outcome: 'silent', old_start: 0, old_end: 5, new_start: 4, new_end: 9 })
const EDGE = quote({ excerpt_id: 2, outcome: 'edge', old_start: 7, old_end: 19, new_start: 11, new_end: 22 })
const STRADDLE = quote({ excerpt_id: 3, outcome: 'straddle', old_start: 20, old_end: 30, new_start: 23, new_end: 35 })
const GONE = quote({ excerpt_id: 4, outcome: 'gone', old_start: 31, old_end: 40, new_start: null, new_end: null, new_text: null })

describe('the answers a save sends', () => {
  it('lists only the edge, straddle and gone quotes as flagged', () => {
    expect(flaggedQuotes(plan([SILENT, EDGE, STRADDLE, GONE])).map(q => q.excerpt_id)).toEqual([2, 3, 4])
  })

  it('keep as shown places each edge/straddle quote at the span it was shown and removes the gone one', () => {
    expect(keepAsShownAnswer(plan([SILENT, EDGE, STRADDLE, GONE]))).toEqual({
      excerpt_offsets: [
        { excerpt_id: 2, start_offset: 11, end_offset: 22 },
        { excerpt_id: 3, start_offset: 23, end_offset: 35 },
      ],
      remove_excerpt_ids: [4],
    })
  })

  it('remove names every flagged quote and leaves the silent one to the planner', () => {
    expect(removeFlaggedAnswer(plan([SILENT, EDGE, STRADDLE, GONE]))).toEqual({
      remove_excerpt_ids: [2, 3, 4], excerpt_offsets: [],
    })
  })

  it('keep as shown is offered only when something can be kept and nothing collides', () => {
    expect(canKeepAsShown(plan([EDGE]))).toBe(true)
    expect(canKeepAsShown(plan([GONE]))).toBe(false)
    expect(canKeepAsShown(plan([EDGE], { collisions: [[1, 2]] }))).toBe(false)
  })

  it('undo puts every KEPT quote on its pre-edit offsets; redo on its post-edit ones', () => {
    const report = plan([SILENT, { ...EDGE, explicit: true }, { ...GONE, removed: true }])
    expect(undoAnswer(report)).toEqual({
      excerpt_offsets: [
        { excerpt_id: 1, start_offset: 0, end_offset: 5 },
        { excerpt_id: 2, start_offset: 7, end_offset: 19 },
      ],
      remove_excerpt_ids: [],
    })
    expect(redoAnswer(report, [77])).toEqual({
      excerpt_offsets: [
        { excerpt_id: 1, start_offset: 4, end_offset: 9 },
        { excerpt_id: 2, start_offset: 11, end_offset: 22 },
      ],
      remove_excerpt_ids: [77],
    })
  })
})

function fakeDoor(segmentId: number, report: TextEditPlan, recreatedId = 900) {
  const calls: { segmentId: number; text: string; answer: unknown }[] = []
  const recreate = vi.fn<(q: TextEditQuote) => Promise<number>>(async () => recreatedId)
  const apply = vi.fn<TextEditDoor['apply']>(async (text, answer) => {
    calls.push({ segmentId, text, answer })
    return report
  })
  const door: TextEditDoor & { calls: typeof calls; recreate: typeof recreate; applyMock: typeof apply } = {
    calls,
    recreate,
    applyMock: apply,
    preview: vi.fn(),
    apply,
    recreateQuote: (q) => recreate(q),
    refresh: vi.fn(),
  }
  return door
}

const last = <T,>(xs: T[]): T => xs[xs.length - 1]

describe('the history entry (captured at the act, #1023)', () => {
  beforeEach(() => { toastWarning.mockReset() })

  it('act → move to another passage → undo restores THIS passage on its captured offsets; redo replays the act', async () => {
    const report = plan([SILENT, { ...EDGE, explicit: true }, { ...GONE, removed: true }])
    const doorA = fakeDoor(51, report, 900)
    const { result } = renderHook(() => useHistory())

    let applied = false
    await act(async () => {
      await result.current.execute(buildTextEditEntry({
        door: doorA, oldText: 'OLD', newText: 'NEW',
        firstAnswer: { excerpt_offsets: [{ excerpt_id: 2, start_offset: 11, end_offset: 22 }], remove_excerpt_ids: [4] },
        onApplied: () => { applied = true },
      }))
    })
    expect(applied).toBe(true)
    expect(doorA.calls[0]).toEqual({
      segmentId: 51, text: 'NEW',
      answer: { excerpt_offsets: [{ excerpt_id: 2, start_offset: 11, end_offset: 22 }], remove_excerpt_ids: [4] },
    })

    // The researcher moves on and edits ANOTHER passage through another door.
    const doorB = fakeDoor(52, plan([]))
    await act(async () => {
      await result.current.execute(buildTextEditEntry({
        door: doorB, oldText: 'b-old', newText: 'b-new', firstAnswer: {},
      }))
    })
    await act(async () => { await result.current.undo() })   // undoes B
    expect(last(doorB.calls)).toMatchObject({ segmentId: 52, text: 'b-old' })

    await act(async () => { await result.current.undo() })   // undoes A — on A
    expect(last(doorA.calls)).toEqual({
      segmentId: 51, text: 'OLD',
      answer: undoAnswer(report),
    })
    expect(doorA.recreate).toHaveBeenCalledTimes(1)
    expect(doorA.recreate.mock.calls[0][0]).toMatchObject({ excerpt_id: 4, old_start: 31, old_end: 40 })

    await act(async () => { await result.current.redo() })
    expect(last(doorA.calls)).toEqual({
      segmentId: 51, text: 'NEW',
      answer: redoAnswer(report, [900]),
    })
  })

  it('a REFUSED re-creation finishes the undo and says so; the step leaves for redo', async () => {
    const report = plan([{ ...GONE, removed: true }])
    const door = fakeDoor(51, report)
    door.recreate.mockRejectedValue(Object.assign(new Error('dup'), { status: 409 }))
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      await result.current.execute(buildTextEditEntry({ door, oldText: 'OLD', newText: 'NEW', firstAnswer: { remove_excerpt_ids: [4] } }))
    })
    await act(async () => { await result.current.undo() })
    expect(toastWarning).toHaveBeenCalledWith('The text was restored, but one removed quote could not be put back.')
    expect(result.current.canRedo).toBe(true)
  })

  it('a TRANSIENT re-creation failure keeps the step, and the retry skips nothing it already did', async () => {
    const two = plan([{ ...GONE, removed: true }, { ...GONE, excerpt_id: 5, removed: true }])
    const door = fakeDoor(51, two)
    door.recreate
      .mockResolvedValueOnce(901)                       // quote 4 comes back
      .mockRejectedValueOnce(new TypeError('offline'))  // quote 5 does not, yet
      .mockResolvedValueOnce(902)
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      await result.current.execute(buildTextEditEntry({ door, oldText: 'OLD', newText: 'NEW', firstAnswer: { remove_excerpt_ids: [4, 5] } }))
    })
    await act(async () => { await result.current.undo() })
    expect(result.current.canUndo).toBe(true)          // kept for a retry
    await act(async () => { await result.current.undo() })
    expect(door.recreate).toHaveBeenCalledTimes(3)     // 4 once, 5 twice
    expect(door.recreate.mock.calls.map(c => c[0].excerpt_id)).toEqual([4, 5, 5])
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('a failed act is not "saved" and leaves nothing to undo', async () => {
    const door = fakeDoor(51, plan([]))
    door.applyMock.mockRejectedValue(
      Object.assign(new Error('refused'), { status: 409 }),
    )
    const { result } = renderHook(() => useHistory())
    let applied = false
    await act(async () => {
      await result.current.execute(buildTextEditEntry({
        door, oldText: 'OLD', newText: 'NEW', firstAnswer: {}, onApplied: () => { applied = true },
      }))
    })
    expect(applied).toBe(false)
    expect(result.current.canUndo).toBe(false)
  })
})
