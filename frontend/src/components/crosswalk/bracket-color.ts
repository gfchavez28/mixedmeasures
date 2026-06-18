/**
 * Unified color-rendering helpers for variable-group brackets.
 *
 * Addresses #318: `bracket.color` was rendered inconsistently —
 * hardcoded violet-* on Bracket.tsx, conditional `{b.color && ...}` dots on
 * BulkAssignPickerDialog and dropdown submenus. Fix: always resolve to a
 * color (neutral indigo fallback when null), and derive bracket-label
 * styles from the effective color at render time so user-picked colors
 * actually show through instead of only appearing as a thin border accent.
 *
 * Text-contrast approach: derive a darkened variant of the effective color
 * that preserves hue identity while guaranteeing WCAG AA contrast against
 * the ~white tinted background (see `darkReadableVariant` for the math).
 * This is closer in spirit to the original `violet-700 on violet-50` pattern
 * — identity-preserving — than a blanket `getContrastColor` black/white pick.
 */

import type { CSSProperties } from 'react'

/** Neutral fallback when `bracket.color` is null — matches Canvas's default
 * theme color for cross-workspace consistency. */
export const DEFAULT_BRACKET_COLOR = '#6366f1' // indigo

/** Resolve a bracket's effective color, falling back to the neutral default
 * when the user hasn't picked one. Every rendering surface should call this
 * before styling — no more `{b.color && ...}` conditionals. */
export function resolveBracketColor(color: string | null | undefined): string {
  return color ?? DEFAULT_BRACKET_COLOR
}

/** Canonical Tailwind class for a small color dot (bracket swatch in radio
 * lists, dropdown menus, etc.). Harmonizes the dot size across
 * BulkAssignPickerDialog (was w-3) and dropdown submenus (was w-2.5).
 * Pair with inline `{ backgroundColor: resolveBracketColor(color) }`. */
export const BRACKET_DOT_CLASS = 'inline-block w-2.5 h-2.5 rounded-full flex-none'

export interface BracketLabelStyles {
  /** Full style for the label container — border color + tinted bg. */
  container: CSSProperties
  /** Text color for the label heading — high-contrast on the tinted bg. */
  heading: CSSProperties
  /** Muted text color for sub-labels (row count, cross-dataset, description). */
  muted: CSSProperties
  /** Style for the Score badge pill (bg + text color). */
  scoreBadge: CSSProperties
  /** Style for the outer bracket-body frame (right/top/bottom border). */
  frame: CSSProperties
}

/** Derive all label styles for a bracket from its (possibly null) color.
 * The label container uses a 12% alpha tint of the effective color as bg
 * + the color itself as the border. Text uses a darkened variant of the
 * hue so it's readable on the light tint AND preserves the color identity
 * (vs. plain black, which would lose the color signal on the text). */
export function getBracketLabelStyles(color: string | null | undefined): BracketLabelStyles {
  const effective = resolveBracketColor(color)
  const tintBg = hexWithAlpha(effective, 0.12)
  const badgeBg = hexWithAlpha(effective, 0.22)
  // Text color: a darkened version of the hue that reads on the ~white
  // tinted bg. If the source is already dark enough (luminance < 0.25),
  // use it as-is; otherwise darken to ensure WCAG AA contrast.
  const onTintText = darkReadableVariant(effective)

  return {
    container: {
      backgroundColor: tintBg,
      borderColor: effective,
    },
    heading: { color: onTintText },
    muted: { color: onTintText, opacity: 0.75 },
    scoreBadge: {
      backgroundColor: badgeBg,
      color: onTintText,
    },
    frame: { borderColor: effective },
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Append an alpha channel to a 6-char hex color. Returns an rgba() string
 * so we don't have to worry about Tailwind's compilation of arbitrary
 * `#xxxxxxAA` forms. */
function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  if (h.length < 6) return `rgba(99, 102, 241, ${alpha})`
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Produce a darkened variant of the source color that reads on a ~white
 * tinted background. The goal: preserve hue identity while guaranteeing
 * enough contrast for WCAG AA 4.5:1 on the 12%-alpha tinted bg.
 *
 * Algorithm: compute the source color's relative luminance. If already
 * dark (lum < 0.25), return as-is. Otherwise, scale RGB channels down by
 * a factor chosen to drop luminance to ~0.18 — that's the same threshold
 * `getContrastColor` uses for its white/dark text boundary, and yields
 * ≥4.5:1 contrast against our mostly-white tint. */
function darkReadableVariant(hex: string): string {
  const h = hex.replace('#', '')
  if (h.length < 6) return '#1a1a1a'
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const toLin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum =
    0.2126 * toLin(r / 255) + 0.7152 * toLin(g / 255) + 0.0722 * toLin(b / 255)
  // Threshold 0.12 — anything brighter needs darkening. Indigo (~0.185) and
  // mid-blue (~0.237) fail WCAG AA 4.5:1 on white-ish bg without darkening.
  if (lum < 0.12) return hex
  // Scale channels proportionally to hit target luminance ≈ 0.09 — well
  // under the 0.179 threshold used by getContrastColor so we're solidly
  // in "prefer-dark-text" territory (~7:1 contrast on white).
  const targetLum = 0.09
  const scale = Math.min(1, Math.sqrt(targetLum / Math.max(lum, 0.01)))
  const scaled = (v: number) => Math.max(0, Math.min(255, Math.round(v * scale)))
  const toHex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${toHex(scaled(r))}${toHex(scaled(g))}${toHex(scaled(b))}`
}
