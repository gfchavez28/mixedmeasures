import { forwardRef, type ReactNode } from 'react'

/**
 * The ONE wrapper for a chart's outer element (#698).
 *
 * ## What was wrong
 *
 * Every chart was wrapped in `<div role="img" aria-label="Horizontal bar chart">`.
 * `img` is one of the roles whose children are **presentational**, so every axis
 * tick, category label and value in the DOM was suppressed and the whole chart
 * announced as a three-word label. Measured on a rendered `HorizontalBarChart`: 97
 * characters of real content in the DOM, accessible name `"Horizontal bar chart"`,
 * zero data labels reachable.
 *
 * It also swallowed the **log-scale caveat** (`"N values ≤ 0 excluded from log
 * scale"`), which sits inside the wrapper at every site — a methodological warning,
 * discarded along with the data.
 *
 * ## Why this is mostly a deletion
 *
 * `recharts` is pinned at **3.8.1**, where `accessibilityLayer` defaults to `true`
 * (verified in `recharts/es6/state/rootPropsSlice.js` and `chart/CartesianChart.js`).
 * Recharts was ALREADY rendering `<svg tabindex="0" role="application">` for
 * arrow-key traversal of data points; the hand-added wrapper buried it. Worse, a
 * focusable `role="application"` nested inside a presentational-children role is a
 * conflicting state that leaves a tab stop with either no name or the useless one.
 *
 * ## Why `<figure>` rather than a bare `<div>`
 *
 * Deleting the role alone would expose the content but leave the chart with **no
 * accessible name at all** — a browse-mode user would land in a pile of numbers
 * with no announcement of what they are. `figure` does NOT make its children
 * presentational, so a `<figcaption>` names the chart *and* everything inside stays
 * readable. The caption is `sr-only` because these charts already carry visible
 * titles in their surrounding panels; adding a second visible one would be a
 * design change, not an accessibility fix.
 *
 * Safe to use here: Tailwind v4's preflight applies `margin: 0` universally
 * (`preflight.css`, the `*, ::before, ::after` rule), so `<figure>` carries none of
 * the UA stylesheet's `margin: 1em 40px`. Layout is unchanged.
 *
 * ## Notes for anyone extending this
 *
 * - Do NOT put `role="img"` back on the figure, or on any element that has children
 *   worth reading. If a chart is genuinely a single opaque image, that is the one
 *   case where `role="img"` is right — and none of ours are.
 * - `DumbbellChart` is a hand-rolled `<svg>`, not recharts. It carries its own
 *   chart-level `<title>`, so it keeps a name either way, but it gains no keyboard
 *   traversal from this change — only readable content. The other 11 gain both.
 * - The **Summary Table** chart type in `ChartTypeToolbar` remains a real, deliberate
 *   accessible alternative, and belongs in any accessibility statement. It is
 *   deliberately NOT mentioned in the caption: these charts also render on the Canvas
 *   and in exports, where no toolbar exists, so the instruction would be false there.
 */
interface ChartFigureProps {
  /** What the chart IS, e.g. `"Horizontal bar chart"`. Becomes the accessible name. */
  label: string
  /**
   * How many marks the chart contains, when it is cheaply and accurately known.
   * Announced after the label so a browse-mode user knows how much follows.
   * Omit rather than guess — a wrong count is worse than none.
   */
  count?: number
  /** Plural noun for `count`, e.g. `"bars"`, `"points"`. Defaults to `"items"`. */
  countNoun?: string
  className?: string
  children: ReactNode
}

export const ChartFigure = forwardRef<HTMLElement, ChartFigureProps>(
  function ChartFigure({ label, count, countNoun = 'items', className, children }, ref) {
    const caption =
      typeof count === 'number'
        ? `${label}, ${count} ${count === 1 ? countNoun.replace(/s$/, '') : countNoun}`
        : label

    return (
      <figure ref={ref} className={className}>
        <figcaption className="sr-only">{caption}</figcaption>
        {children}
      </figure>
    )
  },
)
