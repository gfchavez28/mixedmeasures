/**
 * #1028 — the undo of an APPLY puts back what the apply replaced, and removes
 * the code only where the act put it.
 *
 * ⚠️ The fixtures carry a rating of ZERO on purpose (a truthiness slip drops it)
 * and a target that ALREADY held the code (the multi-passage undo used to strip
 * it from there too). Targets and codes have non-contiguous ids so a
 * positional implementation cannot pass.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/client'
import type { SelectionDetail } from '@/lib/code-sets'

const toastWarning = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { warning: toastWarning, error: vi.fn(), success: vi.fn() } }))

import {
  captureApply, captureRemove, mergeReplaced, planApplyUndo, replacedFromBulk, replacedFromSingle,
  runApplyUndo, runRemoveUndo, type ApplyUndoApi,
} from './apply-undo'

const SELF = 5
const COLLEAGUE = 9
const POSITIVE = 11
const NEGATIVE = 23
const NEUTRAL = 47

const d = (code_id: number, magnitude: number | null = null, user_id: number | null = SELF): SelectionDetail =>
  ({ code_id, user_id, magnitude })

afterEach(() => vi.clearAllMocks())

describe('what an apply entry captures when it is BUILT', () => {
  const details: Record<number, SelectionDetail[]> = {
    301: [d(NEGATIVE, 0)],
    305: [d(POSITIVE, 2)],
    309: [d(POSITIVE, 1, COLLEAGUE)],
  }
  const capture = captureApply(POSITIVE, [301, 305, 309], (id) => details[id], SELF)

  it('knows which targets ALREADY held the code — this coder’s, never a colleague’s', () => {
    expect([...capture.alreadyHeld]).toEqual([305])
  })

  it('keeps this coder’s ratings, and 0 is a rating', () => {
    expect(capture.ratings.get(301)?.get(NEGATIVE)).toBe(0)
    expect(capture.ratings.get(309)?.has(POSITIVE)).toBe(false)
  })
})

describe('what the server replaced', () => {
  it('reads a single response, and nothing replaced is an empty map', () => {
    expect([...replacedFromSingle(301, { replaced_code_ids: [NEGATIVE] })]).toEqual([[301, [NEGATIVE]]])
    expect(replacedFromSingle(301, { replaced_code_ids: [] }).size).toBe(0)
    expect(replacedFromSingle(301, undefined).size).toBe(0)
  })

  it('reads a bulk response per target, for segments and responses alike', () => {
    const segs = replacedFromBulk({ results: [
      { segment_id: 301, replaced_code_ids: [NEGATIVE] },
      { segment_id: 305, replaced_code_ids: [] },
    ] })
    expect([...segs]).toEqual([[301, [NEGATIVE]]])
    const cells = replacedFromBulk({ results: [{ dataset_value_id: 701, replaced_code_ids: [NEUTRAL] }] })
    expect([...cells]).toEqual([[701, [NEUTRAL]]])
  })

  it('folds the multi-code apply’s responses', () => {
    const folded = mergeReplaced([new Map([[301, [NEGATIVE]]]), new Map([[301, [NEUTRAL]], [305, [NEGATIVE]]])])
    expect([...folded]).toEqual([[301, [NEGATIVE, NEUTRAL]], [305, [NEGATIVE]]])
  })
})

describe('the plan', () => {
  const details: Record<number, SelectionDetail[]> = {
    301: [d(NEGATIVE, 0)],            // held another value, rated ZERO
    303: [],                          // held nothing
    305: [d(POSITIVE, 2)],            // already held the code applied
    307: [d(NEGATIVE, 1), d(NEUTRAL)], // a contradiction the apply resolved
  }
  const capture = captureApply(POSITIVE, [301, 303, 305, 307], (id) => details[id], SELF)
  const replaced = new Map([[301, [NEGATIVE]], [307, [NEGATIVE, NEUTRAL]]])
  const plan = planApplyUndo(capture, replaced)

  it('puts back the replaced value WITH its rating — 0 included', () => {
    expect(plan.restore).toContainEqual({ targetId: 301, codeId: NEGATIVE, magnitude: 0 })
  })

  it('removes the code only where the act put it', () => {
    expect(plan.removeFrom).toEqual([303])
  })

  it('never touches a target that already held the code', () => {
    expect(plan.removeFrom).not.toContain(305)
    expect(plan.restore.map((r) => r.targetId)).not.toContain(305)
  })

  it('gives a contradiction ONE value back — the stated residual', () => {
    expect(plan.restore.filter((r) => r.targetId === 307)).toEqual([
      { targetId: 307, codeId: NEGATIVE, magnitude: 1 },
    ])
  })
})

function fakeApi(over: Partial<Record<keyof ApplyUndoApi, ReturnType<typeof vi.fn>>> = {}) {
  const calls: string[] = []
  const api = {
    remove: over.remove ?? vi.fn(async (ids: number[], code: number) => { calls.push(`remove ${code} ${ids}`) }),
    reapply: over.reapply ?? vi.fn(async (ids: number[], code: number) => { calls.push(`reapply ${code} ${ids}`) }),
    rate: over.rate ?? vi.fn(async (id: number, code: number, m: number) => { calls.push(`rate ${code} ${id} ${m}`) }),
  }
  return { api: api as unknown as ApplyUndoApi, calls }
}

describe('running the plan', () => {
  const plan = {
    codeId: POSITIVE,
    removeFrom: [303],
    restore: [
      { targetId: 301, codeId: NEGATIVE, magnitude: 0 },
      { targetId: 311, codeId: NEGATIVE, magnitude: null },
      { targetId: 313, codeId: NEUTRAL, magnitude: 4 },
    ],
  }

  it('re-applies each replaced value in ONE call per value, then removes, then re-rates', async () => {
    const { api, calls } = fakeApi()
    await runApplyUndo(plan, api, () => 'code')
    expect(calls).toEqual([
      `reapply ${NEGATIVE} 301,311`,
      `reapply ${NEUTRAL} 313`,
      `remove ${POSITIVE} 303`,
      `rate ${NEGATIVE} 301 0`,
      `rate ${NEUTRAL} 313 4`,
    ])
  })

  it('a REFUSED rating completes the undo and says which half did not land', async () => {
    const refusal = new ApiError(400, { detail: 'outside the scale' }, {})
    const { api, calls } = fakeApi({ rate: vi.fn(async () => { throw refusal }) })
    await expect(runApplyUndo({ ...plan, restore: [plan.restore[0]] }, api, () => 'Negative'))
      .resolves.toBeUndefined()
    expect(calls).toEqual([`reapply ${NEGATIVE} 301`, `remove ${POSITIVE} 303`])
    expect(toastWarning).toHaveBeenCalledWith(
      '“Negative” is back, but its rating (0) could not be restored.',
      { description: 'outside the scale' },
    )
  })

  it('a TRANSIENT rating failure throws, so the history keeps the step', async () => {
    const { api } = fakeApi({ rate: vi.fn(async () => { throw new Error('network') }) })
    await expect(runApplyUndo(plan, api, () => 'code')).rejects.toThrow('network')
    expect(toastWarning).not.toHaveBeenCalled()
  })
})


/**
 * #1070 — a single act on a segment GROUP fans out to every sibling, and the
 * siblings routinely hold different codings. The workbench captures over the
 * group and undoes through the BULK door; these pin the plan it runs.
 * The audit's two cases: X is the sibling, Y the pressed segment.
 */
