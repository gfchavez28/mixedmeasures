/**
 * #1644 review (r3-3): the builder stops at the server's 100 constructs and says why — a 101st made
 * the whole display fail to compute ("List should have at most 100 items…"), D317's class. And
 * (r3-1) a strand's CHOSEN sources have no client cap: the server takes far more than a person ticks.
 * Follow-up: at the 4-strand cap the four *Add … strand* buttons are described by the sentence too.
 * Positive controls: below the cap *Add construct* adds; a chosen list past 500 is offered whole.
 * Mocks as `JointDisplayBuilder-residuals-slice2.test.tsx`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'

const conversations = vi.fn()
const analysisColumns = vi.fn()
const codesList = vi.fn()
const col = (id: number, name: string, column_type: string) => ({ id, dataset_id: 1, dataset_name: 'Roster', column_code: null,
  column_name: name, column_text: name, column_type, scale_labels: null, equivalence_group_id: null, domain_ids: [] })
const ROSTER = { domains: [], demographics: [], datasets: [{ id: 1, name: 'Roster', columns: [col(11, 'Gain group', 'nominal')] }] }
vi.mock('@/lib/api', () => ({
  metricsApi: { analysisColumns: (...a: unknown[]) => analysisColumns(...a) },
  textCodingApi: { columns: vi.fn().mockResolvedValue({ columns: [] }) },
  codesApi: { list: (...a: unknown[]) => codesList(...a) },
  conversationsApi: { list: (...a: unknown[]) => conversations(...a) },
  documentsApi: { list: vi.fn().mockResolvedValue([]) },
  materialsApi: { listAllMaterials: vi.fn().mockResolvedValue([]) },
  observationsApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/hooks/useAnalysisScope', () => ({
  useAnalysisScope: () => ({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }),
}))

import JointDisplayBuilder from './JointDisplayBuilder'
import { readDisplay, type JointDisplay } from '@/lib/joint-display'
import {
  CONSTRUCT_LIMIT_TEXT, MAX_CONSTRUCTS, MAX_STRANDS_IN_BUILDER, STRAND_KIND_TERMS, STRAND_LIMIT_TEXT,
} from '@/lib/joint-display-vocabulary'

function mount(display: JointDisplay) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <JointDisplayBuilder open onOpenChange={() => {}} projectId={1} initial={display} mode="edit" onSubmit={vi.fn()} />
    </QueryClientProvider>,
  )
}

const withRows = (n: number) => readDisplay({
  title: 'T', group_by_column_id: 11,
  rows: Array.from({ length: n }, (_, i) => ({ key: `r${i}`, construct: `C${i + 1}`, code_ids: [31] })),
})
const strandsDisplay = (n: number) => readDisplay({
  title: 'T', group_by_column_id: 11,
  strands: [{ key: 'a', kind: 'codes', label: 'A' }, { key: 'b', kind: 'codes', label: 'B' },
    { key: 'c', kind: 'variables', label: 'C' }, { key: 'd', kind: 'observation_codes', label: 'D' }].slice(0, n),
  rows: [{ key: 'r1', construct: 'Planning', bindings: { a: { code_ids: [31] } } }],
})
const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(null)))

beforeEach(() => {
  analysisColumns.mockResolvedValue(ROSTER)
  codesList.mockResolvedValue({ total: 1, codes: [{ id: 31, name: 'Planning time', is_active: true, is_universal: false }] })
  conversations.mockResolvedValue({ total: 1, conversations: [{ id: 5, name: 'Focus group 1' }] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#1644 review — the builder mirrors the server where a person can reach its bound', () => {
  it('r3-3: at the server’s 100 constructs, Add construct stops and says why — and removing one frees it', async () => {
    expect(MAX_CONSTRUCTS).toBe(100)   // the server's MAX_DISPLAY_ROWS (held by the Python contract test)
    mount(withRows(MAX_CONSTRUCTS - 1))
    const add = await screen.findByRole('button', { name: 'Add construct' })
    // POSITIVE CONTROL: below the cap it adds, and the sentence is not shown.
    expect(add).toBeEnabled()
    expect(screen.queryByText(CONSTRUCT_LIMIT_TEXT)).toBeNull()
    fireEvent.click(add)
    expect(screen.getAllByRole('button', { name: /^Remove construct / })).toHaveLength(MAX_CONSTRUCTS)
    expect(add).toBeDisabled()
    expect(screen.getByText(CONSTRUCT_LIMIT_TEXT)).toBeInTheDocument()
    expect(add).toHaveAccessibleDescription(CONSTRUCT_LIMIT_TEXT)
    fireEvent.click(screen.getByRole('button', { name: 'Remove construct C1' }))
    expect(add).toBeEnabled()
    expect(add).not.toHaveAccessibleDescription()
    expect(screen.queryByText(CONSTRUCT_LIMIT_TEXT)).toBeNull()
  }, 20_000)  // 100 rows mount in ~2–3 s alone; under the full suite's load the default 5 s is #1040's flake

  it('follow-up: at the 4-strand cap, each of the four Add … strand buttons is described by the sentence', async () => {
    const strands = (n: number) => readDisplay({
      title: 'T', group_by_column_id: 11,
      strands: [{ key: 'a', kind: 'codes', label: 'A' }, { key: 'b', kind: 'codes', label: 'B' },
        { key: 'c', kind: 'variables', label: 'C' }, { key: 'd', kind: 'observation_codes', label: 'D' }].slice(0, n),
      rows: [{ key: 'r1', construct: 'Planning', bindings: { a: { code_ids: [31] } } }],
    })
    expect(STRAND_KIND_TERMS).toHaveLength(4)
    mount(strands(MAX_STRANDS_IN_BUILDER))
    await screen.findByLabelText('Strand 4 name')
    expect(screen.getByText(STRAND_LIMIT_TEXT)).toBeInTheDocument()
    for (const k of STRAND_KIND_TERMS) {
      const add = screen.getByRole('button', { name: k.add })
      expect(add).toBeDisabled()
      expect(add).toHaveAccessibleDescription(STRAND_LIMIT_TEXT)
    }
    // POSITIVE CONTROL: below the cap each is enabled, not described by the limit (its title, the
    // kind's definition, describes it as before), and the sentence is not shown.
    cleanup()
    mount(strands(MAX_STRANDS_IN_BUILDER - 1))
    await screen.findByLabelText('Strand 3 name')
    expect(screen.queryByText(STRAND_LIMIT_TEXT)).toBeNull()
    for (const k of STRAND_KIND_TERMS) {
      const add = screen.getByRole('button', { name: k.add })
      expect(add).toBeEnabled()
      expect(add).toHaveAccessibleDescription(k.definition)
    }
  })

  it('the build (2026-11-15d): the press that reaches a cap lands focus on the new construct’s name — below it, focus stays', async () => {
    // Driven: the 100th press disabled *Add construct* under the keyboard and Chrome put focus on <body>.
    mount(withRows(MAX_CONSTRUCTS - 2))
    const add = await screen.findByRole('button', { name: 'Add construct' })
    add.focus()
    fireEvent.click(add)  // the 99th: below the cap — CONTROL, nothing moves
    await frame(); await frame()
    expect(add).toHaveFocus()
    fireEvent.click(add)  // the 100th: the cap
    await waitFor(() => expect(screen.getByLabelText(`Construct ${MAX_CONSTRUCTS} name`)).toHaveFocus())
    expect(add).toBeDisabled()
  }, 20_000)

  it('the build: the 4th strand’s press lands focus on the new strand’s name — below the cap, focus stays', async () => {
    mount(strandsDisplay(MAX_STRANDS_IN_BUILDER - 2))
    const code = await screen.findByRole('button', { name: STRAND_KIND_TERMS[0].add })
    code.focus()
    fireEvent.click(code)  // the 3rd: below the cap — CONTROL
    await frame(); await frame()
    expect(code).toHaveFocus()
    fireEvent.click(code)  // the 4th: every Add button disables
    await waitFor(() => expect(screen.getByLabelText(`Strand ${MAX_STRANDS_IN_BUILDER} name`)).toHaveFocus())
  })

  it('r3-1: a strand’s chosen sources have no client cap — 501 chosen, the 502nd still offered', async () => {
    // 502 sources, not D12's 900: 900 rows render too slowly for jsdom's 5 s under load (#1040).
    const many = Array.from({ length: 502 }, (_, i) => ({ id: 1000 + i, name: `Interview ${i + 1}` }))
    conversations.mockResolvedValue({ total: 502, conversations: many })
    mount(readDisplay({
      title: 'T', group_by_column_id: 11, conversation_ids: many.slice(0, 501).map(c => c.id),
      rows: [{ key: 'r1', construct: 'Planning', code_ids: [31] }],
    }))
    fireEvent.click(await screen.findByRole('button', { name: /^Conversations for the display: 501 chosen/ }))
    expect(await screen.findByLabelText('Interview 502')).toBeEnabled()
    expect(screen.queryByText(/holds up to/)).toBeNull()
  })
})
