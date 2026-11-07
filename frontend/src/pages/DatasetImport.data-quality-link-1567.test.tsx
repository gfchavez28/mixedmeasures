/**
 * #1567 — Dataset Import's "Review them on the Data Quality tab" link lands on that tab.
 *
 * The link pointed at `/projects/:id/analysis?tab=data_quality`. `/analysis` is the
 * Analysis Hub, which reads no `tab`; the tab is read by `useAnalysisUrlState` on
 * `/analysis/quantitative`. The audit drove it live and landed on the Hub.
 *
 * The router below is the TWO routes that matter, laid out as `App.tsx` lays them out
 * (`analysis` and `analysis/quantitative` as siblings under the project), so the test
 * follows the link the way a click does rather than comparing one string with another.
 * ⚠️ It is a copy of two lines of the route table, not the table: a route change in
 * `App.tsx` needs this updated by hand.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router'

import { RecognizedMissingNote } from './DatasetImport'

afterEach(cleanup)

function Hub() {
  return <p>Analysis Hub</p>
}

function Quantitative() {
  const [params] = useSearchParams()
  // `useAnalysisUrlState.ts`'s reading: no `tab` means Descriptives.
  return <p>Quantitative tab: {params.get('tab') || 'descriptives'}</p>
}

function renderNote(count: number) {
  return render(
    <MemoryRouter initialEntries={['/projects/7/datasets/import']}>
      <Routes>
        <Route path="/projects/:projectId">
          <Route path="datasets/import" element={<RecognizedMissingNote count={count} labels={['N/A', 'Refused']} projectId={7} />} />
          <Route path="analysis" element={<Hub />} />
          <Route path="analysis/quantitative" element={<Quantitative />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('#1567 — the Data Quality link', () => {
  it('opens the Quantitative page on its Data Quality tab, not the Analysis Hub', () => {
    renderNote(2)
    fireEvent.click(screen.getByRole('link', { name: 'Data Quality' }))
    expect(screen.queryByText('Analysis Hub')).not.toBeInTheDocument()
    expect(screen.getByText('Quantitative tab: data_quality')).toBeInTheDocument()
  })

  it('positive control: the sentence and its link render when values were recognized as missing', () => {
    renderNote(2)
    expect(screen.getByText(/2 values were recognized as\s+missing \(N\/A, Refused\)/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Data Quality' })).toBeInTheDocument()
  })

  it('positive control: nothing renders when no value was recognized as missing', () => {
    renderNote(0)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
