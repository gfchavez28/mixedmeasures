/**
 * Joint display session C (D174) — a joint display EXPORTS. Before session C the node had no arm
 * in `nodeToMd` / `nodeToHtml` and no children, so it rendered NOTHING in every file, silently.
 *
 * The export reads the display's numbers itself, outside React, under the export LENS (blind
 * mode as the Compact view applies it, D175), and prints the table `buildJointDisplayReport`
 * builds — the one the Report view shows — so the preview and the file cannot disagree.
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

import { docxDisplayTables, exportCanvasHtml, exportCanvasMarkdown, fetchDisplayReports } from './canvas-export'

const LENS = { blind: false, self: 7, machineCoderIds: new Set<number>() as ReadonlySet<number> }
const NAMES = (id: number) => (id === 7 ? 'Me' : id === 2 ? 'Colleague' : null)
const CANVAS = { id: 1, name: 'Report' } as never

const DISPLAY = {
  title: 'Teachers by gain',
  group_by_column_id: 11,
  rows: [{
    key: 'r1', construct: 'Planning time', code_ids: [31], column_ids: [], result_material_ids: [90],
    meta_inference: { text: 'They agree.', author_id: 2, written_at: '2026-11-05', level: 'global', type: 'causal' },
    pins: [{ excerptId: 41, displayText: 'We plan on Fridays.', sourceContext: 'FG', conversationId: 1, observationId: null, group: 'High', role: 'typical', purpose: '' }],
  }],
}

function themes(node: Record<string, unknown> = { type: 'joint-display', attrs: { displayKey: 'k-1', figureEpoch: 3, display: DISPLAY } }): CanvasTheme[] {
  return [{ id: 1, name: 'Findings', relationships_out: [], content: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
    node,
    { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
  ] } } as unknown as CanvasTheme]
}

const PAYLOAD = {
  unit: 'participants',
  group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
  groups: [{ key: 'High', participants: 11 }, { key: 'Low', participants: 11 }],
  unavailable_reason: null,
  scope: { conversations: 1, documents: 0, unassigned_passages: 0, participants_without_group: 0 },
  rating: null,
  rows: [{
    key: 'r1',
    codes: [{
      code_id: 31, name: 'Planning time', unit: 'participants', rated: false, formed_groups: null,
      cells: [
        { group: 'High', count: 7, n: 11, share: 7 / 11, share_undefined_reason: null, passages: 12, rating: null },
        { group: 'Low', count: 0, n: 11, share: 0, share_undefined_reason: null, passages: 0, rating: null },
      ],
      difference: { value: 7 / 11, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
    }],
    variables: [], missing_code_ids: [], missing_column_ids: [],
    strands: { codes: 'covers', variables: 'not_measured' },
  }],
}

const COLUMNS = {
  datasets: [{ id: 3, name: 'Scores', columns: [
    { id: 50, dataset_id: 3, dataset_name: 'Scores', column_code: null, column_name: 'Post-test', column_text: 'Post-test', column_type: 'numeric', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
    { id: 51, dataset_id: 3, dataset_name: 'Scores', column_code: null, column_name: 'School', column_text: 'School', column_type: 'nominal', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
  ] }],
  domains: [], demographics: [],
}

const MATERIAL = {
  id: 90, collection_id: 1, material_type: 'chart', auto_name: 'Comparison', custom_name: 'Post-test by school',
  display_order: 0, source_tab: 'relationships', created_at: '', has_missing_refs: false, missing_refs: [],
  config: { rc_view: 'comparisons', column_ids: [50], compare_by: 51 },
}

beforeEach(() => {
  vi.clearAllMocks()
  api.compute.mockResolvedValue(PAYLOAD)
  api.pinFacts.mockResolvedValue({ pins: [{ excerpt_id: 41, participant_id: 4, participant_identifier: 'T-04', speaker_label: 'Robert', source_name: 'FG 1', column_value: null }] })
  api.listAllMaterials.mockResolvedValue([MATERIAL])
  api.analysisColumns.mockResolvedValue(COLUMNS)
  api.groupComparison.mockResolvedValue({
    groups: ['A', 'B'],
    rows: [{ label: 'Post-test', full_label: 'Post-test', group_stats: [{ group: 'A', n: 5, mean: 70 }, { group: 'B', n: 4, mean: 60 }],
      test: null, test_omitted_reason: null, untested_groups: [] }],
  })
})

describe('a joint display in the Markdown and HTML exports (D174)', () => {
  it('prints its report table in its place: title, groups, cells, the beside result and its own table, the note', async () => {
    const md = await exportCanvasMarkdown(CANVAS, themes(), 3, LENS, NAMES)
    expect(md.indexOf('Before')).toBeLessThan(md.indexOf('**Side-by-side joint display by construct: Teachers by gain**'))
    expect(md.indexOf('Side-by-side')).toBeLessThan(md.indexOf('After'))
    expect(md).toContain('| Construct | High (11 participants) | Low (11 participants) | High − Low | Fit | Meta-inference (type) |')
    expect(md).toContain('Coded: Planning time 7 of 11. “We plan on Fridays.” (T-04 · FG 1, typical)')
    expect(md).toContain('(Global · causal) They agree. — Colleague, ')
    expect(md).toContain('| Beside “Planning time”: Post-test by school, a saved comparison (rows of Scores, by School).')
    expect(md).toContain('**Post-test by school (a saved comparison; rows of Scores, by School)**')
    // #1423: the comparison table's own columns (n, M, SD per group, then Δ).
    expect(md).toContain('| Post-test | 5 | 70.00 | — | 4 | 60.00 | — | — |')
    expect(md).toMatch(/Groups: the participants with each value of Gain group \(Roster\)/)
    expect(api.compute).toHaveBeenCalledWith(3, expect.objectContaining({ group_by_column_id: 11, coder_ids: null, rows: [expect.objectContaining({ key: 'r1', bindings: expect.objectContaining({ codes: expect.objectContaining({ code_ids: [31] }) }) })] }))
  })

  it('HTML: a real table with column and row headers, inside the export’s CSP document', async () => {
    const html = await exportCanvasHtml(CANVAS, themes(), 3, new Map(), LENS, NAMES)
    expect(html).toContain('<div class="chart joint-display"><h4>Side-by-side joint display by construct: Teachers by gain</h4>')
    expect(html).toContain('<th scope="col">High (11 participants)</th>')
    expect(html).toContain('<th scope="row">Planning time</th>')
    expect(html).toMatch(/<tr class="beside"><td colspan="6">Beside “Planning time”/)
    expect(html).toContain('Content-Security-Policy')
  })

  it('never renders as nothing: a node it could not read says so', async () => {
    const md = await exportCanvasMarkdown(CANVAS, themes({ type: 'joint-display', attrs: { display: DISPLAY } }), 3, LENS, NAMES)
    expect(md).toContain('*[Joint display not available in this export.]*')
    expect(api.compute).not.toHaveBeenCalled()
  })
})

describe('it reads under the export lens (D175, §6) and says what it could not read', () => {
  it('blind: the viewer alone, the scope stated, a colleague not named', async () => {
    const md = await exportCanvasMarkdown(CANVAS, themes(), 3, { ...LENS, blind: true }, NAMES)
    expect(api.compute.mock.calls[0][1]).toMatchObject({ coder_ids: [7], layer_scope: 'human' })
    expect(md).toContain('Scope: coders: Me (blind mode).')
    expect(md).toContain('They agree. — a colleague, ')
    expect(md).not.toContain('Colleague,')
  })

  it('blind with no viewer to scope to: no read at all, and one sentence (D96)', async () => {
    const md = await exportCanvasMarkdown(CANVAS, themes(), 3, { ...LENS, blind: true, self: null }, NAMES)
    expect(api.compute).not.toHaveBeenCalled()
    // #1615: the pins' attribution is not read either (its column may be a rating score).
    expect(api.pinFacts).not.toHaveBeenCalled()
    expect(md).toContain('*The joint display was not computed: the coder could not be identified while blind mode is on.*')
  })

  it('#1639 (r1-5): a grouping variable gone is the display\'s own sentence; another failure keeps the server\'s words', async () => {
    const refusal = (detail: unknown) =>
      Object.assign(new Error('404'), { status: 404, response: { status: 404, data: { detail } } })
    api.compute.mockRejectedValueOnce(refusal({ code: 'grouping_gone', message: 'That variable is not in this project.' }))
    const md = await exportCanvasMarkdown(CANVAS, themes(), 3, LENS, NAMES)
    expect(md).toContain('The variable that formed this display’s groups is not in this project: it was deleted, or not brought in by an import.')
    expect(md).not.toContain('could not be computed')
    api.compute.mockRejectedValueOnce(Object.assign(new Error('400'), { status: 400, response: { status: 400, data: { detail: 'That variable cannot form groups.' } } }))
    expect(await exportCanvasMarkdown(CANVAS, themes(), 3, LENS, NAMES)).toContain(
      'The joint display could not be computed. That variable cannot form groups.')
  })

  it('#1615: the pins’ attribution is read under the same scope as the numbers', async () => {
    await exportCanvasMarkdown(CANVAS, themes(), 3, { ...LENS, blind: true }, NAMES)
    expect(api.pinFacts.mock.calls[0][1]).toMatchObject({ excerpt_ids: [41], coder_ids: [7] })
    vi.clearAllMocks()
    api.compute.mockResolvedValue(PAYLOAD)
    api.pinFacts.mockResolvedValue({ pins: [] })
    api.listAllMaterials.mockResolvedValue([MATERIAL])
    api.analysisColumns.mockResolvedValue(COLUMNS)
    // Positive control: blind mode off asks for every coder, as the Compact view does.
    await exportCanvasMarkdown(CANVAS, themes(), 3, LENS, NAMES)
    expect(api.pinFacts.mock.calls[0][1]).toMatchObject({ excerpt_ids: [41], coder_ids: null })
  })

  it('#1615 D286: a withheld attribution column is named in the exported note, and only then', async () => {
    api.pinFacts.mockResolvedValue({ pins: [{ excerpt_id: 41, participant_id: 4, participant_identifier: 'T-04', speaker_label: 'Robert', source_name: 'FG 1', column_value: null }],
      column_withheld: true, column_name: 'Score band' })
    const md = await exportCanvasMarkdown(CANVAS, themes(), 3, { ...LENS, blind: true }, NAMES)
    expect(md).toContain("Score band is left out of the quotes' attribution while blind: it comes from participant scores, which combine every coder's ratings.")
    // Control: the same answer with nothing withheld says nothing of the kind.
    api.pinFacts.mockResolvedValue({ pins: [{ excerpt_id: 41, participant_id: 4, participant_identifier: 'T-04', speaker_label: 'Robert', source_name: 'FG 1', column_value: null }],
      column_withheld: false, column_name: null })
    const plain = await exportCanvasMarkdown(CANVAS, themes(), 3, { ...LENS, blind: true }, NAMES)
    expect(plain).not.toContain('left out of the quotes')
  })

  it('a failed compute is a sentence in the table’s place — the rest of the document still exports', async () => {
    api.compute.mockRejectedValueOnce(new Error('down'))
    const md = await exportCanvasMarkdown(CANVAS, themes(), 3, LENS, NAMES)
    expect(md).toMatch(/\*The joint display could not be computed\. /)
    expect(md).toContain('After')
  })

  it('a failed facts read says the attribution could not be read; failed results are not "gone"', async () => {
    api.pinFacts.mockRejectedValueOnce(new Error('down'))
    api.listAllMaterials.mockRejectedValueOnce(new Error('down'))
    const md = await exportCanvasMarkdown(CANVAS, themes(), 3, LENS, NAMES)
    expect(md).toContain('(attribution could not be read, typical)')
    expect(md).toContain('Beside “Planning time”: a saved result that could not be read just now.')
    expect(md).not.toContain('no longer in this project')
    expect(api.groupComparison).not.toHaveBeenCalled()
  })

  it('reads the materials only when a row binds a result', async () => {
    const display = { ...DISPLAY, rows: [{ ...DISPLAY.rows[0], result_material_ids: [] }] }
    await exportCanvasMarkdown(CANVAS, themes({ type: 'joint-display', attrs: { displayKey: 'k-1', display } }), 3, LENS, NAMES)
    expect(api.listAllMaterials).not.toHaveBeenCalled()
    expect(api.analysisColumns).not.toHaveBeenCalled()
  })
})

describe('the Word payload', () => {
  it('the same report as strings, keyed by displayKey, a beside row as one cell in span_rows', async () => {
    const tables = docxDisplayTables(await fetchDisplayReports(themes(), 3, LENS, NAMES))
    const t = tables.get('k-1')!
    expect(t.title).toBe('Side-by-side joint display by construct: Teachers by gain')
    expect(t.span_rows).toEqual([1])
    expect(t.rows[1]).toHaveLength(1)
    expect(t.rows[0]).toHaveLength(t.headers.length)
    expect(t.appendix[0].rows).toEqual([['Post-test', '5', '70.00', '—', '4', '60.00', '—', '—', 'Not computed', '—', '—']])
    expect(t.note).toMatch(/^Groups: /)
  })
})
