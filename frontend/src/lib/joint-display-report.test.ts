/**
 * The joint display's report table (D174, D176) — the ONE function the Report view and the
 * Markdown, HTML and Word exports render. Pure, so every claim is checked on the table itself.
 */
import { describe, it, expect } from 'vitest'
import type { JointDisplayComputeResponse, JointDisplayPinFact } from '@/lib/api'
import { readDisplay } from '@/lib/joint-display'
import { noCodingNote } from '@/lib/coding-completeness'
import {
  buildJointDisplayReport, reportToDocx, reportToHtml, reportToMarkdown,
  type ReportContext, type ReportInputs, type ReportResult,
} from '@/lib/joint-display-report'
import {
  FIT_FARMER, FIT_FETTERS, FORMED_GROUPS_HELP, META_INFERENCE_TYPES, PIN_ROLES, RATING_BASIS_TEXT,
  NOTE_RATING_TEXT, CODED_DIFFERENCE_NO_INTERVAL_TEXT,
} from '@/lib/joint-display-vocabulary'

const DATA: JointDisplayComputeResponse = {
  unit: 'participants',
  group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
  groups: [{ key: 'High', participants: 11, with_material: 9, without_coding: 0 },
           { key: 'Low', participants: 1, with_material: 1, without_coding: 0 }],
  unavailable_reason: null,
  scope: { conversations: 4, documents: 0, unassigned_passages: 0, participants_without_group: 2, no_coding_scope: 'every' },
  rating: { basis: 'mean_of_participant_scores', score_basis: 'median', scope: 'every_rated_passage_in_the_project', excluded_ratings: {}, unavailable_reason: null },
  rows: [{
    key: 'r1',
    codes: [{
      code_id: 31, name: 'Adequacy', unit: 'participants', rated: true, formed_groups: null,
      cells: [
        { group: 'High', count: 10, n: 11, share: 10 / 11, share_undefined_reason: null, passages: 14, rating: { mean: 2.45, n: 10, undefined_reason: null } },
        { group: 'Low', count: 0, n: 1, share: 0, share_undefined_reason: null, passages: 0, rating: { mean: null, n: 0, undefined_reason: 'no_scores' } },
      ],
      difference: { value: 10 / 11, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null },
    }],
    variables: [
      {
        column_id: 12, name: 'Training hours', dataset_id: 2, unit: 'participants', formed_groups: null, summary: 'mean',
        unavailable_reason: null, categories: [],
        cells: [
          { group: 'High', n: 11, mean: 23.9, mean_undefined_reason: null, sd: 9.8, sd_undefined_reason: null, distribution: [] },
          { group: 'Low', n: 1, mean: 7, mean_undefined_reason: null, sd: null, sd_undefined_reason: 'insufficient_n', distribution: [] },
        ],
        effect: { d: 2.37, ci_lower: 1.26, ci_upper: 3.49, ci_level: 0.95, ci_method: 'hedges_olkin_d', unavailable_reason: null },
      },
      {
        column_id: 13, name: 'Gain', dataset_id: 2, unit: 'participants', formed_groups: 'grouping_variable', summary: 'mean',
        unavailable_reason: null, categories: [],
        cells: [
          { group: 'High', n: 11, mean: 1.2, mean_undefined_reason: null, sd: 0.1, sd_undefined_reason: null, distribution: [] },
          { group: 'Low', n: 1, mean: 0.2, mean_undefined_reason: null, sd: null, sd_undefined_reason: 'insufficient_n', distribution: [] },
        ],
        effect: { d: null, ci_lower: null, ci_upper: null, ci_level: 0.95, ci_method: 'hedges_olkin_d', unavailable_reason: 'formed_groups' },
      },
    ],
    missing_code_ids: [], missing_column_ids: [],
    strands: { codes: 'covers', variables: 'covers' },
  }, {
    key: 'r2', codes: [], variables: [], missing_code_ids: [77], missing_column_ids: [],
    strands: { codes: 'not_measured', variables: 'not_measured' },
  }],
}

