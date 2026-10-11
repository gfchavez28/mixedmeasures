/**
 * The "out of date" marker on a saved statistic, a computed variable or a scale
 * score (#1174) — one component for every site, so the name, the colour and the
 * motion cannot drift apart again.
 *
 * Before, four sites drew the dot four ways: two with only a `title` (not a
 * name, #559), one with a `title` plus an `sr-only` "stale" (announced twice,
 * in jargon), and the crosswalk with `aria-label="stale"` on a plain span (a
 * name on a generic element is not exposed). The Data view's freshness line
 * already says "out of date", so that is the vocabulary here.
 *
 * - **`role="img"` + `aria-label`, and NO tab stop** — a static badge
 *   (the internal design notes, #559): a per-row focusable badge costs a
 *   keyboard user one stop per row for what the name already says in browse
 *   mode. `role="img"` is right here because there are no children to hide —
 *   `ChartFigure.test.tsx`'s allowlist carries this file for that reason.
 * - **`motion-safe:animate-pulse`, never bare** — the pulse is the attention
 *   cue, and under `prefers-reduced-motion` the dot is simply steady.
 * - **The colour is a CONTRAST decision, measured, not the old `amber-400`**:
 *   as a graphic that carries meaning it needs 3:1 against what it sits on
 *   (WCAG 1.4.11). `amber-400` measured 1.45–1.68:1 on the light surfaces;
 *   `amber-700` / dark `amber-400` clear 3:1 on every surface the dot sits on,
 *   pinned in `OutOfDateDot.test.tsx` from the shipped palette.
 *
 * ⚠️ Not inside a button that has its own `aria-label`: a button's children are
 * presentational and its explicit name wins, so the dot would say nothing. Put
 * the words in the button's name and keep the dot decorative, as the
 * crosswalk's score badge does. (Inside a button NAMED BY ITS CONTENT the dot's
 * label does join the name — the Statistics header uses that.)
 */

/** The dot's fill, exported for the contrast guard. */
export const OUT_OF_DATE_DOT_COLOR = 'bg-amber-700 dark:bg-amber-400'

export const OUT_OF_DATE_LABEL = 'Out of date — recompute'

export function OutOfDateDot({
  label = OUT_OF_DATE_LABEL,
  size = 'sm',
  className = '',
}: {
  /** The accessible name, in plain words: what is wrong and what fixes it. */
  label?: string
  /** `sm` = 6px (column headers), `md` = 8px (list rows). */
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-block shrink-0 rounded-full ${size === 'md' ? 'w-2 h-2' : 'w-1.5 h-1.5'} ${OUT_OF_DATE_DOT_COLOR} motion-safe:animate-pulse ${className}`.trim()}
    />
  )
}
