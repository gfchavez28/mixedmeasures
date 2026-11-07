/**
 * #1324 — the defensive refusal: a selection is refused when the passage on screen is
 * not its stored text.
 *
 * `charOffsetInElement` counts RENDERED characters, so its offset is an offset into
 * the stored text only when the two are identical. The refusal is what stops a wrong
 * offset from reaching a quote, a split or a coding — and the control below proves the
 * same drag over a faithful rendering still selects, so the guard cannot pass by
 * refusing everything.
 *
 * jsdom has no `caretPositionFromPoint`, so it is stubbed to map clientX → a position
 * in the passage's first text node; and no layout, so the selection is stubbed too.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, renderHook, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { useTextSplitSelection, SELECTION_TEXT_MISMATCH } from './useTextSplitSelection'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const STORED = 'We rolled it out in March and nobody was ready.'

// Module-scope on purpose: the hook clears its selection whenever `segments` changes
// identity, so an inline array would clear it on every render.
const SEGMENTS = [{ id: 5, text: STORED, sequence_order: 0 }]
const NOOP_SPLIT = () => {}

/** The passage as a workbench draws it, then the hook listening on its container. */
function mount(rendered: string, selection: { collapsed: boolean } = { collapsed: false }) {
  const { container } = render(
    <div>
      <div id="segment-5">
        <div data-segment-id="5">{rendered}</div>
      </div>
    </div>,
  )
  const root = container.firstChild as HTMLElement
  const ref = { current: root }
  const hook = renderHook(() => useTextSplitSelection(ref, SEGMENTS, NOOP_SPLIT))

  const textNode = root.querySelector('[data-segment-id="5"]')!.firstChild!
  ;(document as unknown as { caretPositionFromPoint: unknown }).caretPositionFromPoint =
    (x: number) => ({ offsetNode: textNode, offset: x })
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: selection.collapsed,
    toString: () => (selection.collapsed ? '' : 'selected'),
    rangeCount: 0,
    removeAllRanges: vi.fn(),
  } as unknown as Selection)

  const drag = (from: number, to: number) => {
    fireEvent.mouseDown(root, { button: 0, clientX: from, clientY: 1 })
    fireEvent.mouseUp(root, { button: 0, clientX: to, clientY: 1 })
  }
  return { hook, drag }
}

beforeEach(() => { toastError.mockClear() })
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint
})

describe('#1324 — a selection over text that is not the stored text is refused', () => {
  it('CONTROL: over a faithful rendering the same drag selects the stored words', async () => {
    const { hook, drag } = mount(STORED)
    drag(30, 36)
    await waitFor(() => expect(hook.result.current.splitSelection).not.toBeNull())
    const r = hook.result.current.splitSelection!.ranges[0]
    expect(STORED.slice(r.start_offset, r.end_offset)).toBe('nobody')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('over the pre-#1324 doubled rendering the drag is refused, in both channels', async () => {
    // What HEAD drew for quotes [4,23) + [15,34): the shared words twice. Offsets
    // 38–44 of THIS text are "nobody" — of the stored text they are "as rea".
    const doubled = 'We rolled it out in Mart in March and nobody was ready.'
    expect(doubled.slice(38, 44)).toBe('nobody')
    expect(STORED.slice(38, 44)).toBe('as rea')
    const { hook, drag } = mount(doubled)
    drag(38, 44)
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(SELECTION_TEXT_MISMATCH))
    expect(hook.result.current.splitSelection).toBeNull()
    expect(hook.result.current.announcement).toBe(SELECTION_TEXT_MISMATCH)
  })

  it('the ANCHOR is judged by the text it was read from, even when the text is right again by mouseup', async () => {
    // The shape of a tooltip fading out under the press: wrong text at mousedown, the
    // stored text by mouseup. The anchor offset was already read from the wrong text.
    const { hook } = mount('Note text. ' + STORED)
    const root = document.querySelector('[data-segment-id="5"]')!.parentElement!.parentElement as HTMLElement
    const textNode = root.querySelector('[data-segment-id="5"]')!.firstChild as Text
    fireEvent.mouseDown(root, { button: 0, clientX: 41, clientY: 1 })
    textNode.data = STORED
    fireEvent.mouseUp(root, { button: 0, clientX: 36, clientY: 1 })
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(SELECTION_TEXT_MISMATCH))
    expect(hook.result.current.splitSelection).toBeNull()
  })

  it('a plain click (no selection) never raises it, even over mismatched text', async () => {
    const { drag } = mount('X' + STORED, { collapsed: true })
    drag(3, 3)
    await new Promise(r => requestAnimationFrame(() => r(null)))
    await new Promise(r => setTimeout(r, 20))
    expect(toastError).not.toHaveBeenCalled()
  })
})
