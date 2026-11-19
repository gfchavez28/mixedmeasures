/**
 * Joint display slice 2, round 2 (r5-8, r3-11) — the export prints each row's "cases that don't
 * fit" from ONE count-only case read per row with a misfit, under the export lens (D175, D96),
 * through `buildJointDisplayReport`'s note — so Markdown, HTML/PDF and Word print the same line.
 * A display with no misfit makes no case read at all (the control).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasTheme } from '@/lib/api'

vi.mock('html-to-image', () => ({ toPng: vi.fn() }))
const api = vi.hoisted(() => ({ compute: vi.fn(), pinFacts: vi.fn(), cases: vi.fn() }))
vi.mock('@/lib/api', () => ({
  jointDisplayApi: { compute: api.compute, pinFacts: api.pinFacts, passages: vi.fn(), cases: api.cases },
  materialsApi: { listAllMaterials: vi.fn() },
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn(), analysisColumns: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
  codeAnalysisApi: {}, codesApi: { list: vi.fn() }, observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

import { docxDisplayTables, fetchDisplayReports } from './canvas-export'
import { MISFIT_COUNT_UNREAD_TEXT } from './joint-display-vocabulary'

const LENS = { blind: false, self: 7, machineCoderIds: new Set<number>() as ReadonlySet<number> }
const NAMES = () => null
const MISFIT = { rule: { conditions: [{ kind: 'group', group: 'High' }] }, added: [{ participant_id: 11, reason: 'Moved schools' }], removed: [] }
const display = (misfit: unknown) => ({
  title: 'Teachers by gain', group_by_column_id: 11,
  rows: [{ key: 'r1', construct: 'Planning time', code_ids: [31], column_ids: [], misfit }],
})
const themes = (misfit: unknown): CanvasTheme[] => [{ id: 1, name: 'F', relationships_out: [], content: { type: 'doc', content: [
  { type: 'joint-display', attrs: { displayKey: 'k-1', figureEpoch: 3, display: display(misfit) } },
] } } as unknown as CanvasTheme]
const PAYLOAD = {
  unit: 'participants', group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
  groups: [{ key: 'High', participants: 11 }, { key: 'Low', participants: 11 }], unavailable_reason: null,
  scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0 }, rating: null,
  rows: [{ key: 'r1', codes: [], variables: [], missing_code_ids: [], missing_column_ids: [], strands: {} }],
}
const CASES = {
  groups: ['High', 'Low'], total: 22, listed: 22, matched: 3, unknown: 0, rule_unavailable_reason: null,
  rule_withheld_columns: [], list_size: 4, added_outside: 0, codes: [], variables: [], cases: [],
  named_cases: [{ participant_id: 11, label: 'T11', group: 'Low' }], unavailable_reason: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  api.compute.mockResolvedValue(PAYLOAD)
  api.cases.mockResolvedValue(CASES)
})

describe('the misfit note in every export (r3-11)', () => {
  it('one count-only read per row with a misfit, under the lens; the note prints the rule, count and added case', async () => {
    const reports = await fetchDisplayReports(themes(MISFIT), 1, { ...LENS, blind: true }, NAMES)
    expect(api.cases).toHaveBeenCalledTimes(1)
    expect(api.cases.mock.calls[0][1]).toMatchObject({ limit: 0, coder_ids: [7], row_key: 'r1', added_participant_ids: [11] })
    // The notice rule (2026-11-18, rewrite D): the cases that don't fit are in the Definitions.
    const report = reports.get('k-1')!
    const defs = report.definitions.join(' ')
    expect(report.definitionsTitle).toBe('Definitions and cases that don’t fit')
    expect(defs).toContain('Cases that don’t fit — Planning time. Rule: in the group “High”. 3 of 22 cases meet the rule.')
    expect(defs).toContain('Added by the researcher: T11: Moved schools.')
    expect(report.note).not.toContain('Cases that don’t fit')
    // Word reads the same report (`reportToDocx`)
    const docx = docxDisplayTables(reports).get('k-1')!
    expect(docx.note).toBe(report.note)
    expect(docx.definitions).toEqual(report.definitions)
    expect(docx.definitions_title).toBe(report.definitionsTitle)
  })

  it('blind with no viewer (D96): no read, and the note says the count could not be read', async () => {
    const reports = await fetchDisplayReports(themes(MISFIT), 1, { ...LENS, blind: true, self: null as never }, NAMES)
    expect(api.cases).not.toHaveBeenCalled()
    expect(api.compute).not.toHaveBeenCalled()
    // no numbers at all — the display says why in the table's place, as before
    expect(reports.get('k-1')!.message).toMatch(/could not be identified/)
  })

  it('a failed read is said, never a count', async () => {
    api.cases.mockRejectedValue(new Error('boom'))
    const defs = (await fetchDisplayReports(themes(MISFIT), 1, LENS, NAMES)).get('k-1')!.definitions.join(' ')
    expect(defs).toContain(MISFIT_COUNT_UNREAD_TEXT)
    expect(defs).not.toMatch(/meet the rule/)
  })

  it('control: a display with no misfit makes no case read and prints no misfit line', async () => {
    const note = (await fetchDisplayReports(themes(null), 1, LENS, NAMES)).get('k-1')!.note
    expect(api.cases).not.toHaveBeenCalled()
    expect(note).not.toContain('Cases that don’t fit')
  })
})
