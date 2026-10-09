import { describe, it, expect } from 'vitest'
import {
  coderColor, coderInitials, isCoderVisible, CODER_PALETTE,
  onlyCoders, lensHidesAnyCoder, chipHiddenWithArchived,
} from './coder-color'

describe('coderColor', () => {
  it('uses display_color when set', () => {
    expect(coderColor({ id: 1, display_color: '#abcdef' })).toBe('#abcdef')
  })
  it('falls back to a stable palette slot by id (wraps modulo)', () => {
    expect(coderColor({ id: 0 })).toBe(CODER_PALETTE[0])
    expect(coderColor({ id: CODER_PALETTE.length })).toBe(CODER_PALETTE[0])
    expect(coderColor({ id: 3 })).toBe(coderColor({ id: 3 })) // stable
  })
  it('ignores empty/null display_color', () => {
    expect(coderColor({ id: 2, display_color: '' })).toBe(CODER_PALETTE[2 % CODER_PALETTE.length])
    expect(coderColor({ id: 2, display_color: null })).toBe(CODER_PALETTE[2 % CODER_PALETTE.length])
  })
})

describe('coderInitials', () => {
  it('two-part name → first+last initial', () => {
    expect(coderInitials('Dr. Alvarez')).toBe('DA')
  })
  it('single name → first two chars uppercased', () => {
    expect(coderInitials('Sam')).toBe('SA')
  })
  it('three+ parts → first + last', () => {
    expect(coderInitials('Maria de la Cruz')).toBe('MC')
  })
  it('blank → ?', () => {
    expect(coderInitials('   ')).toBe('?')
  })
  it('#1135: punctuation is never an initial — "Priya (lead)" is PL, not P(', () => {
    expect(coderInitials('Priya (lead)')).toBe('PL')
    expect(coderInitials('Model B — v2')).toBe('MV')
    expect(coderInitials('"Sam"')).toBe('SA')
    expect(coderInitials('— —')).toBe('?')
  })
  it('#1135: an astral letter is one initial, not half of one', () => {
    expect(coderInitials('𝒜da Lovelace')).toBe('𝒜L')
  })
})

describe('isCoderVisible (per-coder visibility filter)', () => {
  it('shows everything when no filter / empty set', () => {
    expect(isCoderVisible(5, undefined)).toBe(true)
    expect(isCoderVisible(5, new Set())).toBe(true)
  })
  it('hides codes by a hidden coder', () => {
    expect(isCoderVisible(5, new Set([5]))).toBe(false)
    expect(isCoderVisible(7, new Set([5]))).toBe(true)
  })
  it('never hides unattributed (null/undefined applier) codes', () => {
    expect(isCoderVisible(null, new Set([5]))).toBe(true)
    expect(isCoderVisible(undefined, new Set([5]))).toBe(true)
  })
})

// #964 — blind mode before the roster answers: "everyone but me" with no roster.
describe('the allow-list lens (onlyCoders)', () => {
  it('shows only its members — including ids no roster ever named', () => {
    const lens = onlyCoders([1])
    expect(isCoderVisible(1, lens)).toBe(true)
    expect(isCoderVisible(2, lens)).toBe(false)
    expect(isCoderVisible(987654, lens)).toBe(false)
  })
  it('never hides unattributed codes, exactly like a hide set', () => {
    expect(isCoderVisible(null, onlyCoders([1]))).toBe(true)
    expect(isCoderVisible(undefined, onlyCoders([]))).toBe(true)
  })
  it('an EMPTY allow-list hides every attributed coding (fail-closed), unlike an empty hide set', () => {
    expect(isCoderVisible(1, onlyCoders([]))).toBe(false)
    expect(isCoderVisible(1, new Set())).toBe(true)
  })
  it('counts as hiding someone, so a gauge says "coded by visible coders"', () => {
    expect(lensHidesAnyCoder(onlyCoders([1]))).toBe(true)
    expect(lensHidesAnyCoder(new Set([2]))).toBe(true)
    expect(lensHidesAnyCoder(new Set())).toBe(false)
    expect(lensHidesAnyCoder(undefined)).toBe(false)
  })
  it('chipHiddenWithArchived passes an allow-list through — archived colleagues are already outside it', () => {
    // ⚠️ showArchived FALSE with archived ids present is the only input that
    // reaches the fold (a first draft passed `true`, returned early, and let the
    // pass-through be deleted). Without it the fold copies the lens into a Set,
    // and an allow-list is not iterable.
    const lens = onlyCoders([1])
    const out = chipHiddenWithArchived(lens, new Set([9]), false)
    expect(out).toBe(lens)
    expect(isCoderVisible(9, out)).toBe(false)
    expect(isCoderVisible(1, out)).toBe(true)
  })
  it('chipHiddenWithArchived still folds archived ids into a hide set unless shown', () => {
    expect(isCoderVisible(9, chipHiddenWithArchived(new Set([2]), new Set([9]), false))).toBe(false)
    expect(isCoderVisible(9, chipHiddenWithArchived(new Set([2]), new Set([9]), true))).toBe(true)
  })
})
