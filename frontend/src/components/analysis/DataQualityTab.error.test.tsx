/**
 * #1268 — a failed missing-data summary says what the researcher can do. The endpoint's
 * refusals are sentences (a 400 naming what is wrong with the selection), so the tab shows
 * the server's sentence when one came; otherwise it names the step that re-asks. It said
 * "…or check the server logs.", and a desktop user has no log to open.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ApiError } from '@/lib/api'
import { DataQualityContent, type DataQualityContentProps } from './DataQualityTab'

// #1615 — the quantitative reads take the blind scope from this hook; every coder here.
vi.mock('@/hooks/useAnalysisScope', () => ({ useAnalysisScope: () => ({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }) }))

function renderWithError(error: Error) {
  const props: DataQualityContentProps = {
    pid: 1,
    hasDqSelection: true,
    dqView: 'summary',
    dqIncludeNA: true,
    dqIncludeEmpty: true,
    dqSort: 'pct_missing',
    dqColumnIds: [1],
    dqIsMultiDataset: false,
    dqSummaryData: undefined,
    dqSummaryError: error,
    isDqSummaryFetching: false,
    dqPatternsData: undefined,
    isDqPatternsFetching: false,
    selectedDomainIds: new Set(),
    selectedColumnIds: new Set([1]),
    setUrlParam: () => {},
  }
  return render(<DataQualityContent {...props} />)
}

describe('#1268 — the Data Quality failure sentence', () => {
  afterEach(cleanup)

  it("shows the server's own sentence when it sent one", () => {
    renderWithError(new ApiError(400, { detail: 'Provide at least one column_id.' }, {}))
    expect(screen.getByText('Failed to load missing data summary')).toBeInTheDocument()
    expect(screen.getByText('Provide at least one column_id.')).toBeInTheDocument()
  })

  it('names the step that re-asks when there is no sentence, and never a log', () => {
    const { container } = renderWithError(new Error('Network Error'))
    expect(screen.getByText('Change the variable selection to try again.')).toBeInTheDocument()
    expect(container.textContent ?? '').not.toMatch(/log/i)
  })
})
