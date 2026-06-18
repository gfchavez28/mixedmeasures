/**
 * Discoverability fix: single-button collapse-all toggle.
 *
 * Replaces the prior two icon-only chevron buttons (which researchers were
 * missing because they read as page chrome rather than as actions).
 *
 * Tests:
 *   1. Hidden when no brackets exist.
 *   2. Reads "Collapse all" when at least one bracket is expanded.
 *   3. Reads "Expand all" when every bracket is collapsed.
 *   4. Click invokes the appropriate handler based on state.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { CrosswalkHeader } from './CrosswalkHeader'
import type { DatasetToggleState } from './useDatasetToggles'

afterEach(() => cleanup())

function makeToggleState(): DatasetToggleState {
  return {
    isActive: () => true,
    toggle: () => undefined,
    activeIds: new Set(),
    isAllOff: false,
  } as unknown as DatasetToggleState
}

const baseProps = {
  searchQuery: '',
  onSearchChange: () => undefined,
  onSearchClear: () => undefined,
  datasets: [],
  toggleState: makeToggleState(),
}

describe('CrosswalkHeader collapse-all toggle', () => {
  it('hides the toggle when there are no brackets', () => {
    render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={0}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('collapse-toggle')).not.toBeInTheDocument()
  })

  it('reads "Collapse all" when at least one bracket is expanded', () => {
    render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={3}
        collapsedCount={1}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
      />,
    )
    const btn = screen.getByTestId('collapse-toggle')
    expect(btn).toHaveTextContent('Collapse all')
    expect(btn).toHaveAttribute('aria-label', 'Collapse all variable groups')
  })

  it('reads "Expand all" when every bracket is collapsed', () => {
    render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={3}
        collapsedCount={3}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
      />,
    )
    const btn = screen.getByTestId('collapse-toggle')
    expect(btn).toHaveTextContent('Expand all')
    expect(btn).toHaveAttribute('aria-label', 'Expand all variable groups')
  })

  it('calls the matching handler based on state', () => {
    const onCollapseAll = vi.fn()
    const onExpandAll = vi.fn()

    // Anything expanded → click should fire onCollapseAll
    const { unmount } = render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={3}
        collapsedCount={0}
        onCollapseAll={onCollapseAll}
        onExpandAll={onExpandAll}
      />,
    )
    fireEvent.click(screen.getByTestId('collapse-toggle'))
    expect(onCollapseAll).toHaveBeenCalledOnce()
    expect(onExpandAll).not.toHaveBeenCalled()
    unmount()

    // All collapsed → click should fire onExpandAll
    render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={3}
        collapsedCount={3}
        onCollapseAll={onCollapseAll}
        onExpandAll={onExpandAll}
      />,
    )
    fireEvent.click(screen.getByTestId('collapse-toggle'))
    expect(onExpandAll).toHaveBeenCalledOnce()
  })
})

describe('CrosswalkHeader master dot toggle', () => {
  it('renders the master toggle when onToggleAllDots is provided', () => {
    render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={0}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
        onToggleAllDots={vi.fn()}
        allDotsHidden={false}
      />,
    )
    const btn = screen.getByTestId('crosswalk-dot-master-toggle')
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(btn.getAttribute('aria-label')).toMatch(/hide all dataset/i)
  })

  it('flips the aria-label and pressed state when allDotsHidden is true', () => {
    render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={0}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
        onToggleAllDots={vi.fn()}
        allDotsHidden
      />,
    )
    const btn = screen.getByTestId('crosswalk-dot-master-toggle')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn.getAttribute('aria-label')).toMatch(/show dataset color dots/i)
  })

  it('fires onToggleAllDots when clicked', () => {
    const onToggleAllDots = vi.fn()
    render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={0}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
        onToggleAllDots={onToggleAllDots}
      />,
    )
    fireEvent.click(screen.getByTestId('crosswalk-dot-master-toggle'))
    expect(onToggleAllDots).toHaveBeenCalledOnce()
  })

  it('hides the toggle when onToggleAllDots is not provided', () => {
    render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={0}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('crosswalk-dot-master-toggle')).not.toBeInTheDocument()
  })
})

describe('CrosswalkHeader help popover (Layer 3)', () => {
  it('renders a help trigger next to the page title', () => {
    render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={0}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
      />,
    )
    const trigger = screen.getByTestId('crosswalk-help-trigger')
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-label', 'What are variable groups?')
  })

  it('opens a popover with the side-by-side and stacked explanation on click', () => {
    render(
      <CrosswalkHeader
        {...baseProps}
        bracketCount={0}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('crosswalk-help-trigger'))
    expect(screen.getByText('How variable groups work')).toBeInTheDocument()
    expect(screen.getByText(/Side-by-side cells/i)).toBeInTheDocument()
    expect(screen.getByText(/Rows stacked in a group/i)).toBeInTheDocument()
    // Vocabulary stays survey-neutral — no "items / constructs / scales"
    // hardcoded into the body copy.
    const dialog = screen.getByRole('dialog', { name: /How variable groups work/i })
    expect(dialog.textContent).not.toMatch(/respondent|construct/i)
  })
})
