/**
 * The Variables view's observed-value summary (#809).
 *
 * The assertions are chosen around the two properties that were actually wrong,
 * not around the markup: the panel must be BOUNDED (it rendered 4,510 rows
 * unclamped on real GSS data) and it must not TRUNCATE (its payload also seeds a
 * recode's key set and the value-label dictionary, so a cap would be a data
 * defect wearing a performance fix's clothes).
 */
import { describe, it, expect, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ValueFrequenciesPanel } from './ValueFrequenciesPanel'
import { VALUE_LABEL_SEED_MAX_CODES } from '@/lib/dataset-constants'

afterEach(cleanup)

/** n distinct values, count-descending like the endpoint returns them. */
function payload(n: number) {
  return {
    frequencies: Array.from({ length: n }, (_, i) => ({
      value_text: `v${i}`,
      count: n - i,
      is_na: false,
    })),
    total: (n * (n + 1)) / 2,
  }
}

describe('ValueFrequenciesPanel', () => {
  it('opens for a code list and stays folded for a continuous column', () => {
    const { unmount } = render(<ValueFrequenciesPanel data={payload(5)} />)
    expect(screen.getByRole('button', { name: /Observed values/ })).toHaveAttribute('aria-expanded', 'true')
    unmount()

    render(<ValueFrequenciesPanel data={payload(VALUE_LABEL_SEED_MAX_CODES + 1)} />)
    expect(screen.getByRole('button', { name: /Observed values/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('folds correctly when the payload arrives AFTER mount', () => {
    // 🔴 The regression this file existed without. Every other test here hands
    // the component its data on the first render, which is the one thing that
    // never happens in the app: the query is in flight when the panel mounts.
    // A `useState(distinct <= N)` initialiser therefore saw `distinct === 0` and
    // fixed the panel OPEN before the real count existed — measured live on GSS
    // `year` (35 distinct), rendering expanded. The fold did not work for a
    // single variable it was written for, and all five tests were green.
    const { rerender } = render(<ValueFrequenciesPanel data={undefined} />)
    rerender(<ValueFrequenciesPanel data={payload(VALUE_LABEL_SEED_MAX_CODES + 5)} />)
    expect(screen.getByRole('button', { name: /Observed values/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the researcher\'s own choice once they make it', () => {
    // The flip side: deriving from cardinality must not override a click.
    render(<ValueFrequenciesPanel data={payload(3)} />)
    const toggle = screen.getByRole('button', { name: /Observed values/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('states the distinct count even while folded, so the fold is informative', () => {
    render(<ValueFrequenciesPanel data={payload(4510)} />)
    // The number is the reason it is folded and what opening it costs. A bare
    // collapsed heading would just look like a hidden section.
    expect(screen.getByText('4,510 distinct')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('scrolls inside a bounded box rather than growing the page (#383/#385)', () => {
    const { container } = render(<ValueFrequenciesPanel data={payload(5)} />)
    // The marker is load-bearing beyond layout: `lib/chart-export.tsx` un-clamps
    // these during capture.
    const box = container.querySelector('[data-scrollable-table]')
    expect(box, 'the table must live in a ScrollableTable').not.toBeNull()
    expect(box).toHaveStyle({ maxHeight: '20rem' })
  })

  it('renders EVERY value once opened — nothing is truncated', () => {
    // 🔴 The anti-LIMIT assertion. The same payload seeds `getLabels`' recode
    // key set and `ColumnDictionaryEditor`'s dictionary, so a cap anywhere in
    // this chain would silently produce an incomplete rule. If a future change
    // slices the list for display, it must disclose "showing N of M" — and this
    // test is where that decision has to be made explicitly.
    const n = VALUE_LABEL_SEED_MAX_CODES + 12
    render(<ValueFrequenciesPanel data={payload(n)} />)
    fireEvent.click(screen.getByRole('button', { name: /Observed values/ }))
    expect(screen.getAllByRole('row')).toHaveLength(n + 1) // + the header row
  })

  it('renders nothing at all when the column has no observed values', () => {
    const { container } = render(<ValueFrequenciesPanel data={payload(0)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
