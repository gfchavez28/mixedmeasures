/**
 * Joint display slice 2 (r2-1, r2-4): the builder's strands — add one of three kinds, name it,
 * order it, remove it; a slice-1 display becomes explicit on the first strand edit, its pair's
 * keys kept; at most `MAX_STRANDS_IN_BUILDER`, at least two, each named. Mocks as `JointDisplayBuilder.test.tsx`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'

vi.mock('@/lib/api', () => ({
  metricsApi: { analysisColumns: vi.fn().mockResolvedValue({ domains: [], demographics: [], datasets: [
    { id: 1, name: 'Roster', columns: [
      { id: 11, dataset_id: 1, dataset_name: 'Roster', column_code: null, column_name: 'Gain group', column_text: 'Gain group', column_type: 'nominal', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
      { id: 12, dataset_id: 1, dataset_name: 'Roster', column_code: null, column_name: 'Training hours', column_text: 'Training hours', column_type: 'numeric', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
    ] },
    { id: 2, name: 'Survey', columns: [
      { id: 21, dataset_id: 2, dataset_name: 'Survey', column_code: null, column_name: 'Confidence', column_text: 'Confidence', column_type: 'ordinal', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
    ] },
    // #1712 (c): a dataset with no variable a survey strand can show (only an identifier).
    { id: 3, name: 'Exit register', columns: [
      { id: 41, dataset_id: 3, dataset_name: 'Exit register', column_code: null, column_name: 'Staff ID', column_text: 'Staff ID', column_type: 'identifier', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
    ] },
  ] }) },
  codesApi: { list: vi.fn().mockResolvedValue({ total: 2, codes: [
    { id: 31, name: 'Planning time', is_active: true, is_universal: false },
    { id: 32, name: 'Unclear', is_active: true, is_universal: true },
  ] }) },
  conversationsApi: { list: vi.fn().mockResolvedValue({ total: 1, conversations: [{ id: 5, name: 'Focus group 1' }] }) },
  documentsApi: { list: vi.fn().mockResolvedValue([]) },
  materialsApi: { listAllMaterials: vi.fn().mockResolvedValue([]) },
  observationsApi: { list: vi.fn().mockResolvedValue([{ id: 8, name: 'Site visit 1' }]) },
}))

// #1615 D279 — the viewer's scope (the hook needs an AuthProvider; the tests set it directly).
const EVERY_CODER = { coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }
const scope: { value: { coderIds: number[] | null; coderScope: string | undefined; scopeKey: string; scopeReady: boolean } } = { value: EVERY_CODER }
vi.mock('@/hooks/useAnalysisScope', () => ({ useAnalysisScope: () => scope.value }))

import JointDisplayBuilder from './JointDisplayBuilder'
import { isImplicitPair } from '@/lib/joint-display-strands'

function mount(onSubmit = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <JointDisplayBuilder open onOpenChange={() => {}} projectId={1} initial={null} mode="insert" onSubmit={onSubmit} />
    </QueryClientProvider>,
  )
  return onSubmit
}

afterEach(() => { cleanup(); vi.clearAllMocks(); scope.value = EVERY_CODER })

const names = () => screen.getAllByLabelText(/^Strand \d+ name$/).map(i => (i as HTMLInputElement).value)

describe('joint display slice 2 — strands in the builder', () => {
  it('the first strand edit names the pair: three strands, each to be named, and nothing inserts until they are', async () => {
    const onSubmit = mount()
    fireEvent.change(await screen.findByLabelText('Variable that forms the groups'), { target: { value: '11' } })
    fireEvent.change(screen.getByLabelText('Construct 1 name'), { target: { value: 'Planning' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add an observation strand' }))
    expect(names()).toEqual(['', '', ''])
    expect(screen.getByText('Survey variables')).toBeInTheDocument()
    const insert = screen.getByRole('button', { name: 'Insert joint display' })
    expect(insert).toBeDisabled()
    expect(screen.getByText('Name every strand.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Strand 1 name'), { target: { value: 'Baseline survey' } })
    fireEvent.change(screen.getByLabelText('Strand 2 name'), { target: { value: 'Interviews' } })
    fireEvent.change(screen.getByLabelText('Strand 3 name'), { target: { value: 'Site visits' } })
    expect(screen.getByText('Choose a dataset for every survey strand.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Dataset for Baseline survey'), { target: { value: '2' } })
    expect(insert).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /^Interviews for Planning/ }))
    fireEvent.click(await screen.findByLabelText('Planning time'))
    fireEvent.click(screen.getByLabelText('Interviews formed the groups'))
    expect(screen.queryByLabelText('Site visits formed the groups')).toBeNull()   // beside: never forms groups
    fireEvent.click(insert)
    const d = onSubmit.mock.calls[0][0]
    expect(d.strands.map((s: { key: string; kind: string; label: string }) => [s.key, s.kind, s.label]).slice(0, 2))
      .toEqual([['variables', 'variables', 'Baseline survey'], ['codes', 'codes', 'Interviews']])
    expect(d.strands[2].kind).toBe('observation_codes')
    expect(d.rows[0].bindings.codes).toEqual({ code_ids: [31], column_ids: [], marked_formed: true })
    expect('code_ids' in d.rows[0]).toBe(false)   // r1's model: bindings are the one truth
  })

  it('orders and removes strands — never below two — and adds none past four (r2-4)', async () => {
    mount()
    await screen.findByLabelText('Variable that forms the groups')
    fireEvent.click(screen.getByRole('button', { name: 'Add a code strand' }))
    fireEvent.change(screen.getByLabelText('Strand 3 name'), { target: { value: 'Focus groups' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move Focus groups up' }))
    expect(names()).toEqual(['', 'Focus groups', ''])
    fireEvent.click(screen.getByRole('button', { name: 'Add a survey strand' }))
    expect(names()).toHaveLength(4)
    for (const add of ['Add a code strand', 'Add a survey strand', 'Add an observation strand']) {
      expect(screen.getByRole('button', { name: add })).toBeDisabled()
    }
    expect(screen.getByText('A display holds up to 4 strands.')).toBeInTheDocument()
    // #1647 (D339): an unnamed strand is "Strand N", and no control repeats the word.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Focus groups' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Strand 3' }))
    expect(names()).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Remove Strand 1' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /strand strand|Strand Strand/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a code strand' })).toBeEnabled()
  })

  it('POSITIVE CONTROL: a slice-1 build inserts only the implicit pair (r1-2: slice 2’s shape, unnamed)', async () => {
    const onSubmit = mount()
    fireEvent.change(await screen.findByLabelText('Variable that forms the groups'), { target: { value: '11' } })
    fireEvent.change(screen.getByLabelText('Construct 1 name'), { target: { value: 'Planning' } })
    fireEvent.click(screen.getByRole('button', { name: 'Insert joint display' }))
    const d = onSubmit.mock.calls[0][0]
    expect(d.strands.map((s: { key: string; label: string; dataset_id: number | null }) => [s.key, s.label, s.dataset_id]))
      .toEqual([['codes', '', null], ['variables', '', null]])
    expect(isImplicitPair(d)).toBe(true)
  })
})

/**
 * #1712 (a)–(c), D388–D390 — the builder's names and empty lists. With two constructs the tree had
 * two of every "<strand> formed the groups", a code strand's filter read *"Filter survey
 * comments"* over a list of CODES, and a survey strand with no dataset opened to *"Nothing
 * matches."*. (d) is decided not to do (D391): the display answers an unlinked grouping itself.
 */
