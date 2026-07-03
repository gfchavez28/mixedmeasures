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
  it('renders a dual-encoded badge (initials AS TEXT + aria-label) when a coder is given', () => {
    render(<CodeChip code={code} coder={{ id: 5, username: 'Dr. Alvarez', display_color: '#ef4444' }} />)
    const badge = screen.getByLabelText('coded by Dr. Alvarez')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('DA')  // initials, never color-only
  })

  it('renders no badge in single-coder mode (no coder passed)', () => {
    render(<CodeChip code={code} />)
    expect(screen.getByText('Skepticism')).toBeInTheDocument()
    expect(screen.queryByLabelText(/coded by/)).not.toBeInTheDocument()
  })

  it('renders no badge when coder is null', () => {
    render(<CodeChip code={code} coder={null} />)
    expect(screen.queryByLabelText(/coded by/)).not.toBeInTheDocument()
  })

  it('flags an archived coder in the label so they are not mistaken for unattributed (#451)', () => {
    render(<CodeChip code={code} coder={{ id: 11, username: 'Kwame', display_color: '#10b981', archived: true }} />)
    const badge = screen.getByLabelText('coded by Kwame (archived)')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('KW')  // still attributed (initials), never anonymous
  })
})