const DISPLAY = readDisplay({
  title: 'Teachers | gain',
  group_by_column_id: 11,
  attribution: { label: 'participant', column_id: null },
  settings: { fit_vocabulary: 'fetters', implication: true, newcombe: false },
  rows: [
    {
      key: 'r1', construct: 'Training dosage', code_ids: [31], column_ids: [12, 13], result_material_ids: [90, 91, null, 90],
      results_marked_formed: true, fit: 'confirmation', status: { codes: 'covers', variables: 'silent' },
      meta_inference: { text: 'Hours and ratings agree.', author_id: 2, written_at: '2026-11-05', level: 'specific', type: 'relational' },
      implication: 'Make the 24-hour minimum a precondition.',
      pins: [
        { excerptId: 41, displayText: 'Maybe 32 hours | total.', sourceContext: 'FG', conversationId: 1, observationId: null, group: 'High', role: 'typical', purpose: '' },
        { excerptId: 42, displayText: 'We got 8.', sourceContext: 'FG', conversationId: 1, observationId: null, group: 'Low', role: 'discrepant', purpose: 'The one exception.' },
        { excerptId: null, displayText: '[withdrawn]', sourceContext: '', conversationId: 1, observationId: null, group: 'Low', role: null, purpose: '' },
      ],
    },
    { key: 'r2', construct: '', code_ids: [77, null], fit: null },
  ],
})

const FACTS = new Map<number, JointDisplayPinFact>([
  [41, { excerpt_id: 41, participant_id: 4, participant_identifier: 'T-04', speaker_label: 'Robert', source_name: 'FG 1', column_value: null }],
  [42, { excerpt_id: 42, participant_id: 15, participant_identifier: 'T-15', speaker_label: 'Ana', source_name: 'FG 2', column_value: null }],
])

const RESULT: ReportResult = {
  materialId: 90, name: 'Post-test by School', kind: 'comparison', kindText: 'a saved comparison',
  unit: 'rows of Scores, by School', table: { headers: ['Group', 'n'], rows: [['A', '5']], note: 'Welch t' },
}

const CTX: ReportContext = {
  coderName: id => (id === 1 ? 'Me' : id === 2 ? 'Colleague' : null),
  withholding: false, self: 1, asOf: '12 Nov 2026',
}

function build(over: Partial<ReportInputs> = {}, ctx: Partial<ReportContext> = {}) {
  return buildJointDisplayReport({
    display: DISPLAY, data: DATA, unavailable: null, facts: FACTS, attributionWithheld: null, attributionUnusable: null,
    results: new Map([[90, RESULT]]), resultsUnread: false, misfits: new Map(), ...over,
  }, { ...CTX, ...ctx })
}

const row = (r: ReturnType<typeof build>, i: number) => r.rows[i]

