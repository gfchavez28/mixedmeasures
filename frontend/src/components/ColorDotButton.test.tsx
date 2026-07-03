/**
 * #437 — ColorDotButton keeps the visible swatch small while guaranteeing a
 * 24×24 (WCAG 2.5.8) interactive hit area. Also covers the `asSpan` variant
 * used where the trigger is nested inside another <button>.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ColorDotButton } from './ColorDotButton'

afterEach(cleanup)

describe('ColorDotButton', () => {
  it('wraps a small dot in a 24×24 hit area', () => {
    render(<ColorDotButton color="#ff0000" aria-label="Change color" />)
    const btn = screen.getByRole('button', { name: 'Change color' })
    // 24×24 hit area (w-6/h-6 == 1.5rem == 24px)
    expect(btn.className).toContain('w-6')
    expect(btn.className).toContain('h-6')
    // Visible dot stays small and carries the color; it is aria-hidden.
    const dot = btn.querySelector('span')
    expect(dot).not.toBeNull()
    expect(dot!.className).toContain('w-3')
    expect(dot).toHaveAttribute('aria-hidden')
    expect(dot!.style.backgroundColor).toBe('rgb(255, 0, 0)')
  })

  it('forwards onClick', () => {
    const onClick = vi.fn()
    render(<ColorDotButton color="#000000" aria-label="c" onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: 'c' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders a span[role=button] when asSpan, keeping the 24px hit area', () => {
    render(<ColorDotButton asSpan color="#000000" aria-label="span color" />)
    const el = screen.getByRole('button', { name: 'span color' })
    expect(el.tagName).toBe('SPAN')
    expect(el.className).toContain('w-6')
  })

  it('honors a custom dotClassName without shrinking the hit area', () => {
    render(<ColorDotButton color="#000000" aria-label="c" dotClassName="w-4 h-4 rounded" />)
    const btn = screen.getByRole('button', { name: 'c' })
    expect(btn.className).toContain('w-6')
    expect(btn.querySelector('span')!.className).toContain('w-4')
  })

  // Regression for the actual wiring at all 7 call sites: ColorDotButton must
  // compose as a Radix `PopoverTrigger asChild` child (forwardRef + Slot onClick
  // merge) so the color picker still opens.
  it('opens a Radix popover as a PopoverTrigger asChild (button variant)', async () => {
    render(
      <Popover>
        <PopoverTrigger asChild>
          <ColorDotButton color="#000000" aria-label="pick color" />
        </PopoverTrigger>
        <PopoverContent>picker-content</PopoverContent>
      </Popover>,
    )
    expect(screen.queryByText('picker-content')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'pick color' }))
    expect(await screen.findByText('picker-content')).toBeInTheDocument()
  })

  it('opens a Radix popover as a PopoverTrigger asChild (asSpan variant)', async () => {
    render(
      <Popover>
        <PopoverTrigger asChild>
          <ColorDotButton asSpan color="#000000" aria-label="pick span" />
        </PopoverTrigger>
        <PopoverContent>span-picker</PopoverContent>
      </Popover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'pick span' }))
    expect(await screen.findByText('span-picker')).toBeInTheDocument()
  })
})
