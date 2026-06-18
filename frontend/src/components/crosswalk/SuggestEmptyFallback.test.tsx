/**
 * Tests for SuggestEmptyFallback (Phase 4.2).
 *
 * Three CTAs (directive §2 item 42):
 *   1. Browse unassigned    → onBrowseUnassigned()
 *   2. Create blank group   → onCreateBlank()
 *   3. Drop target          → reuses NEW_BRACKET_TILE_DROP_ID
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DndContext } from '@dnd-kit/core'
import { SuggestEmptyFallback } from './SuggestEmptyFallback'

afterEach(() => cleanup())

function renderFallback(props: Partial<Parameters<typeof SuggestEmptyFallback>[0]> = {}) {
  const defaults = {
    onBrowseUnassigned: vi.fn(),
    onCreateBlank: vi.fn(),
  }
  return render(
    <DndContext>
      <SuggestEmptyFallback {...defaults} {...props} />
    </DndContext>,
  )
}

describe('SuggestEmptyFallback', () => {
  it('renders all three CTAs', () => {
    renderFallback()
    expect(screen.getByRole('button', { name: /Browse unassigned/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create variable group/i })).toBeInTheDocument()
    // Third CTA is a drop target (div, not a button) — assert by testid + a11y label
    expect(screen.getByTestId('empty-fallback-droptarget')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Drop a column here to start a new variable group'),
    ).toBeInTheDocument()
  })

  it('shows the discoverability tip about manual building', () => {
    renderFallback()
    expect(
      screen.getByText(/works best when datasets use similar column naming/i),
    ).toBeInTheDocument()
  })

  it('Browse Unassigned click fires onBrowseUnassigned', () => {
    const onBrowseUnassigned = vi.fn()
    renderFallback({ onBrowseUnassigned })
    fireEvent.click(screen.getByRole('button', { name: /Browse unassigned/i }))
    expect(onBrowseUnassigned).toHaveBeenCalledOnce()
  })

  it('Create blank click fires onCreateBlank', () => {
    const onCreateBlank = vi.fn()
    renderFallback({ onCreateBlank })
    fireEvent.click(screen.getByRole('button', { name: /Create variable group/i }))
    expect(onCreateBlank).toHaveBeenCalledOnce()
  })
})
