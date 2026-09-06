/**
 * `useHistory` — a failed action toasts the SERVER'S reason when it gave one.
 *
 * Every refusal the backend writes is guidance ("Restore it before rating it";
 * "3 existing ratings would fall outside the new range…"). The hook used to
 * toast a bare "Action failed" over it, which threw the guidance away — found
 * while mounting the rating strip on the document workbench (#868 b), where a
 * refused rating read as a broken save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

import { useHistory, type HistoryAction } from './useHistory'

beforeEach(() => toastError.mockClear())

/**
 * A thrown API error. `status` is OMITTED unless given, which is the shape a
 * network drop or a timeout has — and #874 treats a status-less error as
 * transient, so every pre-existing case below keeps its original meaning.
 */
const refusal = (detail: unknown, status?: number) =>
  Object.assign(new Error(`HTTP ${status ?? 400}`), { status, response: { data: { detail } } })

/** A history action that resolves, recording its name in `log`. */
const recorded = (log: string[], name: string, over: Partial<HistoryAction> = {}): HistoryAction => ({
  type: 'code_apply',
  description: name,
  redo: async () => { log.push(`redo:${name}`) },
  undo: async () => { log.push(`undo:${name}`) },
  ...over,
})

describe('useHistory — failure toasts', () => {
  it('a refused action toasts the server detail verbatim, and records no entry', async () => {
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      await result.current.execute({
        type: 'code_apply',
        description: 'Rate "Joy"',
        redo: () => Promise.reject(refusal('“Joy” is inactive. Restore it before rating it.')),
        undo: () => Promise.resolve(),
      })
    })
    expect(toastError).toHaveBeenCalledWith('“Joy” is inactive. Restore it before rating it.')
    expect(result.current.canUndo).toBe(false)
  })

  it('an error with no server detail keeps the generic wording', async () => {
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      await result.current.execute({
        type: 'code_apply', description: 'x',
        redo: () => Promise.reject(new Error('network down')),
        undo: () => Promise.resolve(),
      })
    })
    expect(toastError).toHaveBeenCalledWith('Action failed')
  })

  // ── #871: the other two detail shapes ────────────────────────────────────
  //
  // This block used to assert the OPPOSITE — that a non-string detail falls
  // back — on the reasoning that "[object Object]" is worse than generic
  // wording. That reasoning is right and its conclusion was wrong: the answer
  // is to read the field the object carries. Measured live on the Variables
  // view before the fix: changing the type of a variable that has a recode rule
  // toasted "Action failed" over the server's own sentence.

  it('a 422 validation detail (a LIST) shows the message, not the fallback', async () => {
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      await result.current.execute({
        type: 'segment_edit', description: 'x',
        // schemas/segment.py:12-16 — `text must not be empty`, raised in a
        // field_validator, so FastAPI wraps it "Value error, …" in a list.
        redo: () => Promise.reject(refusal([
          { loc: ['body', 'text'], msg: 'Value error, text must not be empty', type: 'value_error' },
        ])),
        undo: () => Promise.resolve(),
      })
    })
    expect(toastError).toHaveBeenCalledWith('text must not be empty')
  })

  it('a structured 409 detail (an OBJECT) shows its message — the #871 repro', async () => {
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      await result.current.execute({
        type: 'column_type_change', description: 'Change type to ordinal',
        // routers/recode.py:1423-1431, verbatim.
        redo: () => Promise.reject(refusal({
          error: 'recode_definitions_exist',
          message: 'Cannot change type: columns have recode definitions.',
          column_ids: [8],
          recode_counts: { '8': 1 },
        })),
        undo: () => Promise.resolve(),
      })
    })
    expect(toastError).toHaveBeenCalledWith('Cannot change type: columns have recode definitions.')
  })

  it('a detail shape with nothing sayable still falls back — never "[object Object]"', async () => {
    const { result } = renderHook(() => useHistory())
    for (const detail of [[], [{ loc: ['body'] }], { error: 'no_message' }, '   ']) {
      toastError.mockClear()
      await act(async () => {
        await result.current.execute({
          type: 'code_apply', description: 'x',
          redo: () => Promise.reject(refusal(detail)),
          undo: () => Promise.resolve(),
        })
      })
      expect(toastError).toHaveBeenCalledWith('Action failed')
    }
  })

  it('undo and redo carry the reason too', async () => {
    const { result } = renderHook(() => useHistory())
    let fail = false
    await act(async () => {
      await result.current.execute({
        type: 'code_remove', description: 'x',
        redo: () => Promise.resolve(),
        undo: () => (fail ? Promise.reject(refusal('Undo said why')) : Promise.resolve()),
      })
    })
    fail = true
    await act(async () => { await result.current.undo() })
    expect(toastError).toHaveBeenCalledWith('Undo said why')
  })
})

// ── #874: a refused undo must not park the pointer ─────────────────────────
//
// Driven live 2026-09-03 before the fix: apply a rated code → rate it → remove
// it by a door that is not in this stack (the chip's ×, #875) → Ctrl+Z. The
// server 404s "…nothing to rate", the pointer never moves, and THREE further
// presses reproduced the same refusal with `canUndo` still true and `canRedo`
// still false. Everything earlier in the session became unreachable.

