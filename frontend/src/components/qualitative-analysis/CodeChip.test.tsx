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

describe('CodeChip — magnitude (#35)', () => {
  const code = { id: 1, name: 'District support', color: '#3b82f6' }
  const BIPOLAR = {
    min: -1,
    max: 1,
    step: 0.5,
    anchors: [
      { value: -1, label: 'strongly negative' },
      { value: 0, label: 'neither' },
      { value: 1, label: 'strongly positive' },
    ],
  }

  it('#35 merge flag — shows the OTHER number beside the kept rating, and says so as text', () => {
    render(<CodeChip code={code} magnitude={0.5} scale={BIPOLAR} magnitudeConflict={-1} />)
    // The kept rating is still the rating…
    expect(screen.getByText(/, 0\.5 on a scale from −1 to 1/)).toBeInTheDocument()
    // …and the merged copy's value is a separate fact, spoken as such.
    expect(screen.getByText(/, a merged copy rated it −1/)).toBeInTheDocument()
    expect(screen.getByTitle(/A merged copy of your coding rated this −1; your rating was kept/)).toBeInTheDocument()
  })

  it('#35 merge flag — a copy that rated ZERO is a conflict, not "no conflict"', () => {
    render(<CodeChip code={code} magnitude={1} scale={BIPOLAR} magnitudeConflict={0} />)
    expect(screen.getByText(/a merged copy rated it 0/)).toBeInTheDocument()
  })

  it('#35 merge flag — renders nothing without a conflict, and nothing without a scale', () => {
    const { rerender } = render(<CodeChip code={code} magnitude={0.5} scale={BIPOLAR} magnitudeConflict={null} />)
    expect(screen.queryByText(/merged copy/)).toBeNull()
    rerender(<CodeChip code={code} magnitude={0.5} scale={null} magnitudeConflict={-1} />)
    expect(screen.queryByText(/merged copy/)).toBeNull()
  })

  it('renders NO magnitude UI when the code has no declared scale', () => {
    // A number with no instrument is exactly the MAXQDA "fuzzy variable" this
    // feature exists not to be, so a scale-less code is chipped as before.
    render(<CodeChip code={code} magnitude={0.5} scale={null} />)
    expect(screen.queryByText('0.5')).not.toBeInTheDocument()
  })

  it('carries the whole fact as TEXT, because the bar announces nothing', () => {
    // #753's split: the visual encoding is aria-hidden, the meaning is sr-only
    // text that reaches the accessible name through name-from-contents.
    render(<CodeChip code={code} magnitude={0.5} scale={BIPOLAR} />)
    expect(screen.getByText(/on a scale from −1 to 1/)).toBeInTheDocument()
  })

  it('speaks an anchor label when the value has one', () => {
    render(<CodeChip code={code} magnitude={0} scale={BIPOLAR} />)
    expect(screen.getByText(/neither/)).toBeInTheDocument()
  })

  it('🔴 a ZERO rating announces as a rating, not as unrated', () => {
    // The falsy-zero trap at the render layer. `!magnitude` here would print
    // "not rated" over a real, meaningful neutral.
    render(<CodeChip code={code} magnitude={0} scale={BIPOLAR} />)
    expect(screen.queryByText(/not rated/)).not.toBeInTheDocument()
  })

  it('announces an unrated application as "not rated", never as 0', () => {
    render(<CodeChip code={code} magnitude={null} scale={BIPOLAR} />)
    expect(screen.getByText(/not rated/)).toBeInTheDocument()
  })

  it('renders a Unicode minus so −1 cannot be misread as 1 at 10px', () => {
    render(<CodeChip code={code} magnitude={-1} scale={BIPOLAR} />)
    expect(screen.getByText('−1')).toBeInTheDocument()
  })
})
