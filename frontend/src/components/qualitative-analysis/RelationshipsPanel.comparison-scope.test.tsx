/**
 * The demographic comparison says what it counts (2026-10-19).
 *
 * The backend counts conversation segments only, through each speaker's
 * participant link: open-text sources are accepted and ignored (#1297), and
 * participant-linked documents are not counted (#1298). Until either is built,
 * the comparison view must say so — the sentence is pinned here as written, not
 * read back from the component's constant, so a rewording is a decision.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { DemographicFilter } from '@/lib/api'
import { RelationshipsContent, type RelationshipsContentProps } from './RelationshipsPanel'

afterEach(cleanup)

const SENTENCE =
  "Counts codings in conversations only, through each speaker's participant link. " +
  'Documents, open-text answers and observations are not included.'

const FILTER = { subtype: 'gender', label: 'Gender', values: [] } as unknown as DemographicFilter

function renderContent(demoFilters: DemographicFilter[], groupBy: string | null) {
  const qa = { relView: 'comparisons', groupBy } as unknown as RelationshipsContentProps['qa']
  render(
    <MemoryRouter>
      <RelationshipsContent
        pid={1} qa={qa} codes={[]} filterParams={{}} demoFilters={demoFilters}
        cooccurrenceN={null} comparisonData={undefined} comparisonLoading={false}
        comparisonN={null} onCooccurrenceDataLoad={vi.fn()}
      />
    </MemoryRouter>,
  )
}

describe('the demographic comparison states what it counts', () => {
  it('says it before a grouping variable is chosen', () => {
    renderContent([FILTER], null)
    expect(screen.getByText(SENTENCE)).toBeInTheDocument()
  })

  it('keeps saying it once a grouping variable is chosen', () => {
    renderContent([FILTER], 'gender')
    expect(screen.getByText(SENTENCE)).toBeInTheDocument()
  })

  it('is not shown where there is no demographic data to compare', () => {
    renderContent([], null)
    expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument()
    expect(screen.getByText('Link participants to demographic data to enable group comparisons.')).toBeInTheDocument()
  })
})
