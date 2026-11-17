/**
 * #1615 D287 — while blind, the server leaves out WHOLE every demographic subtype holding a
 * variable worked out from participant scores and counts them (`withheld_rating_filters`); the
 * *Filters* panel says how many, and still says it when every subtype was left out.
 */
import { afterEach, describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import QualFilterBar from './QualFilterBar'
import { withheldRatingFiltersNotice, type ParticipantFilterState } from '@/lib/participant-filter'

afterEach(cleanup)

const OPTIONS = [
  { subtype: 'site', label: 'Site', values: [{ value: 'North', participant_ids: [501], count: 1 }] },
]
const NONE: ParticipantFilterState = { kind: 'none' }

function mount(options: typeof OPTIONS, withheldCount?: number) {
  return render(
    <QualFilterBar options={options} state={NONE} onChooseValues={() => {}} onClear={() => {}}
      withheldCount={withheldCount} />,
  )
}

describe('#1615 D287 — the Filters panel says what it left out while blind', () => {
  it('says the decided words, singular and plural, and nothing for none', () => {
    expect(withheldRatingFiltersNotice(1)).toBe('1 variable worked out from participant scores is hidden while blind.')
    expect(withheldRatingFiltersNotice(3)).toBe('3 variables worked out from participant scores are hidden while blind.')
    expect(withheldRatingFiltersNotice(0)).toBeNull()
  })

  it('shows the line beside the remaining filters', () => {
    mount(OPTIONS, 2)
    expect(screen.getByTestId('participant-filter-withheld')).toHaveTextContent(
      '2 variables worked out from participant scores are hidden while blind.')
    expect(screen.getByRole('button', { name: 'Site' })).toBeInTheDocument()
  })

  it('still says it when every subtype was left out (the panel used to render nothing)', () => {
    mount([], 1)
    expect(screen.getByTestId('participant-filter-withheld')).toHaveTextContent(
      '1 variable worked out from participant scores is hidden while blind.')
  })

  it('not blind: no line, and an empty panel still renders nothing', () => {
    const { container } = mount([])
    expect(container).toBeEmptyDOMElement()
    cleanup()
    mount(OPTIONS, 0)
    expect(screen.queryByTestId('participant-filter-withheld')).toBeNull()
  })

  it('the page passes the server’s count, and shows *Filters* when only the count is left', () => {
    const page = readFileSync(resolve(__dirname, '../../pages/QualitativeAnalysisView.tsx'), 'utf8')
    expect(page).toMatch(/withheldRatingFilters = demoFiltersData\?\.withheld_rating_filters \?\? 0/)
    expect(page).toMatch(/hasDemographicFilters = demoFilters\.length > 0 \|\| withheldRatingFilters > 0/)
    expect(page).toMatch(/withheldCount=\{withheldRatingFilters\}/)
  })
})
