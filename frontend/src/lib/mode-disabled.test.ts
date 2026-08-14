/**
 * #754 — a control blocked by a persistent mode stays reachable and says why.
 *
 * The load-bearing assertion here is the click guard. `aria-disabled` is
 * advisory: it changes what the control ANNOUNCES and nothing about what it
 * DOES, so an aria-disabled control wired straight to its action is strictly
 * worse than a natively disabled one — it looks unavailable, announces
 * unavailable, and fires. Enter and Space arrive through the same handler, so
 * guarding the click covers the keyboard too.
 */
import { describe, it, expect, vi } from 'vitest'
import type { MouseEvent } from 'react'

import { modeDisabledProps, MODE_DISABLED_CLASS } from './mode-disabled'

const fakeEvent = () => ({
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
}) as unknown as MouseEvent<HTMLButtonElement> & {
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
}

describe('modeDisabledProps — blocked by a mode', () => {
  const blocked = (onActivate = vi.fn()) => ({
    onActivate,
    props: modeDisabledProps<HTMLButtonElement>({
      label: 'Split clip at playhead',
      blockedReason: 'unavailable while the clip set is frozen',
      onActivate,
    }),
  })

  it('stays focusable — the tab stop IS the disclosure', () => {
    expect(blocked().props.disabled).toBe(false)
    expect(blocked().props['aria-disabled']).toBe(true)
  })

  it('puts the reason in the name, where a screen reader will reach it', () => {
    expect(blocked().props['aria-label'])
      .toBe('Split clip at playhead — unavailable while the clip set is frozen')
  })

  it('does not activate — and this is the whole risk of aria-disabled', () => {
    const onActivate = vi.fn()
    const { props } = blocked(onActivate)
    const event = fakeEvent()
    props.onClick(event)
    expect(onActivate).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
  })

  it('outranks a transient reason — the mode is the one worth explaining', () => {
    const props = modeDisabledProps<HTMLButtonElement>({
      label: 'Merge selected clips',
      blockedReason: 'unavailable while the clip set is frozen',
      unavailable: true,
      onActivate: vi.fn(),
    })
    expect(props.disabled).toBe(false)
    expect(props['aria-label']).toContain('frozen')
  })
})

describe('modeDisabledProps — transient, or available', () => {
  it('a transient precondition stays NATIVELY disabled (no tab stop earned)', () => {
    const props = modeDisabledProps<HTMLButtonElement>({
      label: 'Merge selected clips',
      blockedReason: null,
      unavailable: true,
      onActivate: vi.fn(),
    })
    expect(props.disabled).toBe(true)
    expect(props['aria-disabled']).toBeUndefined()
    // ⚠️ Never both: `aria-disabled` on an already-disabled control is
    // redundant at best, and #752 is what it costs when it lands on the wrong
    // element and propagates.
    expect(props['aria-label']).toBe('Merge selected clips')
  })

  it('an available control activates and carries its plain name', () => {
    const onActivate = vi.fn()
    const props = modeDisabledProps<HTMLButtonElement>({
      label: 'Split clip at playhead', blockedReason: null, onActivate,
    })
    expect(props.disabled).toBe(false)
    props.onClick(fakeEvent())
    expect(onActivate).toHaveBeenCalledOnce()
  })
})

describe('MODE_DISABLED_CLASS', () => {
  it('restates the disabled look on the aria variant, since disabled: cannot fire', () => {
    expect(MODE_DISABLED_CLASS).toContain('aria-disabled:opacity-50')
  })

  it('keeps pointer events — the tooltip is how a sighted user reads the reason', () => {
    expect(MODE_DISABLED_CLASS).not.toContain('pointer-events-none')
  })
})
