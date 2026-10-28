/**
 * Rendering a recharts chart in jsdom, for a test that reads what the chart DRAWS (#1314).
 *
 * Four things stand between a chart component and a drawn SVG in jsdom, and each fails
 * SILENTLY — the chart draws nothing, or draws its bars without their labels — so an
 * assertion of the form "no label is wrong" would pass over an empty chart:
 *
 * 1. **A size.** `ResponsiveContainer` measures its parent, which jsdom lays out at 0×0, so
 *    it draws no chart. `withSizedResponsiveContainer` replaces it, inside a
 *    `vi.mock('recharts', …)` factory, with one that hands its child a fixed width and the
 *    height the component asked for. A component with its own size prop
 *    (`HorizontalBarChart`'s `fixedDimensions`) needs no mock.
 * 2. **`ResizeObserver`**, which jsdom lacks and the charts' data-width measurement calls.
 * 3. **Reduced motion.** recharts draws NO labels while a bar animates (`Bar.js`:
 *    `showLabels = !isAnimating`). A bar left at the default `isAnimationActive: 'auto'`
 *    stands down under `prefers-reduced-motion: reduce`, which recharts reads through
 *    `matchMedia` — also absent from jsdom. A bar given `isAnimationActive={true}` explicitly
 *    ignores the preference, so pass `false` there.
 * 4. **Chart colours.** `useChartColors` reads the theme context. Mock it in the test file,
 *    as `BoxPlotChart.test.tsx` does — `vi.mock` is hoisted per file, so it cannot live here.
 *
 * jsdom computes no LAYOUT, but recharts computes its own geometry from the size it is given,
 * so the `y` it draws a data label at and the `y` it draws an axis tick at are real numbers.
 * That is what `dataLabelsByCategory` and `seriesBarRects` read: what a researcher sees is a
 * number sitting on a BAR, and the bar belongs to whichever category's band it is drawn in.
 * Asserting through a marker the label carries itself would share the defect — a label that
 * reads the wrong row would carry the wrong row's marker too.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { vi } from 'vitest'

/** The width the sized `ResponsiveContainer` hands its chart. */
export const CHART_TEST_WIDTH = 800

/**
 * For a `vi.mock('recharts', async (orig) => …)` factory: recharts with a `ResponsiveContainer`
 * that draws its chart at `CHART_TEST_WIDTH` × the `height` it was given (400 for a
 * percentage or a missing height).
 */
export function withSizedResponsiveContainer<T extends object>(actual: T): T {
  function SizedResponsiveContainer({ children, height }: { children?: ReactNode; height?: number | string }) {
    if (!isValidElement(children)) return null
    return cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
      width: CHART_TEST_WIDTH,
      height: typeof height === 'number' ? height : 400,
    })
  }
  return { ...actual, ResponsiveContainer: SizedResponsiveContainer }
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** `ResizeObserver` and a `matchMedia` that reports reduced motion. Undo with `vi.unstubAllGlobals()`. */
export function stubChartGlobals(): void {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion: reduce'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }))
}

interface CategoryBand {
  category: string
  y: number
}

const num = (el: Element, attr: string): number => {
  const v = Number(el.getAttribute(attr))
  if (!Number.isFinite(v)) throw new Error(`<${el.tagName}> has no numeric ${attr}="${el.getAttribute(attr)}"`)
  return v
}

/**
 * The y-axis categories in drawn order, each at the vertical centre of its tick's text. A tick
 * that draws no text (a stacked chart's group separator) is not a category. The category is
 * the tick's `<title>` when it has one (the full label), otherwise its text.
 */
export function yAxisCategories(container: Element): CategoryBand[] {
  const out: CategoryBand[] = []
  // recharts 3 draws a tick's LINE inside `.recharts-yAxis` and its LABEL in a separate layer.
  for (const tick of container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-label')) {
    const texts = [...tick.querySelectorAll('text')]
    if (texts.length === 0) continue
    const y = texts.reduce((s, t) => s + num(t, 'y'), 0) / texts.length
    const category = tick.querySelector('title')?.textContent ?? tick.textContent ?? ''
    out.push({ category, y })
  }
  if (out.length < 2) {
    throw new Error(`found ${out.length} y-axis categories — the chart did not draw (see recharts-render.ts)`)
  }
  return out
}

/** The category whose band holds `y`: the nearest tick, refused when it is not clearly nearest. */
function bandAt(bands: CategoryBand[], y: number): string {
  const byDistance = [...bands].sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))
  const [nearest, next] = byDistance
  const spacing = Math.min(...bands.slice(1).map((b, i) => Math.abs(b.y - bands[i].y)))
  if (Math.abs(nearest.y - y) >= spacing / 2 || (next && Math.abs(next.y - y) - Math.abs(nearest.y - y) < 1)) {
    throw new Error(`y=${y} is not inside one category's band (nearest "${nearest.category}" at ${nearest.y})`)
  }
  return nearest.category
}

/**
 * Every data label recharts drew, as the text shown on each category's band, left to right.
 * Every category is present; one with no label maps to `[]`.
 */
export function dataLabelsByCategory(container: Element): Map<string, string[]> {
  const bands = yAxisCategories(container)
  const placed = new Map<string, { x: number; text: string }[]>(bands.map(b => [b.category, []]))
  for (const t of container.querySelectorAll('.recharts-label-list text')) {
    placed.get(bandAt(bands, num(t, 'y')))!.push({ x: num(t, 'x'), text: t.textContent ?? '' })
  }
  return new Map([...placed].map(([c, items]) => [c, items.sort((a, b) => a.x - b.x).map(i => i.text)]))
}

/**
 * The bars the `seriesIndex`-th `<Bar>` drew, in drawn order, each with the category whose band
 * it sits in. `el` is the drawn shape a pointer clicks; the click bubbles to the element recharts
 * attaches the Bar's `onClick` to.
 */
export function seriesBarRects(container: Element, seriesIndex: number): { el: Element; category: string }[] {
  const bands = yAxisCategories(container)
  const series = container.querySelectorAll('.recharts-bar')[seriesIndex]
  if (!series) throw new Error(`no <Bar> series ${seriesIndex}`)
  return [...series.querySelectorAll('.recharts-bar-rectangle')].map(rect => {
    const el = rect.querySelector('path.recharts-rectangle')
    if (!el) throw new Error('a bar rectangle drew no <path>')
    return { el, category: bandAt(bands, num(el, 'y') + num(el, 'height') / 2) }
  })
}
