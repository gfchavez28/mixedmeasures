import { describe, it, expect } from 'vitest'
import { coderColor, coderInitials, isCoderVisible, CODER_PALETTE } from './coder-color'

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