describe('#1712 — the builder names what each control is for', () => {
  async function explicitDisplay() {
    mount()
    fireEvent.change(await screen.findByLabelText('Variable that forms the groups'), { target: { value: '11' } })
    fireEvent.change(screen.getByLabelText('Construct 1 name'), { target: { value: 'Planning' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add construct' }))
    fireEvent.change(screen.getByLabelText('Construct 2 name'), { target: { value: 'Support' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add an observation strand' }))
    fireEvent.change(screen.getByLabelText('Strand 1 name'), { target: { value: 'Baseline survey' } })
    fireEvent.change(screen.getByLabelText('Strand 2 name'), { target: { value: 'Interviews' } })
    fireEvent.change(screen.getByLabelText('Strand 3 name'), { target: { value: 'Site visits' } })
  }

  it('D388: each "formed the groups" box names its construct, its visible words first', async () => {
    await explicitDisplay()
    for (const construct of ['Planning', 'Support']) {
      for (const strand of ['Baseline survey', 'Interviews']) {
        const box = screen.getByRole('checkbox', { name: `${strand} formed the groups for ${construct}` })
        expect(box.closest('label')).toHaveTextContent(`${strand} formed the groups`)   // the visible words
      }
    }
    // No two "formed the groups" boxes share a name (two constructs gave two of each).
    const boxNames = screen.getAllByRole('checkbox', { name: /formed the groups/ }).map(b => b.getAttribute('aria-label'))
    expect(boxNames).toHaveLength(4)
    expect(new Set(boxNames).size).toBe(4)
  })

  it('D389: a code strand’s filter and list are named for the CODES they list; the trigger keeps the strand', async () => {
    await explicitDisplay()
    fireEvent.click(screen.getByRole('button', { name: /^Interviews for Planning/ }))
    expect(await screen.findByRole('dialog', { name: 'Interviews for Planning' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Filter codes' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Codes' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Filter interviews' })).toBeNull()
  })

  it('D390: a survey strand with no dataset says to choose one; one with nothing to show says so; a filter still says "Nothing matches."', async () => {
    await explicitDisplay()
    fireEvent.click(screen.getByRole('button', { name: /^Baseline survey for Planning/ }))
    expect(await screen.findByRole('textbox', { name: 'Filter variables' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Variables' })).toHaveTextContent('Choose this strand’s dataset first.')
    expect(screen.queryByText('Nothing matches.')).toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    cleanup()

    await explicitDisplay()
    fireEvent.change(screen.getByLabelText('Dataset for Baseline survey'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /^Baseline survey for Planning/ }))
    expect(await screen.findByRole('list', { name: 'Variables' })).toHaveTextContent('This dataset has no variable this strand can show.')
    cleanup()

    // CONTROL: a list the FILTER emptied keeps "Nothing matches."
    await explicitDisplay()
    fireEvent.click(screen.getByRole('button', { name: /^Interviews for Planning/ }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Filter codes' }), { target: { value: 'zzz' } })
    expect(screen.getByRole('list', { name: 'Codes' })).toHaveTextContent('Nothing matches.')
  })
})
