/**
 * D176.4 — the Report view widens past the Writing canvas's 740px column to the canvas's own
 * width, and ONLY while shown.
 *
 * Measured, not styled with container units, on purpose: a `@container` on the canvas's scroll
 * area would give it layout containment (`ImportStepRail.tsx` records that measurement), which
 * re-anchors every `position: fixed` element inside the editor — a breakout must not move its
 * neighbours. So the node view measures the scroll area (`[data-canvas-scroll]`,
 * `WritingCanvas.tsx`) and its own column, and sets a width and a negative left margin that put
 * the display a gutter in from the scroll area's edges, whatever padding sits between them.
 *
 * - Off the Writing canvas (Canvas Compare, a test) there is no scroll area: nothing changes and
 *   the table scrolls sideways inside `ScrollableTable`, as it does in any window too narrow.
 * - Never narrower than the column: a breakout only ever widens.
 * - Re-measured when either box resizes — the outline opening or closing, the window.
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

export const CANVAS_SCROLL_ATTR = 'data-canvas-scroll'
const GUTTER_PX = 24

export function useReportBreakout(ref: RefObject<HTMLElement | null>, active: boolean): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined)

  useLayoutEffect(() => {
    const el = ref.current
    const column = el?.parentElement
    const scroller = el?.closest<HTMLElement>(`[${CANVAS_SCROLL_ATTR}]`)
    if (!active || !el || !column || !scroller) {
      setStyle(undefined)
      return
    }
    const measure = () => {
      const s = scroller.getBoundingClientRect()
      const c = column.getBoundingClientRect()
      // `clientWidth` leaves out a vertical scrollbar, which `getBoundingClientRect` includes.
      const target = scroller.clientWidth - 2 * GUTTER_PX
      if (target <= c.width) {
        setStyle(undefined)
        return
      }
      const marginLeft = Math.round(s.left + GUTTER_PX - c.left)
      setStyle(prev => (prev?.width === target && prev?.marginLeft === marginLeft ? prev : { width: target, marginLeft }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    observer.observe(column)
    return () => observer.disconnect()
  }, [ref, active])

  return active ? style : undefined
}
