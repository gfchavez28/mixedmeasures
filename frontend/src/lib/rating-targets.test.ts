import { describe, it, expect } from 'vitest'
import { ratableCodes } from './rating-targets'
import type { Code } from '@/lib/api'

const scale = { min: 0, max: 10, step: 1, anchors: [] } as unknown as Code['magnitude_scale']

const code = (over: Partial<Code> & { id: number }): Code => ({
  name: `Code ${over.id}`,
  color: null,
  is_active: true,
  is_universal: false,
  magnitude_scale: scale,
  ...over,
} as unknown as Code)

const mapOf = (...cs: Code[]) => new Map(cs.map(c => [c.id, c]))

describe('ratableCodes — the ONE answer the `r` verb and the menu share (#868 e/f)', () => {
  it('returns the coder’s own scaled applications, in the order given', () => {
    const codes = mapOf(code({ id: 1 }), code({ id: 2 }))
    expect(ratableCodes(
      [{ code_id: 2, user_id: 7 }, { code_id: 1, user_id: 7 }], codes, 7,
    ).map(c => c.id)).toEqual([2, 1])
  })

  it('🔴 excludes a COLLEAGUE’s application — the server would refuse it', () => {
    // `set_code_magnitude` filters on user_id (magnitude-coding.md §4): rating
    // someone else's application would fabricate agreement.
    const codes = mapOf(code({ id: 1 }))
    expect(ratableCodes([{ code_id: 1, user_id: 9 }], codes, 7)).toEqual([])
  })

  it('excludes a code with NO declared scale — no instrument, nothing to open', () => {
    const codes = mapOf(code({ id: 1, magnitude_scale: null }))
    expect(ratableCodes([{ code_id: 1, user_id: 7 }], codes, 7)).toEqual([])
  })

  it('excludes an INACTIVE code — `validate_value` refuses it (#869 g)', () => {
    const codes = mapOf(code({ id: 1, is_active: false }))
    expect(ratableCodes([{ code_id: 1, user_id: 7 }], codes, 7)).toEqual([])
  })

  it('excludes a code the map does not know, rather than throwing', () => {
    expect(ratableCodes([{ code_id: 99, user_id: 7 }], mapOf(code({ id: 1 })), 7)).toEqual([])
  })

  it('deduplicates on code_id, so two coders never yield two menu items', () => {
    const codes = mapOf(code({ id: 1 }))
    expect(ratableCodes(
      [{ code_id: 1, user_id: 7 }, { code_id: 1, user_id: 7 }], codes, 7,
    ).map(c => c.id)).toEqual([1])
  })

  it('is empty for an absent list and for a null self id with attributed rows', () => {
    const codes = mapOf(code({ id: 1 }))
    expect(ratableCodes(undefined, codes, 7)).toEqual([])
    // Mirrors each workbench's `currentMagnitude` exactly: with no known self,
    // only an unattributed application matches — the safe direction, since a
    // rating we could not attribute is one the server would not write.
    expect(ratableCodes([{ code_id: 1, user_id: 7 }], codes, null)).toEqual([])
    expect(ratableCodes([{ code_id: 1, user_id: null }], codes, null).map(c => c.id)).toEqual([1])
  })
})
