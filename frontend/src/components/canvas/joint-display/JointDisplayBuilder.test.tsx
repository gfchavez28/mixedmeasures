/**
 * The joint display's builder (session B): what it offers and what it hands back. The groups
 * are ONE categorical column (D166); a construct's survey variables come from ONE dataset
 * (D205); nothing can be inserted without a grouping variable and a named construct.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
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
  ] }) },
  codesApi: { list: vi.fn().mockResolvedValue({ total: 2, codes: [
    { id: 31, name: 'Planning time', is_active: true, is_universal: false },
    { id: 32, name: 'Unclear', is_active: true, is_universal: true },
  ] }) },
  conversationsApi: { list: vi.fn().mockResolvedValue({ total: 1, conversations: [{ id: 5, name: 'Focus group 1' }] }) },
  documentsApi: { list: vi.fn().mockResolvedValue([]) },
  materialsApi: { listAllMaterials: vi.fn().mockResolvedValue([]) },
}))

// #1615 D279 — the viewer's scope (the hook needs an AuthProvider; the tests set it directly).
const EVERY_CODER = { coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }
const scope: { value: { coderIds: number[] | null; coderScope: string | undefined; scopeKey: string; scopeReady: boolean } } = { value: EVERY_CODER }
vi.mock('@/hooks/useAnalysisScope', () => ({ useAnalysisScope: () => scope.value }))

import { materialsApi, metricsApi } from '@/lib/api'
import JointDisplayBuilder from './JointDisplayBuilder'

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

describe('the builder', () => {
  it('groups by a CATEGORICAL column only, and inserts nothing without one and a named construct', async () => {
    const onSubmit = mount()
    const grouping = await screen.findByLabelText('Variable that forms the groups')
    const options = within(grouping).getAllByRole('option').map(o => o.textContent)
    expect(options).toContain('Gain group (nominal)')
    expect(options).toContain('Confidence (ordinal)')
    expect(options.some(o => o?.startsWith('Training hours'))).toBe(false)   // numeric: band it first
    const insert = screen.getByRole('button', { name: 'Insert joint display' })
    expect(insert).toBeDisabled()
    fireEvent.change(grouping, { target: { value: '11' } })
    expect(insert).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Construct 1 name'), { target: { value: 'Training dosage' } })
    expect(insert).toBeEnabled()
    fireEvent.click(insert)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const display = onSubmit.mock.calls[0][0]
    expect(display.group_by_column_id).toBe(11)
    expect(display.rows).toHaveLength(1)
    expect(display.rows[0].construct).toBe('Training dosage')
    expect(display.attribution.label).toBe('participant')
    expect(display.strands[0].conversation_ids).toBeNull()   // every conversation, the default (slice 2: the codes strand's)
  })

  it('offers no universal code, and a new survey dataset starts the strand over (D205)', async () => {
    const onSubmit = mount()
    await screen.findByLabelText('Variable that forms the groups')
    fireEvent.click(screen.getByRole('button', { name: /^Codes for construct 1/ }))
    expect(await screen.findByLabelText('Planning time')).toBeInTheDocument()
    expect(screen.queryByLabelText('Unclear')).toBeNull()
    const dataset = screen.getByLabelText('Survey dataset for construct 1')
    expect(within(dataset).getAllByRole('option').map(o => o.textContent)).toEqual(['No survey', 'Roster', 'Survey'])
    void onSubmit
  })

  it('drops an unnamed construct from what it hands back', async () => {
    const onSubmit = mount()
    fireEvent.change(await screen.findByLabelText('Variable that forms the groups'), { target: { value: '11' } })
    fireEvent.change(screen.getByLabelText('Construct 1 name'), { target: { value: 'Named' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add construct' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert joint display' }))
    expect(onSubmit.mock.calls[0][0].rows.map((r: { construct: string }) => r.construct)).toEqual(['Named'])
  })

  it('D165: offers saved quantitative results with the unit each counts, and marks one as the source of the groups', async () => {
    vi.mocked(materialsApi.listAllMaterials).mockResolvedValueOnce([
      { id: 90, collection_id: 1, material_type: 'chart', auto_name: 'Comparison', custom_name: 'Hours by gain',
        display_order: 0, source_tab: 'relationships', created_at: '', has_missing_refs: false, missing_refs: [],
        config: { rc_view: 'comparisons', column_ids: [12], compare_by: 11 } },
      { id: 91, collection_id: 1, material_type: 'chart', auto_name: 'Frequencies', custom_name: null,
        display_order: 1, source_tab: 'descriptives', created_at: '', has_missing_refs: false, missing_refs: [],
        config: { code_mode: 'codes', code_ids: [31] } },   // qualitative: not offered in slice 1
    ] as never)
    const onSubmit = mount()
    fireEvent.change(await screen.findByLabelText('Variable that forms the groups'), { target: { value: '11' } })
    fireEvent.change(screen.getByLabelText('Construct 1 name'), { target: { value: 'Training' } })
    expect(screen.queryByRole('checkbox', { name: /^The result at another unit formed the groups/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Results at another unit for Training/ }))
    expect(await screen.findByLabelText('Hours by gain (rows of Roster, by Gain group)')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Frequencies/)).toBeNull()
    fireEvent.click(screen.getByLabelText('Hours by gain (rows of Roster, by Gain group)'))
    // #1712 (a), D388: slice 1's three boxes name the construct too, their visible words first.
    expect(screen.getByRole('checkbox', { name: 'The survey strand formed the groups for Training' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'The coded strand formed the groups for Training' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'The result at another unit formed the groups for Training' }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert joint display' }))
    expect(onSubmit.mock.calls[0][0].rows[0]).toMatchObject({ result_material_ids: [90], results_marked_formed: true })
  })
})

// #1638 — the payload's real shape: a DEMOGRAPHIC column is listed only under `demographics`
// (`get_analysis_columns` skips it in `datasets`), a NOMINAL one in both lists; Contacts has
// demographic columns only, so it is absent from `datasets`.
const WITH_DEMOGRAPHICS = { domains: [], datasets: [
  { id: 1, name: 'Roster', columns: [
    { id: 11, dataset_id: 1, dataset_name: 'Roster', column_code: null, column_name: 'Gain group', column_text: 'Gain group', column_type: 'nominal', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
    { id: 12, dataset_id: 1, dataset_name: 'Roster', column_code: null, column_name: 'Training hours', column_text: 'Training hours', column_type: 'numeric', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
  ] },
], demographics: [
  { id: 11, column_name: 'Gain group', column_text: 'Gain group', dataset_id: 1, dataset_name: 'Roster', subtype: null },
  { id: 14, column_name: 'Site', column_text: 'Site', dataset_id: 1, dataset_name: 'Roster', subtype: 'location' },
  { id: 15, column_name: 'Score band', column_text: 'Score band', dataset_id: 1, dataset_name: 'Roster', subtype: null },
  { id: 31, column_name: 'Region', column_text: 'Region', dataset_id: 3, dataset_name: 'Contacts', subtype: null },
] }
// The same list asked in a blind viewer's scope: the band (a demographic retype of a score band) is marked.
const WITH_DEMOGRAPHICS_BLIND = { ...WITH_DEMOGRAPHICS, demographics: WITH_DEMOGRAPHICS.demographics.map(
  d => (d.id === 15 ? { ...d, withheld_while_blind: true } : d)) }

describe('#1638 — a demographic variable is offered wherever a categorical one is', () => {
  it('in the groups menu and *Also show*, and inserts a display grouped by it', async () => {
    vi.mocked(metricsApi.analysisColumns).mockResolvedValueOnce(WITH_DEMOGRAPHICS as never)
    const onSubmit = mount()
    const grouping = await screen.findByLabelText('Variable that forms the groups')
    const options = within(grouping).getAllByRole('option').map(o => o.textContent)
    expect(options).toEqual(['Choose a variable…', 'Gain group (nominal)', 'Site (demographic)', 'Score band (demographic)', 'Region (demographic)'])
    const alsoShow = screen.getByLabelText('Also show a participant variable beside each quote')
    expect(within(alsoShow).getByRole('option', { name: 'Site' })).toBeEnabled()
    fireEvent.change(grouping, { target: { value: '14' } })
    expect(screen.getByText('Groups are the values of Site in Roster.', { exact: false })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Construct 1 name'), { target: { value: 'Workload' } })
    fireEvent.click(screen.getByRole('button', { name: 'Insert joint display' }))
    expect(onSubmit.mock.calls[0][0].group_by_column_id).toBe(14)
  })

  it('a display grouped by one reopens with it chosen, never on "Choose a variable…"', async () => {
    vi.mocked(metricsApi.analysisColumns).mockResolvedValueOnce(WITH_DEMOGRAPHICS as never)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <JointDisplayBuilder open onOpenChange={() => {}} projectId={1} mode="edit" onSubmit={vi.fn()}
          initial={{ title: 'T', group_by_column_id: 14, conversation_ids: null, document_ids: null,
            attribution: { label: 'participant', column_id: 31 },
            settings: { fit_vocabulary: 'fetters', implication: false, newcombe: false },
            rows: [] } as never} />
      </QueryClientProvider>,
    )
    const grouping = await screen.findByLabelText('Variable that forms the groups') as HTMLSelectElement
    expect(grouping.selectedOptions[0].textContent).toBe('Site (demographic)')
    const alsoShow = screen.getByLabelText('Also show a participant variable beside each quote') as HTMLSelectElement
    expect(alsoShow.selectedOptions[0].textContent).toBe('Region')
  })

  it('a survey variable too, under its own dataset — one with demographic columns only included', async () => {
    vi.mocked(metricsApi.analysisColumns).mockResolvedValueOnce(WITH_DEMOGRAPHICS as never)
    mount()
    await screen.findByLabelText('Variable that forms the groups')
    const dataset = screen.getByLabelText('Survey dataset for construct 1')
    expect(within(dataset).getAllByRole('option').map(o => o.textContent)).toEqual(['No survey', 'Roster', 'Contacts'])
    fireEvent.change(dataset, { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /^Survey variables for construct 1/ }))
    expect(await screen.findByLabelText('Site')).toBeInTheDocument()
    expect(screen.getByLabelText('Training hours')).toBeInTheDocument()
  })

  it('while blind, a demographic score band takes D279’s marks like any other', async () => {
    scope.value = { coderIds: [7], coderScope: '7', scopeKey: '7', scopeReady: true }
    vi.mocked(metricsApi.analysisColumns).mockResolvedValueOnce(WITH_DEMOGRAPHICS_BLIND as never)
    mount()
    const grouping = await screen.findByLabelText('Variable that forms the groups')
    expect(within(grouping).getByRole('option', { name: 'Score band (demographic) — a rating score, hidden while blind' })).toBeDisabled()
    expect(within(grouping).getByRole('option', { name: 'Site (demographic)' })).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Survey dataset for construct 1'), { target: { value: '1' } })
    expect(screen.getByTestId('builder-withheld-rating-scores')).toHaveTextContent(/^1 rating column is hidden while blind/)
  })
})

// A participant table whose score band (13) and score (22) are marked for a blind viewer.
const MARKED = { domains: [], demographics: [], datasets: [
  { id: 1, name: 'Roster', columns: [
    { id: 11, dataset_id: 1, dataset_name: 'Roster', column_code: null, column_name: 'Gain group', column_text: 'Gain group', column_type: 'nominal', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
    { id: 13, dataset_id: 1, dataset_name: 'Roster', column_code: null, column_name: 'Score band', column_text: 'Score band', column_type: 'ordinal', scale_labels: null, equivalence_group_id: null, domain_ids: [], withheld_while_blind: true },
    { id: 21, dataset_id: 1, dataset_name: 'Roster', column_code: null, column_name: 'Confidence', column_text: 'Confidence', column_type: 'ordinal', scale_labels: null, equivalence_group_id: null, domain_ids: [] },
    { id: 22, dataset_id: 1, dataset_name: 'Roster', column_code: null, column_name: 'Rating score', column_text: 'Rating score', column_type: 'numeric', scale_labels: null, equivalence_group_id: null, domain_ids: [], withheld_while_blind: true },
  ] },
] }

describe('#1615 D279 — while blind, the builder reads the viewer’s list', () => {
  const BLIND = { coderIds: [7], coderScope: '7', scopeKey: '7', scopeReady: true }

  it('asks for the list in the viewer’s scope, and not at all before the scope is ready', async () => {
    scope.value = { ...BLIND, scopeReady: false }
    mount()
    expect(await screen.findByText('Loading variables, codes and sources…')).toBeInTheDocument()
    expect(metricsApi.analysisColumns).not.toHaveBeenCalled()
    cleanup()
    scope.value = BLIND
    mount()
    await screen.findByLabelText('Variable that forms the groups')
    expect(metricsApi.analysisColumns).toHaveBeenCalledWith(1, '7')
  })

  it('keeps a score band in the two menus, DISABLED with the reason, and offers the others', async () => {
    scope.value = BLIND
    vi.mocked(metricsApi.analysisColumns).mockResolvedValueOnce(MARKED as never)
    mount()
    const grouping = await screen.findByLabelText('Variable that forms the groups')
    const band = within(grouping).getByRole('option', { name: 'Score band (ordinal) — a rating score, hidden while blind' })
    expect(band).toBeDisabled()
    expect(within(grouping).getByRole('option', { name: 'Gain group (nominal)' })).toBeEnabled()
    const alsoShow = screen.getByLabelText('Also show a participant variable beside each quote')
    expect(within(alsoShow).getByRole('option', { name: 'Score band — a rating score, hidden while blind' })).toBeDisabled()
    expect(within(alsoShow).getByRole('option', { name: 'Gain group' })).toBeEnabled()
  })

  it('a choice made before going blind keeps its name in the menu', async () => {
    scope.value = BLIND
    vi.mocked(metricsApi.analysisColumns).mockResolvedValueOnce(MARKED as never)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <JointDisplayBuilder open onOpenChange={() => {}} projectId={1} mode="edit" onSubmit={vi.fn()}
          initial={{ title: 'T', group_by_column_id: 13, conversation_ids: null, document_ids: null,
            attribution: { label: 'participant', column_id: null },
            settings: { fit_vocabulary: 'fetters', implication: false, newcombe: false },
            rows: [] } as never} />
      </QueryClientProvider>,
    )
    const grouping = await screen.findByLabelText('Variable that forms the groups') as HTMLSelectElement
    expect(grouping.value).toBe('13')
    expect(grouping.selectedOptions[0].textContent).toBe('Score band (ordinal) — a rating score, hidden while blind')
  })

  it('the survey variables HIDE a score and say how many, in the Data view’s words', async () => {
    scope.value = BLIND
    vi.mocked(metricsApi.analysisColumns).mockResolvedValueOnce(MARKED as never)
    mount()
    await screen.findByLabelText('Variable that forms the groups')
    fireEvent.change(screen.getByLabelText('Survey dataset for construct 1'), { target: { value: '1' } })
    expect(screen.getByTestId('builder-withheld-rating-scores')).toHaveTextContent(
      "2 rating columns are hidden while blind. A participant score combines every coder's ratings, so it would show your colleagues' judgements.")
    fireEvent.click(screen.getByRole('button', { name: /^Survey variables for construct 1/ }))
    expect(await screen.findByLabelText('Confidence')).toBeInTheDocument()
    expect(screen.queryByLabelText('Rating score')).toBeNull()
    expect(screen.queryByLabelText('Score band')).toBeNull()
  })

  it('not blind: nothing is marked, nothing is hidden, and no sentence', async () => {
    mount()
    await screen.findByLabelText('Variable that forms the groups')
    expect(metricsApi.analysisColumns).toHaveBeenCalledWith(1, undefined)
    fireEvent.change(screen.getByLabelText('Survey dataset for construct 1'), { target: { value: '2' } })
    expect(screen.queryByTestId('builder-withheld-rating-scores')).toBeNull()
  })
})
