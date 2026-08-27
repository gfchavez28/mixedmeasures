import { CATEGORY_COLORS } from '@/lib/chart-data'

/**
 * Human names for the shared category palette (#788).
 *
 * 🔴 **A hex code is not a name.** The swatch picker announced
 * `Color #3b82f6 toggle button pressed` — sixteen times, once per swatch. A
 * sighted user picks a colour by looking at it; a screen-reader user was given a
 * string that cannot be told apart from the next one without decoding hex by ear.
 *
 * ⚠️ **The names are VERIFIED against measured hue, not asserted.** Each hex was
 * converted to HSL and checked to fall inside the band its name claims — which is
 * how `Stone` earned its name from its 5% SATURATION rather than its hue (25°,
 * which would otherwise read as orange). Three reds (Red/Rose/Pink) and three
 * purples (Indigo/Violet/Purple) sit close together, so the names have to stay
 * mutually distinct, not merely individually plausible.
 *
 * ⚠️ Keyed by hex and asserted COMPLETE over `CATEGORY_COLORS` — adding a
 * seventeenth colour without naming it fails the suite rather than shipping a
 * swatch that announces its hex.
 */
export const CATEGORY_COLOR_NAMES: Record<string, string> = {
  '#3b82f6': 'Blue',
  '#8b5cf6': 'Violet',
  '#ec4899': 'Pink',
  '#f97316': 'Orange',
  '#14b8a6': 'Teal',
  '#eab308': 'Yellow',
  '#ef4444': 'Red',
  '#22c55e': 'Green',
  '#6366f1': 'Indigo',
  '#06b6d4': 'Cyan',
  '#f43f5e': 'Rose',
  '#a855f7': 'Purple',
  '#f59e0b': 'Amber',
  '#0ea5e9': 'Sky',
  '#84cc16': 'Lime',
  '#78716c': 'Stone',
}

/**
 * The name to announce for a colour.
 *
 * Falls back to the hex for anything outside the palette — several call sites
 * carry a stored colour that predates the palette or came from elsewhere, and a
 * hex read aloud is poor but honest, where a wrong name would not be.
 */
export function colorName(hex: string): string {
  return CATEGORY_COLOR_NAMES[hex.toLowerCase()] ?? hex
}

/** Every palette entry, named — the completeness check the guard asserts. */
export function unnamedPaletteColors(): string[] {
  return CATEGORY_COLORS.filter(c => !CATEGORY_COLOR_NAMES[c.toLowerCase()])
}