describe('useHistory — a refused undo drops its entry (#874)', () => {
  const settled = (detail: string) => refusal(detail, 404)

  it('drops the refused entry, so the NEXT undo reaches the one before it', async () => {
    const log: string[] = []
    const { result } = renderHook(() => useHistory())
    await act(async () => { await result.current.execute(recorded(log, 'A')) })
    await act(async () => {
      await result.current.execute(recorded(log, 'B', {
        undo: () => Promise.reject(settled('You have not applied this code to this segment, so there is nothing to rate.')),
      }))
    })

    await act(async () => { await result.current.undo() })          // B refuses
    expect(toastError).toHaveBeenCalledWith(
      'You have not applied this code to this segment, so there is nothing to rate.',
      { description: expect.stringContaining('removed from the history') },
    )

    // The load-bearing assertion: the stack MOVED ON. Asserting only that
    // `canUndo` changed would pass on an implementation that cleared everything.
    await act(async () => { await result.current.undo() })
    expect(log).toEqual(['redo:A', 'redo:B', 'undo:A'])
    expect(result.current.canUndo).toBe(false)
  })

  it('does NOT offer redo for an entry whose undo was refused', async () => {
    const log: string[] = []
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      await result.current.execute(recorded(log, 'A', { undo: () => Promise.reject(settled('gone')) }))
    })
    await act(async () => { await result.current.undo() })
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)   // never pushed to `future`
  })

  it('a TRANSIENT failure keeps the entry, so the user can try again', async () => {
    const log: string[] = []
    let offline = true
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      await result.current.execute(recorded(log, 'A', {
        // No `status` — what `fetch` throws when the request never arrives.
        undo: () => (offline ? Promise.reject(new Error('Failed to fetch')) : (log.push('undo:A'), Promise.resolve())),
      }))
    })

    await act(async () => { await result.current.undo() })
    expect(toastError).toHaveBeenCalledWith('Undo failed')       // ONE argument: no consequence to report
    expect(result.current.canUndo).toBe(true)                    // still there to retry

    offline = false
    await act(async () => { await result.current.undo() })
    expect(log).toEqual(['redo:A', 'undo:A'])
    expect(result.current.canUndo).toBe(false)
  })

  it('a 5xx is transient and a 403 is retryable; a 409 is settled', async () => {
    for (const [status, kept] of [[500, true], [403, true], [429, true], [409, false], [422, false]] as const) {
      const { result } = renderHook(() => useHistory())
      await act(async () => {
        await result.current.execute({
          type: 'code_apply', description: 'x',
          redo: () => Promise.resolve(),
          undo: () => Promise.reject(refusal('nope', status)),
        })
      })
      await act(async () => { await result.current.undo() })
      expect(result.current.canUndo, `status ${status}`).toBe(kept)
    }
  })

  it('redo is the mirror — a settled refusal drops it off the future stack', async () => {
    const log: string[] = []
    let poisoned = false
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      await result.current.execute(recorded(log, 'A', {
        redo: async () => { if (poisoned) throw settled('cannot re-apply'); log.push('redo:A') },
      }))
    })
    await act(async () => { await result.current.undo() })
    expect(result.current.canRedo).toBe(true)

    poisoned = true
    await act(async () => { await result.current.redo() })
    expect(toastError).toHaveBeenCalledWith('cannot re-apply', {
      description: expect.stringContaining('removed from the history'),
    })
    expect(result.current.canRedo).toBe(false)
    expect(result.current.canUndo).toBe(false)
  })
})

// ── #877: actions are serialised, never dropped ────────────────────────────
//
// Measured live 2026-09-03 on document 1, segment 336: pressing `0` then `1`
// applied ONE universal code and discarded the other — no request, no toast,
// nothing. `execute` returned early whenever anything was in flight.

describe('useHistory — a second action queues rather than vanishing (#877)', () => {
  it('runs BOTH actions when the second is fired before the first settles', async () => {
    const log: string[] = []
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      const a = result.current.execute(recorded(log, 'A', {
        redo: () => new Promise(r => setTimeout(() => { log.push('redo:A'); r() }, 20)),
      }))
      const b = result.current.execute(recorded(log, 'B'))
      await Promise.all([a, b])
    })
    expect(log).toEqual(['redo:A', 'redo:B'])   // in order, and neither dropped
    expect(result.current.canUndo).toBe(true)
  })

  it('two quick undos reach two DIFFERENT entries — the stale-closure hazard', async () => {
    // 🔴 This is what makes the stacks refs rather than state. With `useState`,
    // the second `undo()` runs against a `past` React has not re-rendered, so it
    // would undo B twice and leave A applied forever.
    const log: string[] = []
    const { result } = renderHook(() => useHistory())
    await act(async () => { await result.current.execute(recorded(log, 'A')) })
    await act(async () => { await result.current.execute(recorded(log, 'B')) })

    await act(async () => {
      const first = result.current.undo()
      const second = result.current.undo()
      await Promise.all([first, second])
    })
    expect(log).toEqual(['redo:A', 'redo:B', 'undo:B', 'undo:A'])
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)
  })

  it('one failed action does not poison the queue for the next', async () => {
    const log: string[] = []
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      const a = result.current.execute({
        type: 'code_apply', description: 'A',
        redo: () => Promise.reject(refusal('refused', 409)),
        undo: () => Promise.resolve(),
      })
      const b = result.current.execute(recorded(log, 'B'))
      await Promise.all([a, b])
    })
    expect(log).toEqual(['redo:B'])
    expect(result.current.canUndo).toBe(true)
  })

  it('an undo queued behind an in-flight execute sees that action', async () => {
    // The ordering the old guard silently broke: Ctrl+Z during a slow save did
    // nothing at all, rather than undoing the save once it landed.
    const log: string[] = []
    const { result } = renderHook(() => useHistory())
    await act(async () => {
      const a = result.current.execute(recorded(log, 'A', {
        redo: () => new Promise(r => setTimeout(() => { log.push('redo:A'); r() }, 20)),
      }))
      const u = result.current.undo()
      await Promise.all([a, u])
    })
    expect(log).toEqual(['redo:A', 'undo:A'])
    expect(result.current.canUndo).toBe(false)
  })
})
