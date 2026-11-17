/**
 * #1653 (D346) — the *Also show* variable (`display.attribution.column_id`) gone or retyped: every
 * quote keeps who said it and where, and the report says why the value is missing.
 *
 * `pin-facts` 404'd for a deleted variable (400 for one retyped so it cannot form groups), so the
 * whole facts read failed and every quote printed "attribution could not be read" — in the Report
 * view and every export — though only the VALUE was unreadable. The server now answers the facts
 * with `column_unusable`; the report's note carries the sentence (`attributionUnusableNote`), the
 * way it carries D286's withheld one. Mocks as `canvas-export-joint-display.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasTheme } from '@/lib/api'

vi.mock('html-to-image', () => ({ toPng: vi.fn() }))

const api = vi.hoisted(() => ({
  compute: vi.fn(), pinFacts: vi.fn(), passages: vi.fn(),
  listAllMaterials: vi.fn(), analysisColumns: vi.fn(), groupComparison: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  jointDisplayApi: { compute: api.compute, pinFacts: api.pinFacts, passages: api.passages },
  materialsApi: { listAllMaterials: api.listAllMaterials },
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn(), analysisColumns: api.analysisColumns },
  comparisonsApi: { groupComparison: api.groupComparison },
  codeAnalysisApi: {}, codesApi: { list: vi.fn() }, observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

import { exportCanvasMarkdown } from './canvas-export'
import {
  ATTRIBUTION_GONE_TEXT, SERVER_VOCABULARY, attributionIneligibleText, attributionUnusableNote,
} from './joint-display-vocabulary'

const LENS = { blind: false, self: 7, machineCoderIds: new Set<number>() as ReadonlySet<number> }
const NAMES = (id: number) => (id === 7 ? 'Me' : null)
const CANVAS = { id: 1, name: 'Report' } as never

const DISPLAY = {
  title: 'Teachers by gain', group_by_column_id: 11,
  attribution: { label: 'participant', column_id: 51 },
  rows: [{ key: 'r1', construct: 'Planning time', code_ids: [31], column_ids: [],
    pins: [{ excerptId: 41, displayText: 'We plan on Fridays.', sourceContext: 'FG', conversationId: 1,
      observationId: null, group: 'High', role: 'typical', purpose: '' }] }],
}
const themes = (): CanvasTheme[] => [{ id: 1, name: 'Findings', relationships_out: [], content: { type: 'doc', content: [
  { type: 'joint-display', attrs: { displayKey: 'k-1', figureEpoch: 3, display: DISPLAY } },
] } } as unknown as CanvasTheme]

const PAYLOAD = {
  unit: 'participants',
  group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
  groups: [{ key: 'High', participants: 11 }, { key: 'Low', participants: 11 }],
  unavailable_reason: null,
  scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0 },
  rating: null,
  rows: [{ key: 'r1', codes: [{ code_id: 31, name: 'Planning time', unit: 'participants', rated: false, formed_groups: null,
    cells: [{ group: 'High', count: 7, n: 11, share: 7 / 11, share_undefined_reason: null, passages: 12, rating: null },
      { group: 'Low', count: 0, n: 11, share: 0, share_undefined_reason: null, passages: 0, rating: null }],
    difference: { value: 7 / 11, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null } }],
  variables: [], missing_code_ids: [], missing_column_ids: [], strands: { codes: 'covers', variables: 'not_measured' } }],
}
const FACT = { excerpt_id: 41, participant_id: 4, participant_identifier: 'T-04', speaker_label: 'Robert',
  source_name: 'FG 1', column_value: null }

beforeEach(() => {
  vi.clearAllMocks()
  api.compute.mockResolvedValue(PAYLOAD)
  api.listAllMaterials.mockResolvedValue([])
  api.analysisColumns.mockResolvedValue({ datasets: [], domains: [], demographics: [] })
})

describe('#1653 (D346) — the words', () => {
  it('gone and ineligible each have a sentence; read, absent and withheld say nothing here', () => {
    expect(SERVER_VOCABULARY.PIN_ATTRIBUTION_GONE).toBe('gone')
    expect(attributionUnusableNote({ column_unusable: 'gone', column_name: null })).toBe(ATTRIBUTION_GONE_TEXT)
    expect(attributionUnusableNote({ column_unusable: 'ineligible', column_name: 'School' }))
      .toBe(attributionIneligibleText('School'))
    expect(attributionIneligibleText('School')).toBe(
      '“School” is no longer shown beside each quote: it is not an ordinal, nominal, binary or demographic variable now. Each quote still says who said it and where.')
    for (const answer of [{ column_unusable: null }, {}, null, undefined, { column_withheld: true, column_name: 'Score band' }]) {
      expect(attributionUnusableNote(answer as never)).toBeNull()
    }
  })
})

describe('#1653 (D346) — an export keeps who said it and says why the value is missing', () => {
  it('gone: the quote keeps "T-04 · FG 1" and the note says the variable is not in the project', async () => {
    api.pinFacts.mockResolvedValue({ pins: [FACT], column_withheld: false, column_name: null, column_unusable: 'gone' })
    const md = await exportCanvasMarkdown(CANVAS, themes(), 3, LENS, NAMES)
    expect(md).toContain('“We plan on Fridays.” (T-04 · FG 1, typical)')
    expect(md).not.toContain('attribution could not be read')
    expect(md).toContain(ATTRIBUTION_GONE_TEXT)
  })

  it('ineligible: the note names the variable', async () => {
    api.pinFacts.mockResolvedValue({ pins: [FACT], column_withheld: false, column_name: 'School', column_unusable: 'ineligible' })
    const md = await exportCanvasMarkdown(CANVAS, themes(), 3, LENS, NAMES)
    expect(md).toContain('“School” is no longer shown beside each quote')
  })

  it('control: a variable that was read says neither sentence', async () => {
    api.pinFacts.mockResolvedValue({ pins: [{ ...FACT, column_value: 'North' }], column_withheld: false, column_name: null })
    const md = await exportCanvasMarkdown(CANVAS, themes(), 3, LENS, NAMES)
    expect(md).toContain('(T-04 · North · FG 1, typical)')
    expect(md).not.toContain(ATTRIBUTION_GONE_TEXT)
    expect(md).not.toContain('no longer shown beside each quote')
  })
})
