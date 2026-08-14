/**
 * CodeChip — applied-code pill. Renders as a plain <span> when read-only, and
 * as a real <button> when given an onClick (so chip-driven pivots like the
 * coding-workbench "focus this code" gesture, #422a, are keyboard-accessible).
 * The click must stopPropagation so clicking a chip inside a clickable segment
 * row does not also select/toggle the row (#422a).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import CodeChip from './CodeChip'

afterEach(cleanup)

const code = { id: 7, name: 'Skepticism', color: '#3366cc', category_name: 'Climate' }

describe('CodeChip', () => {
  it('renders a non-interactive span when no onClick is provided', () => {
    render(<CodeChip code={code} />)
    const el = screen.getByText('Skepticism')
    expect(el.tagName).toBe('SPAN')
    expect(el.className).not.toContain('cursor-pointer')
  })

  it('renders a button with onClick and fires with the code id', () => {
    const onClick = vi.fn()
    render(<CodeChip code={code} onClick={onClick} />)
    const btn = screen.getByRole('button', { name: /Skepticism/ })
    expect(btn.className).toContain('cursor-pointer')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith(7)
  })

  it('stops click propagation so the surrounding row is not also triggered (#422a)', () => {
    const onClick = vi.fn()
    const onRowClick = vi.fn()
    render(
      <div onClick={onRowClick}>
        <CodeChip code={code} onClick={onClick} />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Skepticism/ }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

describe('CodeChip coder attribution badge (Track J · J1)', () => {
  /**
   * #753 — the badge is VISUAL dual-encoding; the attribution is TEXT.
   *
   * Measured in Chrome's accessibility tree: the badge's old `aria-label` did
   * reach the chip's name, but its "DA" text node stayed in the tree alongside,
   * which is what a screen reader read out beside the code. `role="img"` does
   * not prune that child; `aria-hidden` does — and hiding the span took the
   * label with it, so the attribution had to move to text of its own.
   *
   * ⚠️ jsdom cannot see the half that mattered: `computeAccessibleName` here
   * ignores ARIA's naming prohibition AND does not model the stray text node, so
   * both the old and new markup compute the same name. What IS pinned below is
   * the property the fix rests on — the initials are out of the tree and the
   * attribution is in it — which is enough to catch a revert.
   */
  it('keeps the initials visible but out of the accessibility tree', () => {
    render(<CodeChip code={code} coder={{ id: 5, username: 'Dr. Alvarez', display_color: '#ef4444' }} />)
    const initials = screen.getByTitle('coded by Dr. Alvarez')
    expect(initials).toHaveTextContent('DA')          // dual encoding, never colour-only
    expect(initials).toHaveAttribute('aria-hidden', 'true')
  })

  it('states the attribution as text, so a chip announces who coded it', () => {
    render(<CodeChip code={code} coder={{ id: 5, username: 'Dr. Alvarez', display_color: '#ef4444' }} />)
    // Present for the read-only <span> chip too — where an aria-label would be
    // on a roleless element, the shape #700 found silently dropped.
    expect(screen.getByText('coded by Dr. Alvarez')).toBeInTheDocument()
  })

  it('carries the attribution into the chip name when it is a button', () => {
    render(<CodeChip code={code} coder={{ id: 5, username: 'Dr. Alvarez', display_color: '#ef4444' }} onClick={() => {}} />)
    expect(screen.getByRole('button', { name: /Skepticism.*coded by Dr\. Alvarez/ })).toBeInTheDocument()
  })

  it('renders no badge in single-coder mode (no coder passed)', () => {
    render(<CodeChip code={code} />)
    expect(screen.getByText('Skepticism')).toBeInTheDocument()
    expect(screen.queryByText(/coded by/)).not.toBeInTheDocument()
  })

  it('renders no badge when coder is null', () => {
    render(<CodeChip code={code} coder={null} />)
    expect(screen.queryByText(/coded by/)).not.toBeInTheDocument()
  })

  it('flags an archived coder so they are not mistaken for unattributed (#451)', () => {
    render(<CodeChip code={code} coder={{ id: 11, username: 'Kwame', display_color: '#10b981', archived: true }} />)
    expect(screen.getByText('coded by Kwame (archived)')).toBeInTheDocument()
    expect(screen.getByTitle('coded by Kwame (archived)')).toHaveTextContent('KW')
  })
})
