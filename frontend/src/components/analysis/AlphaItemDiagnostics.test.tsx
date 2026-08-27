/**
 * #707a — Cronbach's alpha item diagnostics.
 *
 * The backend has always returned `item_variances` and nothing ever rendered
 * it: the reliability result is a single formatted STRING, which cannot carry a
 * per-item table. So these tests are as much about the surface existing as
 * about what it says.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import AlphaItemDiagnostics, { type AlphaItem } from './AlphaItemDiagnostics'

const items: AlphaItem[] = [
  { key: 'col:1', label: 'Item 1', variance: 2.1, item_total_r: 0.63, alpha_if_deleted: 0.11, possible_reverse_coding: false },
  { key: 'col:2', label: 'Item 2', variance: 2.4, item_total_r: 0.39, alpha_if_deleted: 0.42, possible_reverse_coding: false },
  { key: 'col:3', label: 'Reversed item', variance: 2.2, item_total_r: -0.25, alpha_if_deleted: 0.77, possible_reverse_coding: true },
]

afterEach(cleanup)

const show = (over: Partial<{ items: AlphaItem[]; alpha: number }> = {}) =>
  render(<AlphaItemDiagnostics items={over.items ?? items} alpha={over.alpha ?? 0.3} />)

describe('AlphaItemDiagnostics', () => {
  it('reports the reverse-coding finding on the COLLAPSED control', () => {
    // A finding visible only after opening a disclosure nobody opens has not
    // been reported. This is the whole value of the diagnostic.
    show()
    expect(screen.getByText(/1 item may need reverse-coding/)).toBeInTheDocument()
  })

  it('names each item rather than numbering it', () => {
    show()
    // `item_variances` was a positional list with nothing saying WHICH item,
    // which is why no surface could ever have displayed it usefully.
    fireEvent.click(screen.getByRole('button', { name: /Item diagnostics/ }))
    expect(screen.getByRole('rowheader', { name: /Reversed item/ })).toBeInTheDocument()
  })

  it('shows both diagnostics per item', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: /Item diagnostics/ }))
    expect(screen.getByText('-0.25')).toBeInTheDocument()
    expect(screen.getByText('0.77')).toBeInTheDocument()
  })

  it('renders an undefined diagnostic as an em dash, never 0.00', () => {
    // #689: `0.00` in this column reads as "this item is unrelated to the
    // scale". Alpha-if-deleted is undefined on a two-item scale — dropping one
    // leaves a single item — and a constant item has no item-total correlation.
    show({
      items: [
        { key: 'col:1', label: 'A', variance: 0, item_total_r: null, alpha_if_deleted: null, possible_reverse_coding: false },
        { key: 'col:2', label: 'B', variance: 1, item_total_r: 0.5, alpha_if_deleted: null, possible_reverse_coding: false },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: /Item diagnostics/ }))
    expect(screen.getAllByText('—').length).toBe(3)
    expect(screen.queryByText('0.00')).not.toBeInTheDocument()
  })

  it('says nothing about reverse-coding when no item is flagged', () => {
    // Two-sided: a caveat on every scale is noise that trains the reader to
    // skip it (the #726 standing-banner failure mode).
    show({ items: items.slice(0, 2) })
    expect(screen.queryByText(/reverse-coding/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Item diagnostics/ }))
    expect(screen.queryByText(/opposite direction/)).not.toBeInTheDocument()
  })

  it('renders nothing at all for a result that predates the diagnostics', () => {
    const { container } = show({ items: [] })
    expect(container).toBeEmptyDOMElement()
  })

  it('exposes the disclosure state to assistive tech', () => {
    show()
    const toggle = screen.getByRole('button', { name: /Item diagnostics/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('dual-encodes the flag rather than relying on colour', () => {
    // No colourblind mode exists in this app, so a colour-only signal is
    // invisible to some readers (the project's standing rule for per-coder and
    // status encodings).
    show()
    fireEvent.click(screen.getByRole('button', { name: /Item diagnostics/ }))
    const row = screen.getByRole('rowheader', { name: /Reversed item/ })
    expect(row.querySelector('svg')).toBeTruthy()
    expect(screen.getByText(/1 item may need reverse-coding/)).toBeInTheDocument()
  })
})
