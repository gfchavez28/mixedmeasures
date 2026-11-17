/**
 * #1545 (1.6.0) — the comparison view's own *Export CSV* hands the route the panel's description
 * of the chosen filter values (`participant_filter_label`) beside the ids, so the file's scope line
 * names them; with no filter it sends neither. The page's *Exports* doors:
 * `pages/QualitativeAnalysisView.filter-files-1545.test.tsx`. Harness: the #1323 door test's.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import type { DemographicComparisonResponse, DemographicFilter } from '@/lib/api'

const csv = vi.fn()
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  exportApi: { demographicComparisonCsv: (...a: unknown[]) => csv(...a) },
}))
vi.mock('@/components/charts/ChartExportWrapper', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/qualitative-analysis/QualComparisonTable', () => ({ default: () => null }))
vi.mock('@/components/qualitative-analysis/QualComparisonBar', () => ({ default: () => null }))

import { RelationshipsContent, type RelationshipsContentProps } from './RelationshipsPanel'

afterEach(() => { cleanup(); csv.mockReset() })

const FILTER = { subtype: 'group', label: 'Group', values: [] } as unknown as DemographicFilter
const DATA = { groups: ['X', 'Y'], group_totals: {}, codes: [] } as unknown as DemographicComparisonResponse

function exportWith(participantIds: number[], participantFilterLabel: string | undefined) {
  const qa = {
    relView: 'comparisons', groupBy: 'group', comparisonChartMode: 'table',
    selectedCodeIds: new Set(), selectedConversationIds: new Set(), selectedTextColumnIds: new Set(),
    selectedDocumentIds: new Set(), selectedObservationIds: new Set(),
    excludeFacilitator: true, participantIds, formatting: {},
  } as unknown as RelationshipsContentProps['qa']
  render(
    <MemoryRouter>
      <RelationshipsContent
        pid={1} qa={qa} codes={[]} filterParams={{}} cooccurrenceParams={{}} demoFilters={[FILTER]}
        participantFilterLabel={participantFilterLabel}
        ratingsFollowCoderIds={false} cooccurrenceN={null} comparisonData={DATA} comparisonLoading={false}
        comparisonN={null} onCooccurrenceDataLoad={vi.fn()}
      />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }))
  expect(csv).toHaveBeenCalledTimes(1)
  return csv.mock.calls[0][1] as Record<string, string>
}

describe('#1545 — the comparison view’s CSV names the filter', () => {
  it('sends the label beside the ids', () => {
    const params = exportWith([502], 'Group: Y')
    expect(params.participant_ids).toBe('502')
    expect(params.participant_filter_label).toBe('Group: Y')
  })

  it('a list with no values behind it (D124) sends the ids alone', () => {
    const params = exportWith([502], undefined)
    expect(params.participant_ids).toBe('502')
    expect('participant_filter_label' in params).toBe(false)
  })

  it('POSITIVE CONTROL: no filter, no label — even if one were handed down', () => {
    const params = exportWith([], 'Group: Y')
    expect('participant_ids' in params).toBe(false)
    expect('participant_filter_label' in params).toBe(false)
  })
})
