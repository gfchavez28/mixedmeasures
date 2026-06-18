import { describe, it, expect } from 'vitest'
import { getContrastColor, getHslTextColor } from './utils'

describe('getContrastColor', () => {
  it('returns dark text for white background', () => {
    expect(getContrastColor('#ffffff')).toBe('#1a1a1a')
  })

  it('returns white text for black background', () => {
    expect(getContrastColor('#000000')).toBe('#ffffff')
  })

  it('returns dark text for light gray', () => {
    expect(getContrastColor('#cccccc')).toBe('#1a1a1a')
  })

  it('returns white text for dark blue', () => {
    expect(getContrastColor('#1a237e')).toBe('#ffffff')
  })

  it('handles short hex strings gracefully', () => {
    expect(getContrastColor('#fff')).toBe('#ffffff')
  })
})

describe('getHslTextColor', () => {
  it('returns dark text for very light background (L=96)', () => {
    expect(getHslTextColor(142, 76, 96)).toBe('#1a1a1a')
  })

  it('returns white text for dark background (L=30)', () => {
    expect(getHslTextColor(142, 76, 30)).toBe('#ffffff')
  })

  it('returns dark text for pure white (0, 0, 100)', () => {
    expect(getHslTextColor(0, 0, 100)).toBe('#1a1a1a')
  })

  it('returns white text for pure black (0, 0, 0)', () => {
    expect(getHslTextColor(0, 0, 0)).toBe('#ffffff')
  })
})
