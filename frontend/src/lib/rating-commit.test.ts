/**
 * `lib/rating-commit.ts` — the ONE place a rating's endpoint is chosen, and the
 * ONE derivation of a rating target's identity (#35 variant B).
 *
 * A segment rating is path-keyed (`PATCH /segments/{id}/codes/{id}/magnitude`);
 * a dataset-cell rating is BODY-keyed on a different router. The sweep is the
 * first surface whose queue spans both, so the branch exists exactly once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RatingQueueEntry } from '@/lib/api/coding'

const setMagnitude = vi.fn()
const setTextMagnitude = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    codingApi: { ...actual.codingApi, setMagnitude: (...a: unknown[]) => setMagnitude(...a) },
    textCodingApi: { ...actual.textCodingApi, setMagnitude: (...a: unknown[]) => setTextMagnitude(...a) },
  }
})

import { commitRating, entryKey } from './rating-commit'

const SCALE = { min: -1, max: 1, step: 0.5, anchors: [] }

const entry = (over: Partial<RatingQueueEntry> = {}): RatingQueueEntry => ({
  code_id: 7, code_name: 'District support', code_color: null, scale: SCALE,
  target_kind: 'segment', segment_id: 51, dataset_value_id: null,
  source_type: 'conversation', source_id: 3, source_label: 'Interview one',
  text: 'x', start_time: null, end_time: null, record_identifier: null, n_targets: 1,
  ...over,
})

const cell = () => entry({
  target_kind: 'dataset_value', segment_id: null, dataset_value_id: 88,
  source_type: 'column', source_label: 'Staff survey › changed',
})

beforeEach(() => {
  setMagnitude.mockReset().mockResolvedValue({})
  setTextMagnitude.mockReset().mockResolvedValue({})
})

describe('commitRating — one branch, two endpoints', () => {
  it('a segment goes to the path-keyed endpoint', async () => {
    await commitRating(1, entry(), 0.5)
    expect(setMagnitude).toHaveBeenCalledWith(51, 7, 0.5)
    expect(setTextMagnitude).not.toHaveBeenCalled()
  })

  it('a dataset cell goes to the body-keyed one', async () => {
    await commitRating(1, cell(), 0.5)
    expect(setTextMagnitude).toHaveBeenCalledWith(
      1, { dataset_value_id: 88, code_id: 7, magnitude: 0.5 },
    )
    expect(setMagnitude).not.toHaveBeenCalled()
  })

  it('🔴 sends a rating of ZERO, which is a judgement and not an absence', async () => {
    await commitRating(1, entry(), 0)
    expect(setMagnitude).toHaveBeenCalledWith(51, 7, 0)
  })

  it('🔴 sends `null` as null — an explicit UNRATE, never an omitted key', async () => {
    // Both endpoints distinguish "field absent" (leave the rating alone) from
    // "field null" (clear it), so dropping the key turns a clear into a no-op.
    await commitRating(1, entry(), null)
    expect(setMagnitude).toHaveBeenCalledWith(51, 7, null)
    await commitRating(1, cell(), null)
    expect(setTextMagnitude).toHaveBeenCalledWith(
      1, { dataset_value_id: 88, code_id: 7, magnitude: null },
    )
  })

  it('refuses an entry whose target id is missing rather than calling with null', () => {
    // The server would answer 404/422; failing here says which entry is broken.
    expect(() => commitRating(1, entry({ segment_id: null }), 1)).toThrow(/segment_id/)
    expect(() => commitRating(1, entry({ target_kind: 'dataset_value', dataset_value_id: null }), 1))
      .toThrow(/dataset_value_id/)
  })
})

describe('entryKey — the identity a strip mount is keyed on (#870 c)', () => {
  it('names the UNIT and the CODE, which is what the mount rule requires', () => {
    // `magnitude-strip-mounts.test.ts` accepts `entryKey(...)` in place of a
    // literal `${segmentId}-${code.id}` template; this is the contract that
    // makes that acceptance safe.
    const key = entryKey(entry())
    expect(key).toContain('51')
    expect(key).toContain('7')
  })

  it('a segment and a dataset cell with the SAME id do not collide', () => {
    // Two different id spaces. A key that dropped the kind would remount
    // neither when the sweep stepped from one to the other.
    expect(entryKey(entry({ segment_id: 88 }))).not.toBe(entryKey(cell()))
  })

  it('the same target under two codes gives two keys', () => {
    // The sweep walks many targets carrying one code AND one target carrying
    // several, so both halves of the pair are load-bearing.
    expect(entryKey(entry())).not.toBe(entryKey(entry({ code_id: 9 })))
  })

  it('is stable for the same entry', () => {
    expect(entryKey(entry())).toBe(entryKey(entry()))
  })
})
