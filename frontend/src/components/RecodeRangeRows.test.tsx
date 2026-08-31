/**
 * The range-band editor's disclosure — #861, 2026-08-31.
 *
 * The MATCHER is proven elsewhere (`lib/recode-ranges.test.ts`, against a
 * fixture the Python suite executes too). What this file defends is the thing a
 * researcher reads while authoring: **which channel wins**.
 *
 * 🔴 That sentence used to live inside the empty state, so it disappeared the
 * moment the first row existed — absent exactly while somebody was typing bands
 * and deciding what they do. And it named only *mapped* responses, which after
 * #861 is incomplete in the way the defect itself was: an EXCLUDED response
 * keeps its exclusion rather than taking a band's value.
 */
import { useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import RecodeRangeRows from './RecodeRangeRows'
import type { RangeRow } from '@/lib/recode-ranges'

afterEach(cleanup)

function Harness({ initial = [] as RangeRow[] }) {
  const [rows, setRows] = useState<RangeRow[]>(initial)
  return <RecodeRangeRows rows={rows} onChange={setRows} numericOutput />
}

const row = (lo: string, hi: string, output: string): RangeRow => ({ lo, hi, output })

describe('#861 — the precedence rule is stated in BOTH states', () => {
  it('states it with no rows yet', () => {
    render(<Harness />)
    expect(screen.getByText(/checked after the rows above/i)).toBeInTheDocument()
  })

  it('🔴 still states it once rows exist — the state it used to vanish in', () => {
    render(<Harness initial={[row('18', '29', '1')]} />)
    expect(screen.getByText(/checked after the rows above/i)).toBeInTheDocument()
  })

  it('names EXCLUSION, not only mapping', () => {
    // The copy half of #861: `Exclude` beats a band, and the sentence has to say
    // so or it describes only half the rule it exists to describe.
    render(<Harness initial={[row('18', '29', '1')]} />)
    expect(screen.getByText(/excluded/i)).toBeInTheDocument()
  })

  it('survives adding a row through the control, not just as a prop', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /add range/i }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText(/checked after the rows above/i)).toBeInTheDocument()
  })
})

describe('🔴 #863 — the overlap notice names the rows the researcher is looking at', () => {
  /**
   * The live repro, as a test. Driven in the browser on GSS `age`: rows
   * `[blank, 18–29, 25–40]` produced *"Range 1 and range 2 overlap"* — naming an
   * EMPTY row and neither of the two that overlapped. Deleting the blank row
   * made the same sentence correct, which is what made it a shifted index rather
   * than a comparison bug.
   *
   * ⚠️ The lib tests pin `rowOverlaps`; this pins that the COMPONENT renders its
   * answer rather than re-deriving one. The old code called a pure, correct
   * function and got a wrong sentence out of it.
   */
  it('names rows 2 and 3 when a blank row sits above them', () => {
    render(<Harness initial={[row('', '', ''), row('18', '29', '1'), row('25', '40', '2')]} />)
    const notice = screen.getByText(/overlap/i)
    expect(notice).toHaveTextContent('Range 2 (18 to 29) and range 3 (25 to 40) overlap')
    expect(notice).not.toHaveTextContent('range 1')
  })

  it('quotes each row’s BOUNDS beside its number, so a wrong index would show', () => {
    // The sentence carries its own evidence: if the mapping broke again, the
    // quoted bounds would visibly not match the row named.
    render(<Harness initial={[row('0', '10', '1'), row('5', '20', '2')]} />)
    expect(screen.getByText(/overlap/i))
      .toHaveTextContent('Range 1 (0 to 10) and range 2 (5 to 20) overlap')
  })

  it('says nothing about adjacent bands, blank row or not', () => {
    render(<Harness initial={[row('', '', ''), row('18', '29', '1'), row('30', '44', '2')]} />)
    expect(screen.queryByText(/overlap/i)).not.toBeInTheDocument()
  })
})

describe('#863 — every remove button names a different row', () => {
  it('🔴 two IDENTICAL bands do not get two identical names', () => {
    render(<Harness initial={[row('18', '29', '1'), row('18', '29', '2')]} />)
    const names = screen
      .getAllByRole('button', { name: /^Remove range/ })
      .map(b => b.getAttribute('aria-label'))
    expect(names).toEqual(['Remove range 1 (18 to 29)', 'Remove range 2 (18 to 29)'])
    expect(new Set(names).size).toBe(names.length)
  })

  it('does not call a blank row “any value”', () => {
    // That is the wording for an UNBOUNDED band — the opposite of an empty row.
    render(<Harness initial={[row('', '', '')]} />)
    expect(screen.getByRole('button', { name: /^Remove range/ }))
      .toHaveAccessibleName('Remove range 1')
  })
})

describe('#861 — the table points at the rule that governs it', () => {
  /**
   * ⚠️ Asserted in the channel the property lives in. `aria-describedby` is an
   * ID-LIST, so this resolves every id and checks the TEXT — a test that only
   * asserted the attribute is non-empty would pass against a dangling idref,
   * which is the `aria-valid-attr-value` failure #853 fixed one file over.
   */
  const describedText = (el: HTMLElement) =>
    (el.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(id => document.getElementById(id)?.textContent ?? `[MISSING #${id}]`)
      .join(' ')

  it('describes the grid with the precedence rule', () => {
    render(<Harness initial={[row('18', '29', '1')]} />)
    expect(describedText(screen.getByRole('table'))).toMatch(/checked after the rows above/i)
  })

  it('keeps the precedence rule when an overlap notice joins it', () => {
    // Both, not either — the overlap notice used to be the only description, so
    // the rule would be lost on exactly the rows that need the most explaining.
    render(<Harness initial={[row('18', '29', '1'), row('25', '40', '2')]} />)
    const described = describedText(screen.getByRole('table'))
    expect(described).toMatch(/checked after the rows above/i)
    expect(described).toMatch(/overlap/i)
    expect(described).not.toMatch(/\[MISSING #/)
  })
})
