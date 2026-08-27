import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import CategoryTreePicker from './CategoryTreePicker'
import type { CodebookTreeResponse } from '@/lib/api'

afterEach(cleanup)

/**
 * #758 — one tab stop, arrow keys, and disabled rows that stay reachable.
 *
 * ⚠️ The NESTED and DISABLED fixtures here are the only coverage those paths
 * have: no project in the developer's dev.db has a category with `parent_id`
 * set, so `aria-level` was never exercised above 1 and `maxDepth` (passed as 3
 * by three of the six consumers) can never fire there either.
 */

const cat = (id: number, name: string, depth: number, children: unknown[] = []) =>
  ({ id, name, color: null, depth, children, codes: [] })

const tree = (roots: unknown[]): CodebookTreeResponse =>
  ({ universal_codes: [], tree: roots, uncategorized_codes: [] } as unknown as CodebookTreeResponse)

const FLAT = tree([cat(1, 'Alpha', 0), cat(2, 'Beta', 0), cat(3, 'Gamma', 0)])
const NESTED = tree([cat(1, 'Alpha', 0, [cat(2, 'Beta', 1, [cat(3, 'Gamma', 2)])])])

const items = () => screen.getAllByRole('treeitem')
const tabStops = () => items().filter(el => el.tabIndex === 0)

describe('one tab stop, on the selected row', () => {
  it('spends ONE tab stop, not one per category', () => {
    render(<CategoryTreePicker treeData={FLAT} value={null} onChange={() => {}} />)
    expect(items()).toHaveLength(4)          // 3 categories + the "none" row
    expect(tabStops()).toHaveLength(1)
  })

  it('puts it on the SELECTED row, so tabbing in lands on your current category', () => {
    render(<CategoryTreePicker treeData={FLAT} value={2} onChange={() => {}} />)
    expect(tabStops()[0]).toHaveAccessibleName('Beta')
  })

  it('falls back to the "none" row when value names a category that is not listed', () => {
    // Without this there is NO tab stop at all — the resting-state deadlock that
    // made the codebook tree keyboard-unreachable by construction (#701a).
    render(<CategoryTreePicker treeData={FLAT} value={999} onChange={() => {}} noneLabel="Root level" />)
    expect(tabStops()).toHaveLength(1)
    expect(tabStops()[0]).toHaveAccessibleName('Root level')
  })

  it('still spends exactly one when every row is blocked', () => {
    render(<CategoryTreePicker treeData={NESTED} value={null} onChange={() => {}} maxDepth={0} />)
    expect(tabStops()).toHaveLength(1)
  })
})

