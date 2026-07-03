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
  it('shows "Colleagues hidden" + aria-pressed=false when blind', () => {
    render(<BlindModeToggle blind={true} onToggle={() => {}} surface="workbench" />)
    expect(screen.getByRole('button', { name: /Colleagues hidden/i }))
      .toHaveAttribute('aria-pressed', 'false')
  })

  it('shows "Colleagues shown" + aria-pressed=true when revealed', () => {
    render(<BlindModeToggle blind={false} onToggle={() => {}} surface="workbench" />)
    expect(screen.getByRole('button', { name: /Colleagues shown/i }))
      .toHaveAttribute('aria-pressed', 'true')
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
