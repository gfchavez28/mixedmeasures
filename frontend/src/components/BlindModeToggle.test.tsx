/**
 * Track J · J2-5 blind mode (DEC-G) — the reveal toggle: dual-encoded label +
 * aria-pressed, confirm-before-reveal (logged), silent re-hide.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import BlindModeToggle from './BlindModeToggle'

afterEach(cleanup)

describe('BlindModeToggle', () => {
  // #755 — the state lives in the NAME, and the control is NOT a toggle button.
  // It used to carry aria-pressed as well, which NVDA announced as "Colleagues
  // hidden, toggle button, not pressed" — two state claims reading as opposites.
  it('names the state when blind, and claims no toggle state', () => {
    render(<BlindModeToggle blind={true} onToggle={() => {}} surface="workbench" />)
    const btn = screen.getByRole('button', { name: /Colleagues hidden/i })
    expect(btn).not.toHaveAttribute('aria-pressed')
    expect(
      btn,
      'the ACTION must still be announced, as the description',
    ).toHaveAttribute('title', expect.stringContaining('Click to reveal'))
  })

  it('names the state when revealed, and claims no toggle state', () => {
    render(<BlindModeToggle blind={false} onToggle={() => {}} surface="workbench" />)
    const btn = screen.getByRole('button', { name: /Colleagues shown/i })
    expect(btn).not.toHaveAttribute('aria-pressed')
    expect(btn).toHaveAttribute('title', expect.stringContaining('Click to hide'))
  })

  it('confirms before revealing, then calls onToggle with the surface', async () => {
    const onToggle = vi.fn()
    render(<BlindModeToggle blind={true} onToggle={onToggle} surface="workbench" />)
    fireEvent.click(screen.getByRole('button', { name: /Colleagues hidden/i }))
    const confirm = await screen.findByRole('button', { name: 'Reveal' })
    expect(onToggle).not.toHaveBeenCalled()   // not until confirmed
    fireEvent.click(confirm)
    expect(onToggle).toHaveBeenCalledWith('workbench')
  })

  it('re-hides immediately (no confirm, no surface → no log) when revealed', () => {
    const onToggle = vi.fn()
    render(<BlindModeToggle blind={false} onToggle={onToggle} surface="workbench" />)
    fireEvent.click(screen.getByRole('button', { name: /Colleagues shown/i }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith()   // no surface → toggleReveal won't log
  })
})
