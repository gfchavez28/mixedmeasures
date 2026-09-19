/**
 * #959 — the opener is read during RENDER, so it cannot depend on where the
 * capture sits among a dialog's children.
 *
 * The wrappers render the capture FIRST, and with that order a layout-effect
 * read happens to work too (it runs before a later sibling's `autoFocus`) — a
 * mutant proved it. This pins the reason render-time is still the rule: an
 * `autoFocus` element rendered BEFORE the capture moves focus first.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { FocusReturnCapture } from './focus-return-capture'
import type { FocusTarget } from '@/lib/dialog-focus-return'

afterEach(() => { cleanup(); document.body.innerHTML = '' })

describe('FocusReturnCapture', () => {
  it('records the element focused BEFORE the dialog rendered, even past an earlier autoFocus sibling', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Open'
    document.body.appendChild(opener)
    act(() => { opener.focus() })

    const onStart = vi.fn((_t: FocusTarget | null) => () => {})
    render(
      <div>
        <input aria-label="Name" autoFocus />
        <FocusReturnCapture onStart={onStart} />
      </div>,
    )
    expect(document.activeElement).toHaveProperty('tagName', 'INPUT')
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart.mock.calls[0][0]?.el).toBe(opener)
  })

  it('stops recording when it unmounts', () => {
    const stop = vi.fn()
    const { unmount } = render(<FocusReturnCapture onStart={() => stop} />)
    expect(stop).not.toHaveBeenCalled()
    unmount()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