describe('a single act on a segment GROUP (#1070)', () => {
  const X = 1100
  const Y = 1101

  it('reads the per-segment report when the server sends one', () => {
    const replaced = replacedFromSingle(Y, {
      replaced_code_ids: [POSITIVE],
      replaced_by_target: [{ segment_id: X, replaced_code_ids: [POSITIVE] }],
    })
    // The merged list is NOT pinned on the pressed segment, which lost nothing.
    expect([...replaced]).toEqual([[X, [POSITIVE]]])
  })

  it('(a) a sibling’s EARLIER coding is not removed by the undo', async () => {
    const details: Record<number, SelectionDetail[]> = { [X]: [d(NEUTRAL)], [Y]: [] }
    const capture = captureApply(NEUTRAL, [Y, X], (id) => details[id], SELF)
    const plan = planApplyUndo(capture, replacedFromSingle(Y, { replaced_code_ids: [], replaced_by_target: [] }))
    const { api, calls } = fakeApi()
    await runApplyUndo(plan, api, () => 'code')
    expect(calls).toEqual([`remove ${NEUTRAL} ${Y}`])
  })

  it('(b) each sibling gets back ITS OWN value and rating — never a value it never had', async () => {
    const details: Record<number, SelectionDetail[]> = { [X]: [d(POSITIVE, 0)], [Y]: [] }
    const capture = captureApply(NEGATIVE, [Y, X], (id) => details[id], SELF)
    const plan = planApplyUndo(capture, replacedFromSingle(Y, {
      replaced_code_ids: [POSITIVE],
      replaced_by_target: [{ segment_id: X, replaced_code_ids: [POSITIVE] }],
    }))
    const { api, calls } = fakeApi()
    await runApplyUndo(plan, api, () => 'code')
    expect(calls).toEqual([
      `reapply ${POSITIVE} ${X}`,
      `remove ${NEGATIVE} ${Y}`,
      `rate ${POSITIVE} ${X} 0`,
    ])
  })
})

describe('undoing a REMOVE that fanned out to a group (#1070)', () => {
  it('captures which siblings held the code, and their ratings — this coder’s only', () => {
    const details: Record<number, SelectionDetail[]> = {
      1201: [d(POSITIVE, 0)],
      1203: [d(POSITIVE, 2, COLLEAGUE)],
      1207: [d(NEGATIVE)],
    }
    const capture = captureRemove(POSITIVE, [1201, 1203, 1207], (id) => details[id], SELF)
    expect(capture.held).toEqual([{ targetId: 1201, magnitude: 0 }])
  })

  it('re-applies to exactly the siblings that held it, then re-rates each', async () => {
    const { api, calls } = fakeApi()
    await runRemoveUndo(
      { codeId: POSITIVE, held: [{ targetId: 1201, magnitude: 0 }, { targetId: 1209, magnitude: null }] },
      api, () => 'code',
    )
    expect(calls).toEqual([`reapply ${POSITIVE} 1201,1209`, `rate ${POSITIVE} 1201 0`])
  })

  it('a sibling that never held the code is not given it', async () => {
    const { api, calls } = fakeApi()
    await runRemoveUndo({ codeId: POSITIVE, held: [] }, api, () => 'code')
    expect(calls).toEqual([])
  })
})