describe('the report table (D174)', () => {
  it('a title naming the display type; a column per group with its size; a difference between two', () => {
    const r = build()
    expect(r.title).toBe('Side-by-side joint display by construct: Teachers | gain')
    expect(r.headers).toEqual([
      'Construct', 'High (11 participants)', 'Low (1 participant)', 'High − Low', 'Fit', 'Meta-inference (type)', 'Implication',
    ])
    const three = build({ data: { ...DATA, groups: [...DATA.groups, { key: 'Mid', participants: 3, with_material: 3, without_coding: 0 }] } })
    expect(three.headers).not.toContain('High − Low')
    expect(three.note).toMatch(/A difference is stated between two groups only, so none is shown\. No significance tests are reported\./)
    expect(build({ display: { ...DISPLAY, settings: { ...DISPLAY.settings, implication: false } } }).headers).not.toContain('Implication')
  })

  it('each group cell: the survey, the code and its rating, then the quotes with attribution and role', () => {
    const r = row(build(), 0)
    expect(r.kind).toBe('construct')
    if (r.kind !== 'construct') return
    expect(r.construct).toBe('Training dosage')
    expect(r.cells[0]).toBe(
      'Survey: Training hours 23.90 (SD 9.80), n 11. Survey: Gain (formed the groups) 1.20 (SD 0.10), n 11. '
      + 'Coded: Adequacy 10 of 11. Rated: Adequacy 2.45 (10 scores). “Maybe 32 hours | total.” (T-04 · FG 1, typical).',
    )   // #1645: the rating is its own sentence, under no strand's name; #1700 (a): so is each pin
    // The undefined SD says WHICH number is missing; a rating with no score says why; a withdrawn
    // pin keeps its blanked words and claims no one.
    expect(r.cells[1]).toContain('Survey: Training hours 7.00, n 1 (SD:')
    // A reason in parentheses drops its own full stop — "(… on this code.)." read twice (driven).
    expect(r.cells[1]).toContain('Coded: Adequacy 0 of 1. Rated: Adequacy — (Nobody in this group has a score on this code).')
    expect(r.cells[1]).not.toContain('.).')
    expect(r.cells[1]).toContain('“We got 8.” (T-15 · FG 2, discrepant) — The one exception.')
    expect(r.cells[1]).toContain('“[withdrawn]”')
    expect(r.cells[1]).not.toMatch(/\[withdrawn\]” \(/)
  })

  it('#1700 (a) (D380): each pin ends as a sentence, so a purpose line never runs into the next quote', () => {
    const [r1] = DISPLAY.rows
    const display = { ...DISPLAY, rows: [{ ...r1, pins: [
      { ...r1.pins[1], purpose: 'Ben, with a vague goal' },   // no full stop of its own
      { ...r1.pins[2] },                                       // the next quote, blanked
    ] }] }
    const r = row(build({ display, data: { ...DATA, rows: [DATA.rows[0]] } }), 0)
    if (r.kind !== 'construct') throw new Error('expected a construct row')
    expect(r.cells[1]).toContain('— Ben, with a vague goal. “[withdrawn]”')
    // A pin ending on its own closing quotation mark has already ended: no `.”.`.
    expect(r.cells[1]).toMatch(/“\[withdrawn\]”$/)
    expect(r.cells[1]).not.toContain('”.')
  })

  it('the difference column: d with its labelled interval, a coded share in pp, and a formed strand’s reason', () => {
    const r = row(build(), 0)
    if (r.kind !== 'construct') throw new Error('not a construct row')
    expect(r.cells[2]).toMatch(/^Training hours: d = 2\.37 \[1\.26, 3\.49\] 95% CI/)
    expect(r.cells[2]).toContain('Gain: Its difference between the groups holds by construction')
    expect(r.cells[2]).toContain('Adequacy: +91 pp.')
  })

  it('fit with the strands that are silent or not measured; a typed, signed meta-inference', () => {
    const r = build()
    const first = row(r, 0), second = row(r, 4)
    if (first.kind !== 'construct' || second.kind !== 'construct') throw new Error('rows')
    expect(first.cells[3]).toBe('Confirmation (survey silent)')
    expect(first.cells[4]).toMatch(/^\(Specific · relational\) Hours and ratings agree\. — Colleague, /)
    expect(first.cells[5]).toBe('Make the 24-hour minimum a precondition.')
    expect(second.construct).toBe('Untitled construct')
    expect(second.cells[3]).toBe('Not set (survey not measured; coded not measured)')
    expect(second.cells[4]).toBe('Not written.')
    expect(second.cells[0]).toBe('Survey: not measured. Coded: not measured.')
  })

  it('while withholding a colleague’s authorship reads "a colleague" and the scope is stated (D170, §6)', () => {
    const r = build({}, { withholding: true })
    const first = row(r, 0)
    if (first.kind !== 'construct') throw new Error('rows')
    expect(first.cells[4]).toMatch(/— a colleague, /)
    expect(first.cells[4]).not.toContain('Colleague')
    expect(r.note).toContain('Scope: coders: Me (blind mode).')
    expect(build().note).not.toContain('Scope:')
    const mine = build({ display: { ...DISPLAY, rows: [{ ...DISPLAY.rows[0], meta_inference: { ...DISPLAY.rows[0].meta_inference!, author_id: 1 } }] } }, { withholding: true })
    expect((mine.rows[0] as { cells: string[] }).cells[4]).toMatch(/— Me, /)
  })

  it('a different-unit result stands BESIDE its construct, once per id, and its own table follows (D165)', () => {
    const r = build()
    const beside = r.rows.filter(x => x.kind === 'beside').map(x => (x as { text: string }).text)
    expect(beside).toEqual([
      expect.stringMatching(/^Beside “Training dosage”: Post-test by School, a saved comparison \(rows of Scores, by School\)\. It stands beside the row as saved: its unit is stated from its source and may not be the display's participants, so it is drawn once across the groups and never split by group\. It was marked as the source of the groups: its difference/),
      'Beside “Training dosage”: a saved result that is no longer in this project.',
      'Beside “Training dosage”: a saved result that did not travel with the project.',
    ])
    expect(r.rows.map(x => x.kind)).toEqual(['construct', 'beside', 'beside', 'beside', 'construct'])
    expect(r.appendix).toEqual([{ title: 'Post-test by School (a saved comparison; rows of Scores, by School)', table: RESULT.table }])
    const unread = build({ results: new Map(), resultsUnread: true })
    expect(unread.rows.filter(x => x.kind === 'beside').map(x => (x as { text: string }).text).slice(0, 2))
      .toEqual(Array(2).fill('Beside “Training dosage”: a saved result that could not be read just now.'))
    expect(unread.appendix).toEqual([])
    const unplaceable = build({ results: new Map([[90, { ...RESULT, unit: null }]]) })
    expect((unplaceable.rows[1] as { text: string }).text).toMatch(/cannot stand beside a construct here/)
    expect(unplaceable.appendix).toEqual([])
  })

  it('the note: bases, rating basis, the rule for differences; the definitions from the ONE vocabulary module', () => {
    const r = build()
    const n = r.note
    expect(n).toMatch(/^Groups: the participants with each value of Gain group \(Roster\); each heading gives the group's size\./)
    expect(n).toContain('2 participants have no Gain group and are in no group.')
    // The notice rule (2026-11-18, rewrite D): each basis short in the note …
    expect(n).toContain(NOTE_RATING_TEXT)
    expect(n).not.toContain(RATING_BASIS_TEXT)
    expect(n).toContain('Differences are High − Low')
    expect(n).toContain('a coded difference is in percentage points, with no interval. No significance tests are reported for these differences.')
    expect(n).toContain(FORMED_GROUPS_HELP)
    expect(n).toContain('1 bound item is no longer in this project and is left out.')
    // Two: the row's unresolved result id and its unresolved code id (D202, null in place).
    expect(n).toContain('2 references in this display did not travel with the project and are shown as missing.')
    expect(n).toMatch(/Numbers as computed on 12 Nov 2026; in the app the display is live\.$/)
    // … and word for word in the Definitions, with the fit, meta-inference and role definitions:
    // vocabulary text IDENTICAL in the UI and the export, verbatim from the module the Compact
    // view shows it from. None of it stays in the note.
    const d = r.definitions.join(' ')
    expect(r.definitionsTitle).toBe('Definitions')
    expect(d).toContain(RATING_BASIS_TEXT)
    expect(d).toContain(CODED_DIFFERENCE_NO_INTERVAL_TEXT)
    expect(d).toContain('Fit, after Fetters, Curry & Creswell (2013), with silence after Farmer et al. (2006).')
    expect(n).not.toContain('Fit, after')
    for (const t of FIT_FETTERS.terms) expect(d).toContain(`${t.label}: ${t.definition}`)
    expect(d).not.toContain(FIT_FARMER.terms.find(t => t.key === 'dissonance')!.label)
    const relational = META_INFERENCE_TYPES.find(t => t.key === 'relational')!
    expect(d).toContain(`Meta-inference types used here. Specific: `)
    expect(d).toContain(`Relational: ${relational.definition}`)
    expect(d).not.toContain('Predictive:')  // only the types the display USES are defined
    for (const role of PIN_ROLES) expect(d).toContain(`${role.label}: ${role.definition}`)
    expect(d).toContain('Each is attributed by participant identifier.')
    const newcombe = build({ display: { ...DISPLAY, settings: { ...DISPLAY.settings, newcombe: true } } })
    expect(newcombe.note).toContain('its interval unadjusted.')
    expect(newcombe.definitions.join(' ')).toContain('over the participants in these groups')
  })

  it('the notice rule (2026-11-18, rewrite D): the note is short, and every file prints the Definitions after the display', () => {
    const r = build()
    expect(r.note.split(/\s+/).length).toBeLessThan(build().definitions.join(' ').split(/\s+/).length)
    const md = reportToMarkdown(r)
    expect(md.indexOf('**Definitions**')).toBeGreaterThan(md.indexOf(r.note.slice(0, 20)))
    for (const a of r.appendix) expect(md.indexOf('**Definitions**')).toBeGreaterThan(md.indexOf(a.title))
    const html = reportToHtml(r, s => String(s))
    expect(html).toContain('<h5>Definitions</h5>')
    expect(html.indexOf('<h5>Definitions</h5>')).toBeGreaterThan(html.indexOf('</table>'))
    expect(reportToDocx(r)).toMatchObject({ definitions_title: 'Definitions', definitions: r.definitions })
  })

  it('a pin whose facts could not be read says so, never that the quote is gone', () => {
    const r = row(build({ facts: null }), 0)
    if (r.kind !== 'construct') throw new Error('rows')
    expect(r.cells[0]).toContain('(attribution could not be read, typical)')
    expect(r.cells[0]).not.toContain('no longer in the project')
  })

  it('no table: one sentence, in every format', () => {
    const none = build({ data: null, unavailable: 'The joint display could not be computed. The server did not answer.' })
    expect(none).toMatchObject({ message: 'The joint display could not be computed. The server did not answer.', rows: [], headers: [] })
    // #1639 (r1-5): a stored display with no grouping variable LOST it — never "not chosen yet".
    expect(build({ data: null, unavailable: null }).message).toBe(
      'The variable that formed this display’s groups is not in this project: it was deleted, or not brought in by an import. Edit the display to choose another.')
    expect(build({ data: { ...DATA, unavailable_reason: 'no_group_values' } }).message).toMatch(/^Nobody has a value for Gain group/)
    expect(reportToMarkdown(none)).toContain('*The joint display could not be computed. The server did not answer.*')
    expect(reportToHtml(none, String)).toContain('<em>The joint display could not be computed.')
    expect(reportToDocx(none)).toMatchObject({ message: none.message, rows: [], span_rows: [] })
  })
})

describe('the plain renderings', () => {
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  it('Markdown escapes a pipe and a line break in authored text, and gives a beside row its first cell', () => {
    const md = reportToMarkdown(build())
    expect(md).toContain('**Side-by-side joint display by construct: Teachers \\| gain**')
    expect(md).toContain('“Maybe 32 hours \\| total.”')
    const lines = md.split('\n').filter(l => l.startsWith('| Beside'))
    expect(lines).toHaveLength(3)
    expect(lines[0].split(' | ')).toHaveLength(build().headers.length)
    expect(md).toContain('**Post-test by School (a saved comparison; rows of Scores, by School)**')
    expect(md).toContain('Welch t')
    const broken = reportToMarkdown(build({ display: { ...DISPLAY, rows: [{ ...DISPLAY.rows[0], implication: 'a\nb' }] } }))
    expect(broken).toContain('| a b |')
  })

  it('HTML: column and row headers, a beside row spanning the table, escaped text', () => {
    const html = reportToHtml(build({ display: { ...DISPLAY, title: '<b>x</b>' } }), esc)
    expect(html).toContain('<h4>Side-by-side joint display by construct: &lt;b&gt;x&lt;/b&gt;</h4>')
    expect(html).toContain('<th scope="col">High (11 participants)</th>')
    expect(html).toContain('<th scope="row">Training dosage</th>')
    expect(html).toMatch(/<tr class="beside"><td colspan="7">Beside/)
    expect(html).toContain('<p class="note">Groups:')
    expect(html).not.toContain('<b>x</b>')
  })

  it('Word: the same strings, a beside row as ONE cell named in span_rows', () => {
    const d = reportToDocx(build())
    expect(d.span_rows).toEqual([1, 2, 3])
    expect(d.rows[1]).toHaveLength(1)
    expect(d.rows[0][0]).toBe('Training dosage')
    expect(d.rows[0]).toHaveLength(d.headers.length)
    expect(d.appendix).toEqual([{ title: 'Post-test by School (a saved comparison; rows of Scores, by School)', headers: ['Group', 'n'], rows: [['A', '5']], note: 'Welch t' }])
    expect(d.note).toBe(build().note)
  })
})

describe('participants with no coding in scope (#1626, D244)', () => {
  it('the note says them — so the Report view and every export do — in the stated scope’s words', () => {
    const data = {
      ...DATA,
      groups: [{ ...DATA.groups[0], without_coding: 3 }, DATA.groups[1]],
      scope: { ...DATA.scope, no_coding_scope: 'coders' },
    }
    const note = build({ data }).note
    expect(note).toContain(noCodingNote([['High', 3], ['Low', 0]], 'coders')!)
    // It sits right after the sentence saying what a coded count is.
    expect(note.indexOf('A coded count is')).toBeLessThan(note.indexOf('Some participants have no coding by the coders shown'))
  })

  it('POSITIVE CONTROL: with none in any group the note says nothing about it', () => {
    expect(build().note).not.toContain('no coding')
  })
})

describe('#1615 D286 — the note names an attribution column left out while blind', () => {
  it('says it after the quotes’ sentence, in the decided words', () => {
    const note = build({ attributionWithheld: 'Score band' }).note
    expect(note).toContain("Score band is left out of the quotes' attribution while blind: it comes from participant scores, which combine every coder's ratings.")
    expect(note.indexOf('Score band is left out')).toBeGreaterThan(note.indexOf('Each is attributed by'))
  })

  it('POSITIVE CONTROL: nothing withheld, nothing said', () => {
    expect(build().note).not.toContain('left out of the quotes')
  })
})

// #1639 follow-up (r1-8): a bound code the codebook made inactive — left out, and SAID in the
// note every export reads, by construct and by name, with where a merge moved its coding.
describe('#1639 follow-up — a bound code that is inactive in the codebook', () => {
  const inactive = (merged: string | null) => ({
    ...DATA,
    rows: DATA.rows.map((r, i) => i === 0 ? { ...r, inactive_codes: [{
      strand_key: 'codes', code_id: 31, name: 'Trust',
      merged_into_id: merged ? 32 : null, merged_into_name: merged }] } : r),
  })

  it('a merged one names the code it was merged into, and what to do', () => {
    expect(build({ data: inactive('Confidence') }).note).toContain(
      'Training dosage: “Trust” was merged into “Confidence”, so it has no coding of its own to show here. Edit the row to bind “Confidence”.')
  })

  it('a deactivated one says it is inactive and is left out as in the rest of the analysis', () => {
    expect(build({ data: inactive(null) }).note).toContain(
      'Training dosage: “Trust” is inactive in the codebook, so it is left out here, as in the rest of the analysis. Reactivate it in the codebook, or edit the row.')
  })

  it('control: with none, nothing is said', () => {
    expect(build().note).not.toMatch(/inactive in the codebook|was merged into/)
    expect(build({ data: inactive(null) }).note).toMatch(/inactive in the codebook/)  // the matcher can match
  })
})
