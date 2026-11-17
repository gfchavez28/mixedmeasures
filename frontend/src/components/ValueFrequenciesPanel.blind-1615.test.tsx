/**
 * #1615 (r4) — an *Observed values* answer withheld while blind says so where the values
 * would be; an empty answer for that reason must never read as "no values" (the panel
 * renders NOTHING for an empty distribution). jsdom: the words and the absence of the table.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ValueFrequenciesPanel } from './ValueFrequenciesPanel'
import { WITHHELD_VALUES_NOTICE } from '@/lib/blind-rating-columns'

describe('ValueFrequenciesPanel while blind (#1615)', () => {
  it('a withheld answer states why and shows no table', () => {
    render(<ValueFrequenciesPanel data={{ frequencies: [], total: 0, withheld_while_blind: true }} />)
    expect(screen.getByText(WITHHELD_VALUES_NOTICE)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Observed values' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })
  it('control: an ordinary empty answer still renders nothing', () => {
    const { container } = render(<ValueFrequenciesPanel data={{ frequencies: [], total: 0 }} />)
    expect(container.textContent).toBe('')
  })
  it('control: an ordinary answer shows its values, and no notice', () => {
    render(<ValueFrequenciesPanel data={{
      frequencies: [{ value_text: '3', count: 2, is_na: false }], total: 2 }} />)
    expect(screen.queryByText(WITHHELD_VALUES_NOTICE)).toBeNull()
    expect(screen.getByRole('button', { name: /Observed values/ })).toBeTruthy()
  })
})
