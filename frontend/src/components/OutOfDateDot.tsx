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
 *   mode. `role="img"` is right here because its one child is the drawn dot,
 *   itself `aria-hidden` (#1261) — nothing worth reading is made presentational.
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
    // #1261 — the hover words for the eye, the name for the tree: the same sentence,
    // on two elements. #1174 gave the dot its name and dropped the `title`s its sites
    // had carried ("Stale — recompute"), so a sighted researcher saw an unexplained
    // pulsing dot, or hovered onto the parent's title (a formula, a group's name).
    // ⚠️ NOT a `title` beside the `aria-label` on one element: Chrome exposes that
    // title as the DESCRIPTION too (measured — name and description both "Out of date
    // — recompute in Analysis"), the words exposed twice; whether a reader speaks
    // both is unverified (name-sweep run 12, #1287). The title sits on the
    // aria-hidden dot inside, which is what the pointer hovers; a hidden element
    // describes nothing. Its own title wins over a parent's on the dot.
    <span role="img" aria-label={label} className={`inline-flex shrink-0 ${className}`.trim()}>
      <span
        aria-hidden="true"
        title={label}
        className={`inline-block rounded-full ${size === 'md' ? 'w-2 h-2' : 'w-1.5 h-1.5'} ${OUT_OF_DATE_DOT_COLOR} motion-safe:animate-pulse`}
      />
    </span>
  )
}
