import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { CSSProperties } from 'react'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Resolve a code's display color with category fallback and consistent default gray. */
export function getCodeColor(code: { color: string | null; category_color?: string | null }): string {
  return code.color || code.category_color || '#6b7280'
}

/**
 * Readable text colour (black or white) for a given hex background — the ONE
 * decision behind every code chip, codebook node, clip bar, coder badge and
 * participant tag, so it is worth getting exactly right.
 *
 * 0.179 is not a taste threshold: it is where contrast-against-white and
 * contrast-against-BLACK cross, `(L+0.05)² = 1.05 × 0.05`. Picking the better
 * side of it guarantees **≥ 4.58:1 for every possible background** — above the
 * 4.5:1 AA floor, with no colour able to fall through.
 *
 * ⚠️ It returned `#1a1a1a`, not black, until 2026-08-02, and that one nudge
 * cost the guarantee: a near-black floor of L≈0.0103 drops the worst case to
 * **3.80:1**, below AA, and moves the true crossover to 0.2016 — so the
 * threshold was also mis-paired with the colour it shipped. **Measured, not
 * reasoned: 3 of the app's own 16 code swatches failed AA** — `#8b5cf6`
 * (4.11:1), `#6366f1` (3.90:1), `#a855f7` (4.40:1), the whole indigo/violet
 * band, which is exactly where researchers reported unreadable code labels.
 * Pure black clears all 16. `utils.test.ts` pins the ≥4.5:1 floor across the
 * palette AND a dense sweep of the colour cube, so a future palette addition
 * or a re-softened text colour fails the suite rather than shipping.
 *
 * The docstring also claimed a threshold of 0.35 while the code used 0.179;
 * both numbers are now the one the code applies.
 */
export function getContrastColor(hex: string): string {
  const h = hex.replace('#', '')
  if (h.length < 6) return '#ffffff'
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const luminance =
    0.2126 * (r <= 0.03928 ? r / 12.92 : ((r + 0.055) / 1.055) ** 2.4) +
    0.7152 * (g <= 0.03928 ? g / 12.92 : ((g + 0.055) / 1.055) ** 2.4) +
    0.0722 * (b <= 0.03928 ? b / 12.92 : ((b + 0.055) / 1.055) ** 2.4)
  // Pure black, deliberately — see getContrastColor's ⚠️. Softening re-breaks AA.
  return luminance > 0.179 ? '#000000' : '#ffffff'
}

/** Return black or white text for an HSL background using WCAG relative luminance. */
export function getHslTextColor(h: number, s: number, l: number): string {
  // HSL → RGB (s and l as 0-100 percentages)
  const sNorm = s / 100
  const lNorm = l / 100
  const a = sNorm * Math.min(lNorm, 1 - lNorm)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return lNorm - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
  }
  const r = f(0), g = f(8), b = f(4)
  // WCAG relative luminance
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  // Pure black, deliberately — see getContrastColor's ⚠️. Softening re-breaks AA.
  return luminance > 0.179 ? '#000000' : '#ffffff'
}

/** Style for unfocused items in focus mode (dimmed + desaturated). */
export function getUnfocusedStyle(isFocused: boolean): CSSProperties | undefined {
  if (isFocused) return undefined
  return { opacity: 0.35, filter: 'saturate(0.3)', transition: 'opacity 200ms, filter 200ms' }
}

export function formatTimestamp(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return ""

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

/**
 * Sub-second timecode for the observation workbench (slab 3c): `m:ss.d`
 * (tenths), `h:mm:ss.d` over an hour. `formatTimestamp` above stays the
 * second-granular transcript formatter; clips are cut at sub-second boundaries,
 * so their display must not round two distinct boundaries to one string.
 * Works in integer TENTHS so float dust can't render "0:03.10".
 */
export function formatTimecode(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return ''
  const tenths = Math.round(Math.max(0, seconds) * 10)
  const frac = tenths % 10
  const whole = Math.floor(tenths / 10)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const mmss = `${String(secs).padStart(2, '0')}.${frac}`
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${mmss}`
  return `${minutes}:${mmss}`
}

/**
 * Parse a researcher-typed timecode into seconds (the clip time inputs — the
 * keyboard/a11y editing path, slab 3c). Accepts `225`, `3:45`, `3:45.2`,
 * `1:03:45.2`, `.5`. Returns null for anything else — the inputs treat null as
 * "invalid, keep editing", never as 0.
 */
export function parseTimecode(text: string): number | null {
  const match = text.trim().match(/^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?|\.\d+)$/)
  if (!match) return null
  const [, first, second, last] = match
  const secs = parseFloat(last)
  if (!Number.isFinite(secs)) return null
  if (first !== undefined && second !== undefined) {
    return Number(first) * 3600 + Number(second) * 60 + secs
  }
  if (first !== undefined) {
    return Number(first) * 60 + secs
  }
  return secs
}

/** Parse a URL search param as an integer. Returns null for missing, empty, or non-finite values. */
export function parseIntParam(raw: string | null): number | null {
  if (!raw) return null
  const v = Number(raw)
  return Number.isFinite(v) ? v : null
}

/** Convert hex color to a pale row background tint. Pass isDark for reactivity. */
export function hexToRowBg(hex: string, isDark: boolean): string {
  const { h, s } = hexToHsl(hex)
  return isDark
    ? `hsl(${h}, ${Math.round(s * 0.2)}%, 14%)`
    : `hsl(${h}, ${Math.round(s * 0.25)}%, 96%)`
}

/** Convert hex color to a pale row hover background tint. Pass isDark for reactivity. */
export function hexToRowHoverBg(hex: string, isDark: boolean): string {
  const { h, s } = hexToHsl(hex)
  return isDark
    ? `hsl(${h}, ${Math.round(s * 0.25)}%, 20%)`
    : `hsl(${h}, ${Math.round(s * 0.3)}%, 93%)`
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16) / 255
  const g = parseInt(c.slice(2, 4), 16) / 255
  const b = parseInt(c.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: Math.round(h * 360), s: s * 100, l: l * 100 }
}
