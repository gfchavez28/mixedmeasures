/**
 * The comparison's CSV door sends what the screen counted (#1297, and a facilitator
 * defect found by the 1.5.9 pre-implementation review, r1).
 *
 * On `9dd1cd1b`: (a) an unselected source kind was OMITTED, which the server reads
 * as "every source of that kind", so a text-only selection exported every
 * conversation's counts; (b) `exclude_facilitator` was sent only when TRUE, and the
 * endpoint defaults to true — so a researcher who INCLUDED facilitator turns on
 * screen exported numbers without them.
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

const FILTER = { subtype: 'role', label: 'Role', values: [] } as unknown as DemographicFilter
const DATA = { groups: ['A', 'B'], group_totals: {}, codes: [] } as unknown as DemographicComparisonResponse

function exportWith(qaOver: Record<string, unknown>) {
  const qa = {
    relView: 'comparisons', groupBy: 'role', comparisonChartMode: 'table',
    selectedCodeIds: new Set(), selectedConversationIds: new Set(), selectedTextColumnIds: new Set(),
    selectedDocumentIds: new Set(), selectedObservationIds: new Set(),
    excludeFacilitator: true, participantIds: [], formatting: {},
    ...qaOver,
  } as unknown as RelationshipsContentProps['qa']
  render(
    <MemoryRouter>
      <RelationshipsContent
        pid={1} qa={qa} codes={[]} filterParams={{}} cooccurrenceParams={{}} demoFilters={[FILTER]} participantFilterLabel={undefined}
        cooccurrenceN={null} comparisonData={DATA} comparisonLoading={false}
        comparisonN={null} onCooccurrenceDataLoad={vi.fn()}
      />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }))
  expect(csv).toHaveBeenCalledTimes(1)
  return csv.mock.calls[0][1] as Record<string, string>
}

describe('the comparison CSV sends what the screen counted', () => {
  it('a text-only selection sends EMPTY lists for the other kinds (#1297)', () => {
    const params = exportWith({ selectedTextColumnIds: new Set([7]) })
    expect(params.text_column_ids).toBe('7')
    expect(params.conversation_ids).toBe('')      // HEAD: absent — every conversation
    expect(params.document_ids).toBe('')
  })

  it('INCLUDED facilitator turns are exported as included', () => {
    expect(exportWith({ excludeFacilitator: false }).exclude_facilitator).toBe('false')  // HEAD: absent
  })

  it('control: nothing selected sends no source list (every source)', () => {
    const params = exportWith({})
    expect('conversation_ids' in params).toBe(false)
    expect(params.exclude_facilitator).toBe('true')
  })
})
