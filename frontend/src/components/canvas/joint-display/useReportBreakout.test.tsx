/**
 * D176.4 — the Report view widens past the writing column to the canvas's scroll area, a gutter in
 * from each edge, and only while shown. jsdom lays nothing out, so the boxes are stubbed: what is
 * pinned here is the ARITHMETIC (and the cases that must leave the view alone); the layout itself
 * was measured live at 1280×720 and 640×360, outline open and closed (session C's record).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useRef } from 'react'
import { CANVAS_SCROLL_ATTR, useReportBreakout } from './useReportBreakout'

let observers: (() => void)[] = []
beforeEach(() => {
  observers = []
  vi.stubGlobal('ResizeObserver', class {
    cb: () => void
    constructor(cb: () => void) { this.cb = cb; observers.push(cb) }
    observe() {}
    disconnect() { observers = observers.filter(o => o !== this.cb) }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function rect(left: number, width: number): DOMRect {
  return { left, width, right: left + width, top: 0, bottom: 10, height: 10, x: left, y: 0, toJSON: () => ({}) } as DOMRect
}

/** The hook's answer, published on the display element (a hook may not write outside itself). */
function Probe({ active, scroller = true }: { active: boolean; scroller?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const style = useReportBreakout(ref, active)
  const inner = <div data-testid="column"><div ref={ref} data-testid="display" data-style={JSON.stringify(style ?? null)} /></div>
  return scroller ? <div data-testid="scroller" {...{ [CANVAS_SCROLL_ATTR]: '' }}>{inner}</div> : inner
}

let current: HTMLElement
const seenOf = () => JSON.parse(current.querySelector('[data-testid="display"]')!.getAttribute('data-style')!) ?? undefined

function layout(container: HTMLElement, scrollerLeft: number, scrollerClient: number, columnLeft: number, columnWidth: number) {
  const s = container.querySelector<HTMLElement>('[data-testid="scroller"]')
  const c = container.querySelector<HTMLElement>('[data-testid="column"]')!
  if (s) {
    s.getBoundingClientRect = () => rect(scrollerLeft, scrollerClient + 15)
    Object.defineProperty(s, 'clientWidth', { configurable: true, value: scrollerClient })
  }
  c.getBoundingClientRect = () => rect(columnLeft, columnWidth)
}

describe('the Report view’s breakout', () => {
  it('a gutter in from the scroll area’s edges, measured from the column wherever it sits', () => {
    const { container, rerender } = render(<Probe active={false} />)
    current = container
    layout(container, 0, 1265, 317, 654)
    rerender(<Probe active />)
    expect(seenOf()).toEqual({ width: 1265 - 48, marginLeft: 0 + 24 - 317 })
  })

  it('re-measures when a box resizes (the outline opening) and leaves the view alone when not shown', () => {
    const { container, rerender } = render(<Probe active={false} />)
    current = container
    layout(container, 0, 1265, 317, 654)
    rerender(<Probe active />)
    layout(container, 220, 1045, 465, 654)
    act(() => observers.forEach(o => o()))
    expect(seenOf()).toEqual({ width: 1045 - 48, marginLeft: 220 + 24 - 465 })
    rerender(<Probe active={false} />)
    expect(seenOf()).toBeUndefined()
  })

  it('never narrows the display, and does nothing off the Writing canvas', () => {
    const { container, rerender } = render(<Probe active={false} />)
    current = container
    layout(container, 0, 600, 20, 560)
    rerender(<Probe active />)
    expect(seenOf()).toBeUndefined()   // 600 − 48 = 552 is not wider than the 560px column
    cleanup()
    const off = render(<Probe active={false} scroller={false} />)
    current = off.container
    layout(off.container, 0, 0, 317, 654)
    off.rerender(<Probe active scroller={false} />)
    expect(seenOf()).toBeUndefined()
    expect(observers).toHaveLength(0)
  })
})
