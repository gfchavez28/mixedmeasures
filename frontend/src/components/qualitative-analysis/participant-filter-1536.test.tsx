/**
 * #1536 (D119/D120, 1.5.9) — the page says what the participant filter counts, and the two
 * charts it does not reach say so.
 *
 * The rule itself is the server's (`backend/app/services/participant_filter.py`, held by
 * `backend/tests/test_participant_filter_1536.py`); these hold the words and where they show.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import {
  FILTER_NOT_APPLIED, PARTICIPANT_FILTER_RULE, filterNotAppliedNote, type ParticipantFilterState,
} from '@/lib/participant-filter'

// #1537 (D122): the panel no longer asks for its options — the page passes them — so this file
// needs no API mock; it was the panel's only request.
vi.mock('@/components/qualitative-analysis/SaturationCurve', () => ({ default: () => <div>saturation curve</div> }))
vi.mock('@/components/qualitative-analysis/TimedAnalytics', () => ({ default: () => <div>timeline</div> }))
vi.mock('@/components/qualitative-analysis/QualChartTypeToolbar', () => ({ default: () => null }))
vi.mock('@/components/qualitative-analysis/QualChartOptionsPanel', () => ({ default: () => null }))
vi.mock('@/components/charts/ChartExportWrapper', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import QualFilterBar from './QualFilterBar'
import { DescriptivesContent, type DescriptivesContentProps } from './DescriptivesPanel'

afterEach(cleanup)

describe('filterNotAppliedNote', () => {
  it('speaks for the two charts the filter does not reach, and only while a filter is on', () => {
    expect(filterNotAppliedNote('saturation', true)).toBe(FILTER_NOT_APPLIED.saturation)
    expect(filterNotAppliedNote('timeline', true)).toBe(FILTER_NOT_APPLIED.timeline)
    expect(filterNotAppliedNote('saturation', false)).toBeNull()
    expect(filterNotAppliedNote('timeline', false)).toBeNull()
    for (const other of ['bar', 'heatmap', 'summary', 'stacked_bar', 'constructor', 'toString']) {
      expect(filterNotAppliedNote(other, true)).toBeNull()
    }
  })

  it('says what is left out, in the words the decision gave', () => {
    expect(PARTICIPANT_FILTER_RULE).toMatch(/turns by speaker/)
    expect(PARTICIPANT_FILTER_RULE).toMatch(/documents by the person each is linked to/)
    expect(PARTICIPANT_FILTER_RULE).toMatch(/survey answers by record/)
    expect(PARTICIPANT_FILTER_RULE).toMatch(/Observations have no participant link/)
  })
})

describe('QualFilterBar (D119)', () => {
  // #1537 (D122): the panel is controlled — the page passes the options and the decided state.
  const options = [{
    subtype: 'group', label: 'Group',
    values: [{ value: 'X', participant_ids: [501], count: 1 }, { value: 'Y', participant_ids: [502], count: 1 }],
  }]
  const bar = (state: ParticipantFilterState) => (
    <QualFilterBar options={options} state={state} onChooseValues={() => {}} onClear={() => {}} />
  )

  it('states the rule under the filters while a filter is applied — chosen values or a given list', () => {
    render(bar({ kind: 'values', values: { group: new Set(['Y']) }, ids: [502] }))
    expect(screen.getByText(PARTICIPANT_FILTER_RULE)).toBeInTheDocument()
    cleanup()
    render(bar({ kind: 'given', ids: [502] }))
    expect(screen.getByText(PARTICIPANT_FILTER_RULE)).toBeInTheDocument()
  })

  it('says nothing while no filter is applied, and nothing while the values match no one', () => {
    render(bar({ kind: 'none' }))
    // The bar has rendered (its dropdown is there) before the absence is asserted.
    expect(screen.getByRole('button', { name: /Group/ })).toBeInTheDocument()
    expect(screen.queryByText(PARTICIPANT_FILTER_RULE)).not.toBeInTheDocument()
    cleanup()
    render(bar({ kind: 'nobody', values: { group: new Set(['X']) } }))
    expect(screen.getByRole('button', { name: /Group/ })).toBeInTheDocument()
    expect(screen.queryByText(PARTICIPANT_FILTER_RULE)).not.toBeInTheDocument()
  })
})

function descriptives(chartType: string, participantIds: number[]) {
  const qa = {
    chartType, participantIds,
    valueMode: 'count', denominatorMode: 'coded', source: 'all', excludeFacilitator: true,
    selectedCodeIds: new Set<number>(), codeMode: 'codes', layerScope: 'human',
    // #1544: the saturation curve asks whether questions are selected (its answers note).
    selectedTextColumnIds: new Set<number>(),
    formatting: { labelFontSize: 12, dataLabelFontSize: 11, heatmapPreset: 'default', dataLabels: false },
    descTitle: '', descSubtitle: '', descFootnote: '', showChartN: false,
    timelineTableMode: false, setTimelineTableMode: () => {},
  } as unknown as DescriptivesContentProps['qa']
  const props: DescriptivesContentProps = {
    qa, codes: [{ id: 601, is_active: true }],
    hasQualSelection: true, hasCodeSelection: true, hasSourceSelection: true,
    conversationSourceCount: 2, descriptivesN: null,
    sourceFreqData: undefined, sourceFreqLoading: false,
    saturationData: { points: [], total_unique_codes: 0, total_sources: 0, category_level: false, ordering: 'import_date' } as unknown as DescriptivesContentProps['saturationData'],
    saturationLoading: false,
    onChartTypeChange: () => {},
    projectId: 1, timedObservations: [], observationsLoad: { status: 'ready', retry: () => {}, retrying: false } as unknown as DescriptivesContentProps['observationsLoad'],
    timedCodes: [], timedCategories: [],
    timedLens: { include: null, machineCoderIds: new Set(), layer: 'human' } as unknown as DescriptivesContentProps['timedLens'],
    multiCoder: false, coderMap: new Map(),
  }
  return render(<DescriptivesContent {...props} />)
}

describe('DescriptivesContent (D120)', () => {
  it.each(['saturation', 'timeline'] as const)('the %s chart says the filter does not apply to it', (chart) => {
    descriptives(chart, [502])
    expect(screen.getByText(FILTER_NOT_APPLIED[chart])).toBeInTheDocument()
  })

  it.each(['saturation', 'timeline'] as const)('the %s chart says nothing without a filter', (chart) => {
    descriptives(chart, [])
    // Positive control: the chart itself rendered, so the absence below is not a blank render.
    expect(screen.getByText(chart === 'saturation' ? 'saturation curve' : 'timeline')).toBeInTheDocument()
    expect(screen.queryByTestId('filter-not-applied')).not.toBeInTheDocument()
  })

  it('a chart the filter reaches carries no such line', () => {
    descriptives('bar', [502])
    expect(screen.queryByTestId('filter-not-applied')).not.toBeInTheDocument()
  })
})
