/**
 * #1545 (1.6.0) — a file written under the participant filter says so, in the words the panel
 * and the server's files use.
 *
 * Until 1.6.0 the Frequencies CSV's scope line named only the coders and the layer (#499), so a
 * file exported with and without "Group = Y" opened on the same line. `frequencyFileScope` now
 * adds the participant part (`participantFilterScopeBit`) and the panel's rule line; the
 * server's three files say the same through `routers/export_helpers.py::file_scope_line`
 * (`backend/tests/test_participant_filter_files_1545.py` asserts the SAME literal strings as
 * here, and pins `PARTICIPANT_FILTER_RULE` across the two languages).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const downloadFromApi = vi.fn((..._a: unknown[]) => Promise.resolve())
vi.mock('@/lib/api/download', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/download')>('@/lib/api/download')
  return { ...actual, downloadFromApi: (...a: unknown[]) => downloadFromApi(...a) }
})

import {
  PARTICIPANT_FILTER_RULE, participantFilterFileScope, participantFilterScopeBit,
  type FilterValues,
} from '@/lib/participant-filter'
import { codeSummaryCsv, frequencyFileScope } from '@/components/qualitative-analysis/qual-summary-columns'
import { sourceDataCsvParams } from '@/lib/qual-comparison'
import { exportApi } from '@/lib/api/export'
import { UTF8_BOM } from '@/lib/csv'
import type { DemographicFilter, SourceFrequenciesResponse } from '@/lib/api'

const OPTIONS: DemographicFilter[] = [
  { subtype: 'group', label: 'Group', values: [
    { value: 'X', participant_ids: [501], count: 1 }, { value: 'Y', participant_ids: [502], count: 1 },
  ] },
  { subtype: 'site', label: 'Site', values: [
    { value: 'North', participant_ids: [501], count: 1 }, { value: 'South', participant_ids: [502], count: 1 },
  ] },
] as DemographicFilter[]
const values = (v: Record<string, string[]>): FilterValues =>
  Object.fromEntries(Object.entries(v).map(([k, xs]) => [k, new Set(xs)]))

beforeEach(() => { downloadFromApi.mockClear() })

describe('#1545 — what a file says the filter is', () => {
  it('chosen values: the panel’s description and the count', () => {
    const scope = participantFilterFileScope({ kind: 'values', values: values({ group: ['Y'] }), ids: [502] }, OPTIONS, [502])
    expect(scope).toEqual({ label: 'Group: Y', count: 1 })
    expect(participantFilterScopeBit(scope!)).toBe('participant filter: Group: Y (1 participant)')
  })

  it('a list from a link or a saved analysis has no values (D124): the count alone', () => {
    const scope = participantFilterFileScope({ kind: 'given', ids: [501, 502] }, OPTIONS, [501, 502])
    expect(scope).toEqual({ label: null, count: 2 })
    expect(participantFilterScopeBit(scope!)).toBe('participant filter: 2 participants')
  })

  it('no filter, and “no one” (whose doors all wait, D125), describe nothing', () => {
    expect(participantFilterFileScope({ kind: 'none' }, OPTIONS, [])).toBeNull()
    expect(participantFilterFileScope({ kind: 'nobody', values: values({ group: ['X'], site: ['South'] }) }, OPTIONS, [])).toBeNull()
  })

  it('the APPLIED list decides: chosen values with no list sent claim nothing (#1542’s state)', () => {
    const state = { kind: 'values', values: values({ group: ['Y'] }), ids: [502] } as const
    expect(participantFilterFileScope(state, OPTIONS, [])).toBeNull()
  })

  it('values that did not produce the applied list are not named — the count is', () => {
    const state = { kind: 'values', values: values({ group: ['Y'] }), ids: [502] } as const
    expect(participantFilterFileScope(state, OPTIONS, [501, 502])).toEqual({ label: null, count: 2 })
  })

  it('two variables are named in the options’ order — the server’s literal', () => {
    const scope = participantFilterFileScope(
      { kind: 'values', values: values({ site: ['South'], group: ['Y'] }), ids: [502] }, OPTIONS, [502])
    expect(participantFilterScopeBit(scope!)).toBe('participant filter: Group: Y; Site: South (1 participant)')
  })
})

describe('#1545 — the Frequencies CSV’s scope line', () => {
  const filter = { label: 'Group: Y', count: 1 }

  it('a filtered file says the filter, then the panel’s rule', () => {
    expect(frequencyFileScope(null, [], filter))
      .toBe(`Scope: participant filter: Group: Y (1 participant). ${PARTICIPANT_FILTER_RULE}`)
  })

  it('beside a coder and a layer scope, the filter comes last', () => {
    expect(frequencyFileScope('consensus', ['Alice'], filter))
      .toBe(`Scope: consensus layer; coders: Alice; participant filter: Group: Y (1 participant). ${PARTICIPANT_FILTER_RULE}`)
  })

  it('POSITIVE CONTROL: without a filter the line is #499’s, unchanged — and absent when nothing narrows', () => {
    expect(frequencyFileScope(null, ['Alice'])).toBe('Scope: coders: Alice')
    expect(frequencyFileScope(null, [], null)).toBeNull()
  })

  it('the written file opens on that line', () => {
    const data = {
      codes: [{ id: 1, name: 'A', color: null, category_id: null, category_name: null, is_universal: false }],
      sources: [], totals: { total_segments: 0, total_word_count: 0, coded_segments: 0 },
    } as unknown as SourceFrequenciesResponse
    const csv = codeSummaryCsv(data, { categoryMode: false, scope: frequencyFileScope(null, [], filter) })
    const first = csv.replace(UTF8_BOM, '').split(/\r?\n/)[0]
    expect(first).toContain('participant filter: Group: Y (1 participant)')
    expect(first).toContain(PARTICIPANT_FILTER_RULE)
  })
})

describe('#1545 — the server files are handed the label beside the ids, never alone', () => {
  const sel = { conversations: new Set<number>(), textColumns: new Set<number>(), documents: new Set([201]), observations: new Set<number>() }

  it('the Source Data CSV carries `participant_filter_label` with the filter', () => {
    const params = sourceDataCsvParams([], sel, { excludeFacilitator: true, participantIds: [502], participantFilterLabel: 'Group: Y' })
    expect(params.participant_ids).toBe('502')
    expect(params.participant_filter_label).toBe('Group: Y')
  })

  it('…and no label without a filter, or with no values behind it', () => {
    expect(sourceDataCsvParams([], sel, { excludeFacilitator: true, participantIds: [], participantFilterLabel: 'Group: Y' }).participant_filter_label).toBeUndefined()
    expect(sourceDataCsvParams([], sel, { excludeFacilitator: true, participantIds: [502], participantFilterLabel: null }).participant_filter_label).toBeUndefined()
  })

  it('the Co-occurrence CSV’s URL carries the label beside `participant_ids` only', async () => {
    await exportApi.codeCooccurrence(1, { participant_ids: '502', source: 'all' }, 'Group: Y')
    await exportApi.codeCooccurrence(1, { source: 'all' }, 'Group: Y')
    const urls = downloadFromApi.mock.calls.map(c => new URL(String(c[0]), 'http://x'))
    expect(urls[0].searchParams.get('participant_filter_label')).toBe('Group: Y')
    expect(urls[0].searchParams.get('participant_ids')).toBe('502')
    expect(urls[1].searchParams.get('participant_filter_label')).toBeNull()
  })
})
