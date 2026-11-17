/**
 * Joint display slice 2 (r4, reconciled by R7/R9): open-text ANSWERS as quote suggestions.
 *
 * - r4-1 / R9: a suggestion is asked with the PIN'S STRAND's own sources (`pinPassagesRequest`)
 *   — a survey comments (`text_codes`) strand's questions, the SAME list its count reads, so a
 *   suggested answer is one that strand counts (D209); a codes strand reads no answers. An absent
 *   list reads as NONE, never every. (r4's POOLING stub — answers as material of the interview
 *   strand, a display-level `text_column_ids` — was superseded by L3 and is not in the combine;
 *   its guards F2/F5 went with it.)
 * - r4-2: pinning an answer gets or creates its WHOLE quote by `dataset_value_id`, and the pin
 *   is exactly `excerptEmbedAttrs` of that quote plus its strand — no conversation, no clip.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'

vi.mock('@/lib/api', () => ({
  jointDisplayApi: { passages: vi.fn() },
  excerptsApi: { wholePassage: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

import { excerptsApi, jointDisplayApi, type JointDisplayComputeResponse, type JointDisplayPinFact } from '@/lib/api'
import { buildJointDisplayReport } from '@/lib/joint-display-report'
import { pinAttribution } from './display-helpers'
import {
  displayCoderScope, pinPassagesRequest, readDisplay, unresolvedReferenceCount,
  type JointDisplay,
} from '@/lib/joint-display'
import PinPicker from './PinPicker'

const EVERY = displayCoderScope(false, null)

/** A slice-1 display as session B stored it: no `text_column_ids` key at all. */
const SLICE_1 = {
  title: 'T', group_by_column_id: 11, conversation_ids: null, document_ids: [4],
  attribution: { label: 'participant', column_id: null },
  settings: { fit_vocabulary: 'fetters', implication: false, newcombe: false },
  rows: [{ key: 'r1', construct: 'Planning', code_ids: [31], column_ids: [], pins: [] }],
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

/** An explicit display: interviews over conversation 7, survey comments over two questions. */
const EXPLICIT = {
  title: 'T', group_by_column_id: 11,
  strands: [
    { key: 'int', kind: 'codes', label: 'Interviews', conversation_ids: [7], document_ids: [] },
    { key: 'cm', kind: 'text_codes', label: 'Survey comments', text_column_ids: [21, null, 22] },
    { key: 'cm0', kind: 'text_codes', label: 'Other comments' },
  ],
  rows: [{ key: 'r1', construct: 'Planning', bindings: { int: { code_ids: [31] }, cm: { code_ids: [31] } }, pins: [] }],
}

describe("a suggestion asks with the pin's strand's own sources (r4-1, R9)", () => {
  it("a slice-1 display (no strand named) asks its implicit codes strand's sources, and no answers", () => {
    const req = pinPassagesRequest(readDisplay(SLICE_1), undefined, 'High', 31, EVERY)!
    expect(req.conversation_ids).toBeNull()
    expect(req.document_ids).toEqual([4])
    expect(req.text_column_ids).toEqual([])
  })

  it("a survey comments strand sends ITS questions and no passages; an unresolved id is left out", () => {
    const d = readDisplay(EXPLICIT)
    const req = pinPassagesRequest(d, 'cm', 'High', 31, EVERY)!
    expect(req.text_column_ids).toEqual([21, 22])
    expect(req.conversation_ids).toEqual([])
    expect(req.document_ids).toEqual([])
    expect(unresolvedReferenceCount(d)).toBe(1)  // D202: a column that did not travel is said
  })

  it('reads an absent question list as NONE — never as every column', () => {
    const req = pinPassagesRequest(readDisplay(EXPLICIT), 'cm0', 'High', 31, EVERY)!
    expect(req.text_column_ids).toEqual([])
    expect(req.conversation_ids).toEqual([])
  })

  it("a codes strand sends its own sources and no answers; an unknown key falls back to the first codes strand", () => {
    const d = readDisplay(EXPLICIT)
    for (const key of ['int', 'gone', undefined]) {
      const req = pinPassagesRequest(d, key, 'High', 31, EVERY)!
      expect(req.conversation_ids).toEqual([7])
      expect(req.document_ids).toEqual([])
      expect(req.text_column_ids).toEqual([])
    }
  })
})

const QUOTE = {
  id: 77, segment_id: null, dataset_value_id: 501, start_offset: null, end_offset: null,
  start_time: null, end_time: null, excerpt_text: 'Friday afternoons are protected',
  source_kind: 'text', source_name: 'Survey › Comments', conversation_id: null,
  conversation_name: null, observation_id: null, observation_name: null, speaker_name: null,
  segment_timestamp: null, note: null, has_note: false, created_at: '2026-11-15T00:00:00Z',
  created: true,
}

function mount(display: JointDisplay, onPin = vi.fn(() => 'added' as const),
  codes: { id: number; name: string; strandKey?: string }[] = [{ id: 31, name: 'Planning time' }]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <PinPicker open onOpenChange={() => {}} projectId={1} display={display} construct="Planning"
        group="High" codes={codes} scope={EVERY} onPin={onPin} />
    </QueryClientProvider>,
  )
  return onPin
}

