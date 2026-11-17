/**
 * #1668 (D344) — the pin picker's words follow the strand it reads; #1653 (D347) — a gone
 * grouping variable in the display's own sentence.
 *
 * A survey comments (`text_codes`) strand's request reads only its questions, so it lists coded
 * ANSWERS — and the picker said *"2 coded passages in this group"* above two answers (the
 * 2026-11-16d drive). Five strings said "passage": the count, the loading line, the failure line,
 * the empty line and the list's name. They come from ONE rule now, `pinPoolUnit`, which is
 * `pinPassagesRequest`'s own (`pinStrand`), so the words and the request cannot disagree.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'

vi.mock('@/lib/api', () => ({
  jointDisplayApi: { passages: vi.fn() },
  excerptsApi: { wholePassage: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

import { jointDisplayApi } from '@/lib/api'
import { displayCoderScope, pinPoolUnit, pinPassagesRequest, readDisplay, type JointDisplay } from '@/lib/joint-display'
import { GROUPING_GONE_TEXT, SERVER_VOCABULARY } from '@/lib/joint-display-vocabulary'
import PinPicker from './PinPicker'

const EVERY = displayCoderScope(false, null)
const DISPLAY = readDisplay({
  title: 'T', group_by_column_id: 11,
  strands: [
    { key: 'int', kind: 'codes', label: 'Interviews', conversation_ids: [7], document_ids: [] },
    { key: 'cm', kind: 'text_codes', label: 'Survey comments', text_column_ids: [21] },
  ],
  rows: [{ key: 'r1', construct: 'Planning', bindings: { int: { code_ids: [31] }, cm: { code_ids: [31] } }, pins: [] }],
})
const CODES = [
  { id: 31, name: 'Planning time · Interviews', strandKey: 'int' },
  { id: 31, name: 'Planning time · Survey comments', strandKey: 'cm' },
]

const answers = (n: number) => ({
  code_id: 31, code_name: 'Planning time', code_color: null, category_name: null,
  total_segments: n, conversation_total: 0, document_total: 0, observation_total: 0,
  has_more: false, conversations: [], documents: [], observations: [], answer_total: n,
  answers: Array.from({ length: n }, (_, i) => ({
    dataset_value_id: 500 + i, text: `Answer ${i}`, column_id: 21, source_name: 'Survey › Comments',
    participant_id: 10 + i, participant_name: `T${10 + i}`, is_quoted: false,
  })),
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

function mount(display: JointDisplay = DISPLAY) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <PinPicker open onOpenChange={() => {}} projectId={1} display={display} construct="Planning"
        group="High" codes={CODES} scope={EVERY} onPin={vi.fn(() => 'added' as const)} />
    </QueryClientProvider>,
  )
}

const chooseComments = () => fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } })

describe('#1668 (D344) — the words follow the strand the request reads', () => {
  it('the unit is the request\'s: answers exactly when the request reads only questions', () => {
    for (const key of ['int', 'cm', 'gone', undefined]) {
      const req = pinPassagesRequest(DISPLAY, key, 'High', 31, EVERY)!
      const readsOnlyAnswers = req.text_column_ids.length > 0 && req.conversation_ids?.length === 0
      expect(pinPoolUnit(DISPLAY, key)).toBe(readsOnlyAnswers ? 'answers' : 'passages')
    }
  })

  it('a survey comments strand counts and names ANSWERS', async () => {
    vi.mocked(jointDisplayApi.passages).mockResolvedValue(answers(2))
    mount()
    chooseComments()
    expect(await screen.findByText('2 coded answers in this group.')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Answers to pin' })).toBeInTheDocument()
    // The picker's own lines (the dialog's description names both kinds, on purpose).
    expect(screen.queryByText(/^\d+ coded passages? in this group/)).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Passages to pin' })).not.toBeInTheDocument()
  })

  it('one answer is singular, and an empty group says answers and questions', async () => {
    vi.mocked(jointDisplayApi.passages).mockResolvedValue(answers(1))
    mount()
    chooseComments()
    expect(await screen.findByText('1 coded answer in this group.')).toBeInTheDocument()
    cleanup()
    vi.mocked(jointDisplayApi.passages).mockResolvedValue(answers(0))
    mount()
    chooseComments()
    expect(await screen.findByText('Nobody in this group has an answer with this code in this strand’s questions.'))
      .toBeInTheDocument()
  })

  it('its loading and failure lines say answers', async () => {
    vi.mocked(jointDisplayApi.passages).mockImplementation(() => new Promise(() => {}))
    mount()
    chooseComments()
    expect(await screen.findByText('Loading this group’s answers…')).toBeInTheDocument()
    cleanup()
    vi.mocked(jointDisplayApi.passages).mockRejectedValue(Object.assign(new Error('x'), { status: 500 }))
    mount()
    chooseComments()
    expect(await screen.findByRole('alert')).toHaveTextContent(/^The answers could not be loaded\./)
  })

  it('control: a codes strand keeps "passages"', async () => {
    vi.mocked(jointDisplayApi.passages).mockResolvedValue({ ...answers(0), total_segments: 3, answer_total: 0 })
    mount()
    expect(await screen.findByText('3 coded passages in this group.')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Passages to pin' })).toBeInTheDocument()
  })
})

describe('#1653 (D347) — a gone grouping variable in the display\'s own sentence', () => {
  it('the picker says GROUPING_GONE_TEXT, not "That variable is not in this project."', async () => {
    const detail = { code: SERVER_VOCABULARY.GROUPING_GONE, message: 'That variable is not in this project.' }
    vi.mocked(jointDisplayApi.passages).mockRejectedValue(
      Object.assign(new Error('x'), { status: 404, response: { status: 404, data: { detail }, headers: {} } }))
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent(GROUPING_GONE_TEXT)
    expect(screen.getByRole('alert')).not.toHaveTextContent('could not be loaded')
  })
})
