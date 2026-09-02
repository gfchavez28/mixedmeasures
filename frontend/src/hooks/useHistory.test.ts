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

import { useHistory } from './useHistory'

beforeEach(() => toastError.mockClear())

const refusal = (detail: unknown) => Object.assign(new Error('HTTP 400'), { response: { data: { detail } } })

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