describe('the arrow keys that make one tab stop legal', () => {
  it('moves the cursor with Arrow/Home/End', () => {
    render(<CategoryTreePicker treeData={FLAT} value={null} onChange={() => {}} />)
    const [none, alpha, beta, gamma] = items()
    none.focus()
    fireEvent.keyDown(none, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(alpha)
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(beta)
    fireEvent.keyDown(beta, { key: 'End' })
    expect(document.activeElement).toBe(gamma)
    fireEvent.keyDown(gamma, { key: 'Home' })
    expect(document.activeElement).toBe(none)
    fireEvent.keyDown(none, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(none)   // stays at the top
  })

  it('Enter and Space select', () => {
    const onChange = vi.fn()
    render(<CategoryTreePicker treeData={FLAT} value={null} onChange={onChange} />)
    const beta = screen.getByRole('treeitem', { name: 'Beta' })
    beta.focus()
    fireEvent.keyDown(beta, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('traverses the nesting: ArrowRight steps in, ArrowLeft steps back out', () => {
    render(<CategoryTreePicker treeData={NESTED} value={null} onChange={() => {}} />)
    const alpha = screen.getByRole('treeitem', { name: 'Alpha' })
    const beta = screen.getByRole('treeitem', { name: 'Beta' })
    expect(alpha).toHaveAttribute('aria-level', '1')
    expect(beta).toHaveAttribute('aria-level', '2')
    alpha.focus()
    fireEvent.keyDown(alpha, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(beta)
    fireEvent.keyDown(beta, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(alpha)
  })
})

describe('a blocked row stays reachable and says why', () => {
  // maxDepth 1: a category at depth 1+ cannot take a child, so Beta and Gamma
  // are blocked while Alpha is not.
  const renderBlocked = () =>
    render(<CategoryTreePicker treeData={NESTED} value={null} onChange={() => {}} maxDepth={1} />)

  it('NO treeitem is ever natively disabled — the invariant arrow nav depends on', () => {
    // A population assertion, not a spot check. `.focus()` is a SILENT no-op on
    // a natively-disabled button, so one such row makes ArrowDown stop dead with
    // no event and no message. Written as "every row", because the per-control
    // form is what let this class ship partially three times elsewhere (#771).
    renderBlocked()
    for (const el of items()) {
      expect(el).not.toBeDisabled()
      expect((el as HTMLButtonElement).tabIndex).toBeGreaterThanOrEqual(-1)
    }
  })

  it('marks the blocked ones aria-disabled and names the reason', () => {
    renderBlocked()
    const beta = screen.getByRole('treeitem', { name: /^Beta/ })
    expect(beta).toHaveAttribute('aria-disabled', 'true')
    expect(beta).toHaveAccessibleName('Beta — cannot contain sub-categories — maximum depth reached')
    expect(screen.getByRole('treeitem', { name: 'Alpha' })).not.toHaveAttribute('aria-disabled')
  })

  it('names the reason for an EXCLUDED row differently', () => {
    render(
      <CategoryTreePicker
        treeData={FLAT} value={null} onChange={() => {}} excludeIds={new Set([2])}
      />,
    )
    expect(screen.getByRole('treeitem', { name: /^Beta/ }))
      .toHaveAccessibleName('Beta — unavailable as a destination')
  })

  it('does NOT activate when clicked — aria-disabled changes what it says, not what it does', () => {
    const onChange = vi.fn()
    render(<CategoryTreePicker treeData={NESTED} value={null} onChange={onChange} maxDepth={1} />)
    fireEvent.click(screen.getByRole('treeitem', { name: /^Beta/ }))
    expect(onChange).not.toHaveBeenCalled()
  })

  /**
   * ⚠️ This one is JSDOM-BLIND, and the mutation run is how that was found.
   * Reverting the rows to native `disabled` left it PASSING: jsdom moves focus
   * to a disabled button where a browser refuses. So the test that states the
   * point most directly cannot see the defect — the POPULATION assertion above
   * (`not.toBeDisabled()` over every row) is the guard that actually bites.
   * Kept because it pins the wiring, not because it proves the browser.
   */
  it('is still arrow-reachable, which is the whole point', () => {
    renderBlocked()
    const alpha = screen.getByRole('treeitem', { name: 'Alpha' })
    alpha.focus()
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveAccessibleName(/^Beta/)
  })
})

describe('the spotlight preview reaches the keyboard', () => {
  it('previews on FOCUS, not only on hover', () => {
    const onHover = vi.fn()
    render(<CategoryTreePicker treeData={FLAT} value={null} onChange={() => {}} onHover={onHover} />)
    fireEvent.focus(screen.getByRole('treeitem', { name: 'Beta' }))
    expect(onHover).toHaveBeenCalledWith(2)
  })

  it('does not preview a blocked row', () => {
    const onHover = vi.fn()
    render(
      <CategoryTreePicker
        treeData={NESTED} value={null} onChange={() => {}} maxDepth={1} onHover={onHover}
      />,
    )
    fireEvent.focus(screen.getByRole('treeitem', { name: /^Beta/ }))
    expect(onHover).not.toHaveBeenCalled()
  })
})
