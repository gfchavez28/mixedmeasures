/**
 * A machine coder's provenance — the client half (queue row 49).
 *
 * The vocabulary's agreement with Python is pinned from the other side
 * (`backend/tests/test_machine_coder_contract.py`, which reads the `.ts`). What
 * lives here is the DISPLAY behaviour that file cannot see.
 */
import { describe, it, expect } from 'vitest'
import type { Coder } from '@/lib/api'
import {
  MACHINE_ACCESS_KINDS,
  MACHINE_ACCESS_LABEL,
  describeProvenance,
  formatParameters,
  hasProvenance,
  parseParameters,
  provenanceLockReason,
  unreadableParameters,
} from './machine-coder'

describe('describeProvenance', () => {
  it('names the configuration in one line', () => {
    expect(describeProvenance({
      model: 'gpt-4o', access: 'api', parameters: { temperature: '0', top_p: '1' },
    })).toBe('gpt-4o · via API · temperature 0, top_p 1')
  })

  it('🔴 says "not recorded" rather than rendering nothing', () => {
    // An undocumented model must not be indistinguishable from a documented one
    // — which is the gap the whole row exists to close.
    expect(describeProvenance(null)).toBe('Configuration not recorded')
    expect(describeProvenance(undefined)).toBe('Configuration not recorded')
  })

  it('never puts the PROMPT in the one-liner', () => {
    // A prompt is paragraphs; this sits beside a coder's name.
    const line = describeProvenance({ model: 'm', prompt: 'x'.repeat(2000) })
    expect(line).toBe('m')
  })

  it('orders parameters so two readings of one configuration match', () => {
    const a = describeProvenance({ model: 'm', parameters: { top_p: '1', temperature: '0' } })
    const b = describeProvenance({ model: 'm', parameters: { temperature: '0', top_p: '1' } })
    expect(a).toBe(b)
  })

  it('uses the LABEL for the access kind, not the wire value', () => {
    for (const kind of MACHINE_ACCESS_KINDS) {
      expect(describeProvenance({ model: 'm', access: kind }))
        .toContain(MACHINE_ACCESS_LABEL[kind])
    }
  })
})

describe('parseParameters', () => {
  it('takes commas, new lines or both', () => {
    expect(parseParameters('temperature=0, top_p=1\nseed=42')).toEqual({
      temperature: '0', top_p: '1', seed: '42',
    })
  })

  it('🔴 keeps everything after the FIRST "=" ', () => {
    // A stop sequence legitimately contains one, and splitting on every `=`
    // would silently truncate the setting being recorded.
    expect(parseParameters('stop=a=b')).toEqual({ stop: 'a=b' })
  })

  it('keeps a value of ZERO', () => {
    // The falsy-zero class: `temperature=0` is the single most reportable
    // decoding setting there is.
    expect(parseParameters('temperature=0')).toEqual({ temperature: '0' })
  })

  it('ignores fragments that name nothing', () => {
    expect(parseParameters('  , =5, temperature=0.2 ,')).toEqual({ temperature: '0.2' })
  })

  it('round-trips through formatParameters', () => {
    const params = { temperature: '0', top_p: '1' }
    expect(parseParameters(formatParameters(params))).toEqual(params)
  })
})

describe('unreadableParameters', () => {
  it('🔴 names every part the parser will DROP, so the drop is not silent', () => {
    expect(unreadableParameters('temperature: 0, top_p=1\nseed 42, max_tokens=')).toEqual([
      'temperature: 0', 'seed 42', 'max_tokens=',
    ])
  })

  it('says nothing about empty fragments — separators are forgiven, not reported', () => {
    expect(unreadableParameters('  , temperature=0 ,\n\n')).toEqual([])
    expect(unreadableParameters('')).toEqual([])
  })

  it('treats a value holding "=" as readable, as the parser does', () => {
    expect(unreadableParameters('stop=a=b')).toEqual([])
  })

  it('🔴 AGREES with parseParameters on every fragment: read, or reported — never neither', () => {
    // The two share one split and one test; this pins that each non-empty
    // fragment lands in exactly one of the two outputs.
    const cases = [
      'temperature=0', '=5', 'k=', 'a=b=c', 'no equals', ' spaced = value ',
      'temperature: 0', 'x=1, y 2\nz=3',
    ]
    for (const text of cases) {
      const fragments = text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
      const read = Object.keys(parseParameters(text)).length
      expect(read + unreadableParameters(text).length).toBe(fragments.length)
    }
  })
})

describe('provenanceLockReason', () => {
  const coder = (over: Partial<Coder>): Coder =>
    ({ id: 1, username: 'GPT-4o', coder_type: 'ai', ...over })

  it('🔴 reads the SERVER fact and never re-derives it', () => {
    expect(provenanceLockReason(coder({ provenance_locked: true }))).toContain(
      'two different coders',
    )
    expect(provenanceLockReason(coder({ provenance_locked: false }))).toBeNull()
  })

  it('an ABSENT flag reads as unlocked, which is the recoverable direction', () => {
    // An older payload has no such field. Guessing LOCKED would hide the editor
    // for a coder that can be edited; guessing UNLOCKED offers an editor whose
    // save the server answers with its own reason. The second is recoverable.
    expect(provenanceLockReason(coder({}))).toBeNull()
  })
})

describe('hasProvenance', () => {
  it('is about the MODEL, not about the object existing', () => {
    expect(hasProvenance({ machine_provenance: { model: 'm' } })).toBe(true)
    expect(hasProvenance({ machine_provenance: null })).toBe(false)
    expect(hasProvenance({})).toBe(false)
  })
})
