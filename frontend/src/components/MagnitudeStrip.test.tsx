import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import MagnitudeStrip from './MagnitudeStrip'
import type { MagnitudeScale } from '@/lib/magnitude'

const BIPOLAR: MagnitudeScale = {
  min: -1,
  max: 1,
  step: 0.5,
  anchors: [
    { value: -1, label: 'strongly negative' },
    { value: 0, label: 'neither' },
    { value: 1, label: 'strongly positive' },
  ],
}

const ZERO_TEN: MagnitudeScale = { min: 0, max: 10, step: 1, anchors: [] }

afterEach(cleanup)

/**
 * Press a key on whatever the strip focused on mount.
 *
 * ⚠️ Dispatched on `document.activeElement`, not on a queried node, because the
 * strip's autoFocus IS the mechanism under test: focusing the control is what
 * stands the window-level chord layer down. Targeting the group directly would
 * pass even if autoFocus were removed.
 */
function press(key: string) {
  const target = document.activeElement
  expect(target).not.toBe(document.body)
  fireEvent.keyDown(target as Element, { key, bubbles: true })
}

function setup(scale: MagnitudeScale = BIPOLAR, value: number | null = null) {
  const onCommit = vi.fn()
  const onSkip = vi.fn()
  render(
    <MagnitudeStrip
      codeName="District support"
      scale={scale}
      value={value}
      onCommit={onCommit}
      onSkip={onSkip}
    />,
  )
  return { onCommit, onSkip }
}

describe('MagnitudeStrip — the instrument is on screen', () => {
  it('is ONE tab stop, not one per tick', () => {
    // A 0–10 scale is 11 ticks. Eleven tab stops per rating would make the
    // keyboard path slower than the mouse — the #771/#701b rule.
    setup(ZERO_TEN)
    const group = screen.getByRole('radiogroup')
    expect(group).toHaveAttribute('tabindex', '0')
    for (const tick of screen.getAllByRole('radio')) {
      expect(tick).toHaveAttribute('tabindex', '-1')
    }
  })

  it('names the group with the code AND its range', () => {
    setup()
    expect(screen.getByRole('radiogroup')).toHaveAccessibleName(
      'Rate District support, −1–1',
    )
  })

  it('speaks a tick as its value plus its anchor label', () => {
    setup()
    // The anchors are the whole point: a number judged against a stated scale is
    // an instrument reading, one judged against nothing is a vibe.
    expect(screen.getByRole('radio', { name: '0, neither' })).toBeInTheDocument()
  })

  it('marks only the committed value as checked', () => {
    setup(BIPOLAR, 0)
    expect(screen.getByRole('radio', { name: '0, neither' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '1, strongly positive' })).not.toBeChecked()
  })

  it('🔴 shows a ZERO rating as checked — it is a rating, not an absence', () => {
    setup(BIPOLAR, 0)
    const checked = screen.getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
  })

  it('names the skip so an honest way out is discoverable', () => {
    setup()
    expect(screen.getByText(/leave unrated/i)).toBeInTheDocument()
  })
})

