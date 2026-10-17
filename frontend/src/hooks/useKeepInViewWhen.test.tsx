/**
 * #1139 — the footer of a height-capped dialog is scrolled back into view when the
 * dialog starts working, and only then.
 */
import { describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { render } from '@testing-library/react'
import { useKeepInViewWhen } from './useKeepInViewWhen'

function Footer({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useKeepInViewWhen(active, ref)
  return <div ref={ref} data-testid="footer" />
}

describe('useKeepInViewWhen', () => {
  it('scrolls the element into view, nearest, when the state begins', () => {
    const spy = vi.fn()
    HTMLElement.prototype.scrollIntoView = spy
    const { rerender } = render(<Footer active={false} />)
    expect(spy).not.toHaveBeenCalled()
    rerender(<Footer active />)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ block: 'nearest' })
    rerender(<Footer active />)
    expect(spy).toHaveBeenCalledTimes(1)
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('does not throw where scrollIntoView does not exist (jsdom)', () => {
    expect(() => render(<Footer active />)).not.toThrow()
  })
})
