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
 * Compute readable text color (black or white) for a given hex background.
 * Uses WCAG relative luminance. Threshold 0.35 biases toward white text
 * on mid-tone backgrounds for better readability on colored chips.
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
  return luminance > 0.179 ? '#1a1a1a' : '#ffffff'
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
  return luminance > 0.179 ? '#1a1a1a' : '#ffffff'
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
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: Math.round(h * 360), s: s * 100, l: l * 100 }
}