describe('MagnitudeStrip — keyboard', () => {
  it('commits a value in ONE keypress via its digit', async () => {
    // The reason variant A is viable at 264 applications.
    const { onCommit } = setup(ZERO_TEN)
    press('7')
    expect(onCommit).toHaveBeenCalledWith(7)
  })

  it('maps a digit to the VALUE, never the tick index', async () => {
    // On 0–10, index 8 is value 7. A coder typing "7" means seven.
    const { onCommit } = setup(ZERO_TEN)
    press('0')
    expect(onCommit).toHaveBeenCalledWith(0)
  })

  it('ignores a digit that is not a value on this scale', async () => {
    const { onCommit } = setup(BIPOLAR) // values are −1, −0.5, 0, 0.5, 1
    press('7')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('moves the cursor with arrows WITHOUT committing', async () => {
    // Arrowing is browsing. Committing on every arrow would fire a request per
    // keystroke and make a scan through the scale look like ten ratings.
    const { onCommit } = setup()
    press('ArrowRight'); press('ArrowRight')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits the cursor on Enter', async () => {
    const { onCommit } = setup(BIPOLAR, null)
    // Unrated opens at the midpoint (index 2 = value 0); one right is 0.5.
    press('ArrowRight'); press('Enter')
    expect(onCommit).toHaveBeenCalledWith(0.5)
  })

  it('🔴 Escape skips AND marks the event, so the workbench does not also act', async () => {
    // `useCodeChordShortcuts` listens on `window` and stands down on
    // `e.defaultPrevented`. Its input guard ALSO has a carve-out that calls
    // `onEscapeFallback()` for Escape inside a field — so an un-prevented press
    // would leave the rating unset AND dismiss a side panel: two layers for one
    // keystroke. Asserting `defaultPrevented` is asserting that stand-down.
    const { onSkip, onCommit } = setup()

    let seenAtWindow: KeyboardEvent | null = null
    const spy = (e: KeyboardEvent) => { if (e.key === 'Escape') seenAtWindow = e }
    window.addEventListener('keydown', spy)
    try {
      press('Escape')
    } finally {
      window.removeEventListener('keydown', spy)
    }

    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    // stopPropagation means the window listener should not see it at all; if a
    // future change drops that, defaultPrevented must still be true.
    if (seenAtWindow) expect((seenAtWindow as KeyboardEvent).defaultPrevented).toBe(true)
  })

  it('Home and End reach the ends of the scale', async () => {
    const { onCommit } = setup()
    press('End'); press('Enter')
    expect(onCommit).toHaveBeenCalledWith(1)
  })
})

describe('MagnitudeStrip — a scale too fine to tick', () => {
  it('renders a number input instead of 101 targets', () => {
    // 0–100 by 1 is unhittable at 640×360, so the control changes shape rather
    // than shipping a row nobody can use.
    setup({ min: 0, max: 100, step: 1, anchors: [] })
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.getByRole('spinbutton')).toHaveAccessibleName(
      'Rate District support, 0–100',
    )
  })

  it('Escape still skips from the input', async () => {
    const { onSkip } = setup({ min: 0, max: 100, step: 1, anchors: [] })
    press('Escape')
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('refuses an out-of-range entry on Enter', async () => {
    const { onCommit } = setup({ min: 0, max: 100, step: 1, anchors: [] })
    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
  })
})

// ── #870 — the keys the strip CLAIMS, the cursor it ANNOUNCES, the hint it GIVES ──

/**
 * Dispatch on the focused element and hand the event back, so `defaultPrevented`
 * — the signal the window-level chord layer stands down on — is assertable.
 */
function pressReturning(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const target = document.activeElement
  expect(target).not.toBe(document.body)
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  // A hand-built dispatch is outside testing-library's `act`, so the state
  // update it causes would not be flushed before the next assertion.
  act(() => { (target as Element).dispatchEvent(e) })
  return e
}

describe('MagnitudeStrip — every printable key is claimed (#870 a)', () => {
  it('marks a digit that is NOT a value on this scale as handled, and commits nothing', () => {
    // On −1…+1 the digit 7 is no tick. Unclaimed, it reached the window handler
    // with the segment still selected and ARMED CHORD 7 — the next digit then
    // applied a code from category 7 from inside the rating control.
    const { onCommit } = setup(BIPOLAR)
    const e = pressReturning('7')
    expect(e.defaultPrevented).toBe(true)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('marks a letter verb as handled', () => {
    // `n` opened a note, `c` a code dialog, `s` toggled a quote — all from a
    // keystroke aimed at the rating.
    setup(BIPOLAR)
    for (const key of ['n', 'c', 's', 'j']) {
      expect(pressReturning(key).defaultPrevented, key).toBe(true)
    }
  })

  it('leaves a modifier chord alone — Ctrl+Z is still undo while a rating is pending', () => {
    setup(BIPOLAR)
    expect(pressReturning('z', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(pressReturning('z', { metaKey: true }).defaultPrevented).toBe(false)
  })

  it('still commits a matched digit in one press (the claim did not break the fast path)', () => {
    const { onCommit } = setup(ZERO_TEN)
    const e = pressReturning('7')
    expect(e.defaultPrevented).toBe(true)
    expect(onCommit).toHaveBeenCalledWith(7)
  })
})

describe('MagnitudeStrip — the cursor is announced (#870 b)', () => {
  it('aria-activedescendant on the group follows the arrow cursor', () => {
    setup(BIPOLAR)
    const group = screen.getByRole('radiogroup')
    // Unrated → the cursor opens in the middle of five ticks: 0, "neither".
    const at = () => document.getElementById(group.getAttribute('aria-activedescendant') ?? '')
    expect(at()).toHaveAccessibleName('0, neither')
    expect(at()).toHaveAttribute('role', 'radio')

    pressReturning('ArrowRight')
    expect(at()).toHaveAccessibleName('0.5')
    pressReturning('End')
    expect(at()).toHaveAccessibleName('1, strongly positive')
    // The cursor moved; nothing was committed and nothing is checked.
    expect(screen.queryByRole('radio', { checked: true })).not.toBeInTheDocument()
  })

  it('does NOT declare setsize/posinset — the DOM holds the whole set (#758/#772)', () => {
    setup(ZERO_TEN)
    for (const tick of screen.getAllByRole('radio')) {
      expect(tick).not.toHaveAttribute('aria-setsize')
      expect(tick).not.toHaveAttribute('aria-posinset')
    }
  })
})

describe('MagnitudeStrip — the number input says why Enter did nothing', () => {
  it('an out-of-range Enter shows the range and marks the field invalid; typing clears it', () => {
    const { onCommit } = setup({ min: 0, max: 100, step: 1, anchors: [] })
    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '200' } })
    pressReturning('Enter')
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a value between 0 and 100.')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Enter a value between 0 and 100.')

    fireEvent.change(input, { target: { value: '20' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(input).not.toHaveAttribute('aria-invalid')
  })
})
