import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Keep a column header aligned with the scrolling rows beneath it (#741/#666).
 *
 * **The problem.** On all three list-shaped coding surfaces the column header
 * sits OUTSIDE the Virtuoso scroller. When the list overflows and paints a
 * scrollbar, the rows lose that width and the header does not, so every
 * trailing column in the header ends up ~15px right of the column it names.
 * Measured live at 1600×1000: conversations, documents and observations all
 * showed a uniform 15px offset; text coding is exempt because it is a real
 * `<table>`, whose columns align by construction.
 *
 * **Why not `scrollbar-gutter: stable`,** which the issue offered as the
 * one-property version: it reserves the gutter INSIDE the scroller, so it makes
 * the row area permanently 15px narrower than the header instead of
 * conditionally. It converts an intermittent misalignment into a constant one.
 *
 * **Why not move the header inside the scroller** as a sticky row: Virtuoso
 * positions its viewport, and the scroller also contains the `role="listbox"`
 * whose children the #436/#484 pattern constrains. Restructuring a working
 * a11y tree to fix 15px of paint is the "framework gymnastics" smell.
 *
 * **So: measure it.** `offsetWidth - clientWidth` is the scrollbar's real
 * width, which is 0 when nothing overflows and 0 again on platforms with
 * overlay scrollbars — so the header pads only when there is something to pad
 * for, with no per-platform guesswork.
 *
 * ⚠️ jsdom computes no layout, so this always measures 0 in tests and no unit
 * test can prove it works (the #717/#718 rule). It was verified by driving all
 * three surfaces; a change here needs the same.
 */
export function useScrollbarGutter() {
  const [gutter, setGutter] = useState(0)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  const measure = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    // Never negative, and never a fractional pixel the header can't match.
    setGutter(Math.max(0, Math.round(el.offsetWidth - el.clientWidth)))
  }, [])

  /** Pass to Virtuoso's `scrollerRef` prop. */
  const setScroller = useCallback((el: HTMLElement | Window | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    scrollerRef.current = el instanceof HTMLElement ? el : null
    if (!scrollerRef.current) return
    measure()
    // The scrollbar appears and disappears as rows are added, filtered or
    // resized — none of which is a React render of the header, so a one-shot
    // measurement goes stale. ResizeObserver on the scroller catches the width
    // change that accompanies every one of them.
    if (typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver(measure)
      observerRef.current.observe(scrollerRef.current)
    }
  }, [measure])

  useEffect(() => () => observerRef.current?.disconnect(), [])

  return { setScroller, gutter, remeasure: measure }
}