describe('the pin picker (r4-2)', () => {
  it('lists a coded answer, and pins its WHOLE quote as an excerpt-embed with no conversation', async () => {
    vi.mocked(jointDisplayApi.passages).mockResolvedValue({
      code_id: 31, code_name: 'Planning time', code_color: null, category_name: null,
      total_segments: 1, conversation_total: 0, document_total: 0, observation_total: 0,
      has_more: false, conversations: [], documents: [], observations: [],
      answer_total: 1,
      answers: [{ dataset_value_id: 501, text: 'Friday afternoons are protected', column_id: 21,
        source_name: 'Survey › Comments', participant_id: 10, participant_name: 'T10', is_quoted: false }],
    })
    vi.mocked(excerptsApi.wholePassage).mockResolvedValue(QUOTE)
    const display = readDisplay(EXPLICIT)
    const onPin = mount(display, undefined, [
      { id: 31, name: 'Planning time · Interviews', strandKey: 'int' },
      { id: 31, name: 'Planning time · Survey comments', strandKey: 'cm' },
    ])
    // R9: choose the survey comments strand's code — the request then asks ITS questions.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } })

    expect(await screen.findByText('“Friday afternoons are protected”')).toBeInTheDocument()
    expect(screen.getByText('T10 · Survey › Comments')).toBeInTheDocument()
    const calls = vi.mocked(jointDisplayApi.passages).mock.calls
    const asked = calls[calls.length - 1][1]
    expect(asked.text_column_ids).toEqual([21, 22])
    expect(asked.conversation_ids).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Pin “Friday afternoons are protected”' }))
    await waitFor(() => expect(onPin).toHaveBeenCalled())
    expect(vi.mocked(excerptsApi.wholePassage)).toHaveBeenCalledWith(1, { dataset_value_id: 501 })
    expect(onPin).toHaveBeenCalledWith({
      excerptId: 77, displayText: 'Friday afternoons are protected', sourceContext: 'Survey › Comments',
      conversationId: null, observationId: null, group: 'High', role: null, purpose: '', strand: 'cm',
    })
  })
})

const DATA: JointDisplayComputeResponse = {
  unit: 'participants',
  group_by: { column_id: 11, name: 'Gain group', dataset_id: 1, dataset_name: 'Roster' },
  groups: [{ key: 'High', participants: 5, with_material: 5, without_coding: 0 },
           { key: 'Low', participants: 3, with_material: 3, without_coding: 0 }],
  unavailable_reason: null,
  scope: { conversations: 1, documents: 1, unassigned_passages: 0, participants_without_group: 0,
           no_coding_scope: 'every' },
  rating: null,
  rows: [{
    key: 'r1', variables: [], missing_code_ids: [], missing_column_ids: [],
    strands: { codes: 'covers', variables: 'not_measured' },
    codes: [{ code_id: 31, name: 'Planning time', unit: 'participants', rated: false, formed_groups: null,
      cells: [{ group: 'High', count: 4, n: 5, share: 0.8, share_undefined_reason: null, passages: 5, rating: null },
              { group: 'Low', count: 1, n: 3, share: 1 / 3, share_undefined_reason: null, passages: 1, rating: null }],
      difference: { value: 0.4667, ci_lower: null, ci_upper: null, ci_level: null, ci_method: null, unavailable_reason: null } }],
  }],
}

function report(display: JointDisplay, facts = new Map<number, JointDisplayPinFact>()) {
  return buildJointDisplayReport({
    display, data: DATA, unavailable: null, facts, attributionWithheld: null, attributionUnusable: null,
    results: new Map(), resultsUnread: false, misfits: new Map(),
  }, { coderName: () => null, withholding: false, self: 1, asOf: '15 Nov 2026' })
}

describe('an answer pin is attributed from its live facts (r4-3, D163.4)', () => {
  const pin = { excerptId: 77, displayText: 'Friday afternoons are protected', sourceContext: 'Survey › Comments',
    conversationId: null, observationId: null, group: 'High', role: 'typical' as const, purpose: '' }
  const fact: JointDisplayPinFact = { excerpt_id: 77, participant_id: 10, participant_identifier: 'T10',
    speaker_label: null, source_name: 'Survey › Comments', column_value: null }

  it('with no source kind (a fact read before slice 2): identifier · question, as before (control)', () => {
    expect(pinAttribution(pin, fact, { label: 'participant', column_id: null })).toBe('T10 · Survey › Comments')
    expect(pinAttribution(pin, fact, { label: 'speaker', column_id: null })).toBe('Survey › Comments')
    const d = readDisplay({ ...SLICE_1, rows: [{ ...SLICE_1.rows[0], pins: [pin] }] })
    const first = report(d, new Map([[77, fact]])).rows[0]
    expect(first.kind === 'construct' ? first.cells.join(' ') : '').toContain(
      '“Friday afternoons are protected” (T10 · Survey › Comments, typical)')
  })
})

describe('a survey answer pin says it is a survey answer (R8, r4-4)', () => {
  const pin = { excerptId: 78, displayText: 'We plan on Fridays', sourceContext: 'Baseline survey › Comments',
    conversationId: null, observationId: null, group: 'High', role: null, purpose: '' }
  const fact: JointDisplayPinFact = { excerpt_id: 78, participant_id: 10, participant_identifier: 'T10',
    speaker_label: null, source_name: 'Baseline survey › Comments', source_kind: 'answer', column_value: null }

  it('in every attribution mode, and a turn is unchanged beside it', () => {
    expect(pinAttribution(pin, fact, { label: 'participant', column_id: null }))
      .toBe('T10 · Survey answer (Baseline survey › Comments)')
    expect(pinAttribution(pin, fact, { label: 'speaker', column_id: null })).toBe('Survey answer (Baseline survey › Comments)')
    expect(pinAttribution(pin, fact, { label: 'source', column_id: null })).toBe('Survey answer (Baseline survey › Comments)')
    expect(pinAttribution(pin, fact, { label: 'none', column_id: null })).toBe('')
    const turn: JointDisplayPinFact = { ...fact, speaker_label: 'S1', source_name: 'Focus group', source_kind: 'conversation' }
    expect(pinAttribution(pin, turn, { label: 'participant', column_id: null })).toBe('T10 · Focus group')
  })
})
