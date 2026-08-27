/**
 * #646 — lane collapse, reachable without a mouse.
 *
 * The lane label row collapses its lane on click and has no role, no tabIndex
 * and no `aria-expanded`. It cannot be fixed in place: it sits inside the
 * timeline's `aria-hidden` visual layer, where a focusable control would be the
 * `aria-hidden-focus` violation — it would take focus and announce nothing,
 * which is worse than mouse-only. The control therefore lives in the TOOLBAR,
 * outside the hidden layer, as a single menu.
 *
 * ⚠️ The load-bearing test here is the POPULATION one: *nothing inside the
 * aria-hidden subtree is focusable*. Asserting "the menu exists" would pass
 * just as happily on an implementation that also left a focusable control in
 * the hidden layer, which is the exact defect this fix exists to avoid
 * introducing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import ClipTimeline from './ClipTimeline'
import type { TimelineLane } from '@/lib/clip-timeline'

afterEach(cleanup)

type Clip = { id: number; start_time: number; end_time: number; text: string }

const clip = (id: number, start: number, end: number): Clip =>
  ({ id, start_time: start, end_time: end, text: `Clip ${id}` })

const CLIPS = [clip(1, 0, 5), clip(2, 6, 10), clip(3, 12, 18)]

const lane = (key: string, label: string, clips: Clip[]) =>
  ({ key, label, clips }) as unknown as TimelineLane<never>

/** Two lanes with headers — the shape a coded observation produces. */
const LANES = [
  lane('cat-1', 'Fidelity', [CLIPS[0], CLIPS[1]]),
  lane('uncoded', 'Uncoded', [CLIPS[2]]),
]

/** A lone Uncoded lane: the headerless "slab-3 look", nothing to collapse. */
const LONE_UNCODED = [lane('uncoded', 'Uncoded', CLIPS)]

/**
 * Open the Lanes menu FROM THE KEYBOARD.
 *
 * Deliberately not a click: #646 is a keyboard-reachability defect, so the
 * gesture under test is the keyboard one. (Radix also opens its trigger on
 * `pointerdown` rather than `click`, so a `fireEvent.click` here silently does
 * nothing and every assertion after it fails looking for a menu that never
 * opened — which is how this helper came to exist.)
 */
function openLanesMenu() {
  const trigger = screen.getByRole('button', { name: 'Lanes' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return trigger
}

function renderTimeline(lanes = LANES) {
  return render(
    <ClipTimeline
      clips={CLIPS as never}
      lanes={lanes as never}
      extentSeconds={20}
      recordingEndSeconds={20}
      currentTime={null}
      selectedIds={[]}
      frozen={false}
      armedInTime={null}
      isPlaying={false}
      boundaryPreview={null}
      onSeek={vi.fn()}
      onClipClick={vi.fn()}
      onCreateRange={vi.fn()}
      onCreatePoint={vi.fn()}
      onBoundaryCommit={vi.fn()}
    />,
  )
}

/** The timeline's visual layer — the subtree the accessible tree must not enter. */
const hiddenLayer = (c: HTMLElement) => c.querySelector('[aria-hidden]:not(svg)')

describe('#646 — the lane control is reachable without a mouse', () => {
  it('offers a Lanes menu in the toolbar', () => {
    renderTimeline()
    expect(screen.getByRole('button', { name: 'Lanes' })).toBeInTheDocument()
  })

  it('🔴 puts NOTHING focusable inside the aria-hidden layer', () => {
    // The population assertion, and the reason this control is in the toolbar
    // at all. The filed fix (role="button" + tabIndex on the lane label) would
    // fail here — which is why it was rejected rather than applied.
    const { container } = renderTimeline()
    const hidden = hiddenLayer(container)
    expect(hidden, 'the visual layer must exist to be judged').not.toBeNull()

    const focusable = hidden!.querySelectorAll(
      'a[href],button,input,select,textarea,[tabindex],[role="button"]',
    )
    expect(
      [...focusable].map(el => el.outerHTML.slice(0, 80)),
      'a focusable control inside aria-hidden announces nothing — worse than mouse-only',
    ).toEqual([])
  })

  it('the menu is one tab stop, not one per lane', () => {
    // Per-lane toolbar buttons were the rejected alternative: lanes are code
    // categories, so the count is open-ended (#758/#771 class).
    renderTimeline([
      lane('cat-1', 'A', [CLIPS[0]]), lane('cat-2', 'B', [CLIPS[1]]),
      lane('cat-3', 'C', [CLIPS[2]]), lane('uncoded', 'Uncoded', []),
    ])
    const stops = [...document.querySelectorAll('button,[tabindex="0"]')]
      .filter(el => /lane/i.test(el.textContent || '') || el.textContent === 'Lanes')
    expect(stops).toHaveLength(1)
  })

  it('lists every lane with its clip count, checked when expanded', () => {
    renderTimeline()
    openLanesMenu()
    const items = screen.getAllByRole('menuitemcheckbox')
    expect(items.map(i => i.textContent)).toEqual(['Fidelity (2)', 'Uncoded (1)'])
    for (const item of items) expect(item).toHaveAttribute('aria-checked', 'true')
  })

  it('unchecking an item collapses that lane, and the menu stays open', () => {
    renderTimeline()
    openLanesMenu()
    const fidelity = screen.getByRole('menuitemcheckbox', { name: /Fidelity/ })
    fireEvent.click(fidelity)

    // Still open — collapsing several lanes is one gesture, not N round trips.
    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Fidelity/ }))
      .toHaveAttribute('aria-checked', 'false')
    // The other lane is untouched.
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Uncoded/ }))
      .toHaveAttribute('aria-checked', 'true')
  })

  it('says what unchecking DOES — collapse is not hide', () => {
    // A collapsed lane keeps its label row and loses only its bars, so a bare
    // lane name would read as "hide this lane".
    renderTimeline()
    openLanesMenu()
    expect(screen.getByText('Show lane contents')).toBeInTheDocument()
  })

  it('offers no menu when a lone Uncoded lane renders headerless', () => {
    // `collapsed` is forced false there, so the control would do nothing.
    renderTimeline(LONE_UNCODED)
    expect(screen.queryByRole('button', { name: 'Lanes' })).not.toBeInTheDocument()
  })
})
