/**
 * Joint display slice 2 (r6-9, r6-10): round 1's two builder residuals — (1) a FAILED observations
 * read is said, never offered as "Every one (0)" (#961's class); (2) removing a strand that
 * recorded fits name warns first, with how many (`fitsNamingStrand`). Positive controls: an
 * answered list still offers "Every one (1)"; a strand no fit names is removed at once, as before.
 * Q6 (round-2 combine): a construct's codes from one strand stop at the server's 50, said in the list.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'

const observations = vi.fn()
const codesList = vi.fn()
const analysisColumns = vi.fn()
const textColumns = vi.fn()
const col = (id: number, name: string, column_type: string) => ({ id, dataset_id: 1, dataset_name: 'Roster', column_code: null,
  column_name: name, column_text: name, column_type, scale_labels: null, equivalence_group_id: null, domain_ids: [] })
// `analysis-columns` lists NO open-text column (as the server does) — the questions come from
// Text Coding's own read, `textCodingApi.columns` (the build's drive found the picker empty).
const ROSTER = { domains: [], demographics: [], datasets: [{ id: 1, name: 'Roster', columns: [col(11, 'Gain group', 'nominal')] }] }
const question = (id: number, name: string) => ({ column_id: id, dataset_id: 1, dataset_name: 'Roster', column_name: name,
  column_text: name, column_type: 'open_text', sequence_order: id, total_rows: 10, non_empty_rows: 9, coded_rows: 0 })
vi.mock('@/lib/api', () => ({
  metricsApi: { analysisColumns: (...a: unknown[]) => analysisColumns(...a) },
  textCodingApi: { columns: (...a: unknown[]) => textColumns(...a) },
  codesApi: { list: (...a: unknown[]) => codesList(...a) },
  conversationsApi: { list: vi.fn().mockResolvedValue({ total: 1, conversations: [{ id: 5, name: 'Focus group 1' }] }) },
  documentsApi: { list: vi.fn().mockResolvedValue([]) },
  materialsApi: { listAllMaterials: vi.fn().mockResolvedValue([]) },
  observationsApi: { list: (...a: unknown[]) => observations(...a) },
}))
vi.mock('@/hooks/useAnalysisScope', () => ({
  useAnalysisScope: () => ({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }),
}))

import JointDisplayBuilder from './JointDisplayBuilder'
import { readDisplay, type JointDisplay } from '@/lib/joint-display'

const initial = (fit: string | null): JointDisplay => readDisplay({
  title: 'T', group_by_column_id: 11,
  strands: [
    { key: 'iv', kind: 'codes', label: 'Interviews' },
    { key: 'fg', kind: 'codes', label: 'Focus groups' },
    { key: 'ob', kind: 'observation_codes', label: 'Site visits', observation_ids: null },
  ],
  rows: [{ key: 'r1', construct: 'Planning', bindings: { iv: { code_ids: [31] }, fg: { code_ids: [31] } },
    fits: [{ strands: ['iv', 'fg'], fit }], meta_inference: { text: 'Kept as written.' } }],
})

function mount(display: JointDisplay) {
  const onSubmit = vi.fn()
  // The app's own retry (1, no delay): a retry policy cannot be tested under `retry: false` (§4).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <JointDisplayBuilder open onOpenChange={() => {}} projectId={1} initial={display} mode="edit" onSubmit={onSubmit} />
    </QueryClientProvider>,
  )
  return onSubmit
}

beforeEach(() => {
  codesList.mockResolvedValue({ total: 1, codes: [{ id: 31, name: 'Planning time', is_active: true, is_universal: false }] })
  analysisColumns.mockResolvedValue(ROSTER)
  textColumns.mockResolvedValue({ columns: [] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('joint display slice 2 — the builder residuals (r6-9, r6-10)', () => {
  it('a FAILED observations read is said, with a Retry — never "Every one (0)"', async () => {
    observations.mockRejectedValue(new Error('boom'))
    mount(initial(null))
    expect(await screen.findByText('The observations could not be loaded')).toBeInTheDocument()
    // The strand's source choice is not drawn at all — a failure is not "every one of none".
    expect(screen.queryByRole('group', { name: 'Observations for Site visits' })).toBeNull()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
  })

  it('POSITIVE CONTROL: an answered list offers its observations', async () => {
    observations.mockResolvedValue([{ id: 8, name: 'Site visit 1' }])
    mount(initial(null))
    const group = await screen.findByRole('group', { name: 'Observations for Site visits' })
    expect(within(group).getByText('Every one (1)')).toBeInTheDocument()
  })

  it('removing a strand a recorded fit names warns first — Keep leaves it, Remove takes the fit with it', async () => {
    observations.mockResolvedValue([])
    const onSubmit = mount(initial('expansion'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Focus groups' }))
    expect(screen.getByText('Removing Focus groups also removes 1 recorded fit that compares it with another strand. The meta-inferences stay as written.')).toBeInTheDocument()
    expect(screen.getAllByLabelText(/^Strand \d+ name$/)).toHaveLength(3)
    const keep = screen.getByRole('button', { name: 'Keep the strand' })
    expect(keep).toHaveFocus()
    fireEvent.click(keep)
    expect(screen.queryByText(/also removes 1 recorded fit/)).toBeNull()
    expect(screen.getAllByLabelText(/^Strand \d+ name$/)).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Focus groups' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the strand and its fits' }))
    expect(screen.getAllByLabelText(/^Strand \d+ name$/)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const saved = onSubmit.mock.calls[0][0] as JointDisplay
    expect(saved.strands.map(s => s.key)).toEqual(['iv', 'ob'])
    expect(saved.rows[0].fits).toEqual([])
    expect(saved.rows[0].meta_inference?.text).toBe('Kept as written.')
  })

  it('Q6: a construct takes up to 50 codes from one strand — the 51st is not offered, and the list says why', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: 100 + i, name: `Code ${i + 1}`, is_active: true, is_universal: false }))
    codesList.mockResolvedValue({ total: 51, codes: many })
    observations.mockResolvedValue([])
    mount(readDisplay({
      title: 'T', group_by_column_id: 11,
      strands: [{ key: 'iv', kind: 'codes', label: 'Interviews' }, { key: 'fg', kind: 'codes', label: 'Focus groups' }],
      rows: [{ key: 'r1', construct: 'Planning', bindings: { iv: { code_ids: many.slice(0, 50).map(c => c.id) } } }],
    }))
    fireEvent.click(await screen.findByRole('button', { name: /^Interviews for Planning: 50 chosen/ }))
    const limit = 'A construct holds up to 50 codes or variables from each strand. Clear one to choose another.'
    expect(await screen.findByText(limit)).toBeInTheDocument()
    expect(screen.getByLabelText('Code 51')).toBeDisabled()
    // The disabled box is DESCRIBED by the reason (the build's open item); an enabled one is not.
    expect(screen.getByLabelText('Code 51')).toHaveAccessibleDescription(limit)
    expect(screen.getByLabelText('Code 1')).not.toHaveAccessibleDescription()
    // A chosen one still clears, and then the 51st is offered again.
    expect(screen.getByLabelText('Code 1')).toBeEnabled()
    fireEvent.click(screen.getByLabelText('Code 1'))
    expect(screen.queryByText(/holds up to 50 codes/)).toBeNull()
    expect(screen.getByLabelText('Code 51')).toBeEnabled()
    // POSITIVE CONTROL: the other strand's list, with nothing chosen, offers every code.
    cleanup()
    mount(readDisplay({
      title: 'T', group_by_column_id: 11,
      strands: [{ key: 'iv', kind: 'codes', label: 'Interviews' }, { key: 'fg', kind: 'codes', label: 'Focus groups' }],
      rows: [{ key: 'r1', construct: 'Planning', bindings: { iv: { code_ids: [100] } } }],
    }))
    fireEvent.click(await screen.findByRole('button', { name: /^Focus groups for Planning: 0 chosen/ }))
    expect(await screen.findByLabelText('Code 51')).toBeEnabled()
    expect(screen.queryByText(/holds up to 50 codes/)).toBeNull()
  })

  it("a survey comments strand's questions stop at the server's 50 too, said in the list's own words", async () => {
    // The build's open item: `text_column_ids` is capped at 50 by the server (a 51st 422'd the
    // whole display) and the questions picker had no client cap.
    const questions = Array.from({ length: 51 }, (_, i) => question(200 + i, `Q${i + 1}`))
    textColumns.mockResolvedValue({ columns: questions })
    observations.mockResolvedValue([])
    mount(readDisplay({
      title: 'T', group_by_column_id: 11,
      strands: [{ key: 'iv', kind: 'codes', label: 'Interviews' },
        { key: 'tc', kind: 'text_codes', label: 'Comments', text_column_ids: questions.slice(0, 50).map(q => q.column_id) }],
      rows: [{ key: 'r1', construct: 'Planning', bindings: { iv: { code_ids: [31] } } }],
    }))
    fireEvent.click(await screen.findByRole('button', { name: /^Questions for Comments: 50 chosen/ }))
    const limit = 'A survey comments strand holds up to 50 questions. Clear one to choose another.'
    expect(await screen.findByText(limit)).toBeInTheDocument()
    expect(screen.getByLabelText('Roster › Q51')).toBeDisabled()
    expect(screen.getByLabelText('Roster › Q51')).toHaveAccessibleDescription(limit)
    expect(screen.queryByText(/codes or variables from each strand/)).toBeNull()
    fireEvent.click(screen.getByLabelText('Roster › Q1'))
    expect(screen.getByLabelText('Roster › Q51')).toBeEnabled()
    expect(screen.queryByText(limit)).toBeNull()
  })

  it("a survey comments strand offers the project's open-text questions — which analysis-columns never lists", async () => {
    textColumns.mockResolvedValue({ columns: [question(301, 'Comments')] })
    observations.mockResolvedValue([])
    mount(readDisplay({
      title: 'T', group_by_column_id: 11,
      strands: [{ key: 'iv', kind: 'codes', label: 'Interviews' }, { key: 'tc', kind: 'text_codes', label: 'Comments' }],
      rows: [{ key: 'r1', construct: 'Planning', bindings: { iv: { code_ids: [31] } } }],
    }))
    fireEvent.click(await screen.findByRole('button', { name: /^Questions for Comments: 0 chosen/ }))
    expect(await screen.findByLabelText('Roster › Comments')).toBeEnabled()
    expect(screen.queryByText('Nothing matches.')).toBeNull()
    expect(textColumns).toHaveBeenCalledWith(1)
  })

  it('a FAILED questions read is said, with a Retry — never an empty "Nothing matches." list', async () => {
    textColumns.mockRejectedValue(new Error('boom'))
    observations.mockResolvedValue([])
    mount(readDisplay({
      title: 'T', group_by_column_id: 11,
      strands: [{ key: 'iv', kind: 'codes', label: 'Interviews' }, { key: 'tc', kind: 'text_codes', label: 'Comments' }],
      rows: [{ key: 'r1', construct: 'Planning', bindings: { iv: { code_ids: [31] } } }],
    }))
    expect(await screen.findByText('The questions could not be loaded')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Questions for Comments/ })).toBeNull()
  })

  it('POSITIVE CONTROL: a strand no recorded fit names goes at once, as before', async () => {
    observations.mockResolvedValue([])
    mount(initial(null))   // the pair's fit is unset — nothing to lose
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Focus groups' }))
    expect(screen.queryByText(/recorded fit/)).toBeNull()
    expect(screen.getAllByLabelText(/^Strand \d+ name$/)).toHaveLength(2)
  })
})
