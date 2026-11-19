/**
 * #1671 D350, mounted — *Compare groups by* on a display holding work under its current groups
 * asks first (#1665's dataset-change shape): a warning naming what it holds, *Keep “<variable>”*
 * (focused) or *Group by “<target>”* (#1703 a, D371 — it was *Change the grouping*, naming no target).
 * Nothing is cleared either way. Since #1688 (D370) the warning names the GROUPS its holds sit under.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'

const col = vi.hoisted(() => (id: number, name: string) => ({ id, dataset_id: 1, dataset_name: 'Roster', column_code: null,
  column_name: name, column_text: name, column_type: 'nominal', scale_labels: null, equivalence_group_id: null, domain_ids: [] }))
vi.mock('@/lib/api', () => ({
  metricsApi: { analysisColumns: vi.fn().mockResolvedValue({ domains: [], demographics: [], datasets: [
    { id: 1, name: 'Roster', columns: [col(11, 'Gain group'), col(12, 'Region'), col(13, 'Pay band')] },
  ] }) },
  codesApi: { list: vi.fn().mockResolvedValue({ total: 1, codes: [{ id: 31, name: 'Planning time', is_active: true, is_universal: false }] }) },
  conversationsApi: { list: vi.fn().mockResolvedValue({ total: 0, conversations: [] }) },
  documentsApi: { list: vi.fn().mockResolvedValue([]) },
  materialsApi: { listAllMaterials: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/hooks/useAnalysisScope', () => ({
  useAnalysisScope: () => ({ coderIds: null, coderScope: undefined, scopeKey: 'every-coder', scopeReady: true }),
}))

import JointDisplayBuilder from './JointDisplayBuilder'
import { readDisplay } from '@/lib/joint-display'

function mountEdit(initial: unknown) {
  const onSubmit = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}>
    <JointDisplayBuilder open onOpenChange={() => {}} projectId={1} initial={readDisplay(initial)} mode="edit" onSubmit={onSubmit} />
  </QueryClientProvider>)
  return onSubmit
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

const pin = { excerptId: 501, displayText: 'Words', sourceContext: '', conversationId: 5, observationId: null, group: 'High', role: 'typical', purpose: '' }
const held = { title: 'T', group_by_column_id: 11, rows: [{ key: 'r1', construct: 'Planning', code_ids: [31], pins: [pin] }] }

async function regroup() {
  const select = await screen.findByLabelText('Variable that forms the groups') as HTMLSelectElement
  await within(select).findByRole('option', { name: /Region/ })
  fireEvent.change(select, { target: { value: '12' } })
  return select
}

describe('#1671 D350 — a regroup asks first', () => {
  it('a display with a pin: the warning, Keep focused — and Keep changes nothing', async () => {
    const onSubmit = mountEdit(held)
    const select = await regroup()
    expect(select.value).toBe('11')   // not yet changed
    const keep = screen.getByRole('button', { name: 'Keep “Gain group”' })
    expect(keep).toHaveFocus()
    expect(keep).toHaveAccessibleDescription(/This display holds 1 pinned quote, under the group “High”/)
    fireEvent.click(keep)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(onSubmit.mock.calls[0][0].group_by_column_id).toBe(11)
  })

  it('Group by “<target>” regroups and keeps the pin', async () => {
    const onSubmit = mountEdit(held)
    await regroup()
    fireEvent.click(screen.getByRole('button', { name: 'Group by “Region”' }))   // #1703 (a): names its target
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const saved = onSubmit.mock.calls[0][0]
    expect(saved.group_by_column_id).toBe(12)
    expect(saved.rows[0].pins).toHaveLength(1)   // nothing cleared (D350)
  })

  it('CONTROL: a display holding nothing under its groups changes without asking', async () => {
    mountEdit({ ...held, rows: [{ key: 'r1', construct: 'Planning', code_ids: [31] }] })
    const select = await regroup()
    expect(select.value).toBe('12')
    expect(screen.queryByRole('button', { name: /^Group by / })).not.toBeInTheDocument()
  })
})

/**
 * #1688 (D370) — the filed case: pins made under one grouping, the display then SAVED grouped by
 * another (D350 kept them). The ask named the CURRENT variable as the one the pins were chosen
 * under ("…chosen under the groups of “Pay band”. … grouping by “Pay band” again brings them
 * back"), and a second change in one edit named a value never saved. It names the groups now.
 */
describe('#1688 (D370) — the ask after a kept regroup names the groups, never a guessed variable', () => {
  // A pin under "High" — a Gain group value — on a display saved grouped by Pay band.
  const keptRegroup = { ...held, group_by_column_id: 13 }

  it('names the group the pin sits under, and no variable as the one it was chosen under', async () => {
    mountEdit(keptRegroup)
    await regroup()   // → Region
    const keep = screen.getByRole('button', { name: 'Keep “Pay band”' })   // Keep keeps the select's value
    expect(keep).toHaveAccessibleDescription(
      'This display holds 1 pinned quote, under the group “High”. Nothing is cleared: a grouping with that group brings it back.')
    expect(screen.getByRole('button', { name: 'Group by “Region”' })).toBeInTheDocument()
  })

  it('a second change in one edit names the groups again — never the unsaved value it leaves', async () => {
    mountEdit(keptRegroup)
    const select = await regroup()   // Pay band → Region, confirmed
    fireEvent.click(screen.getByRole('button', { name: 'Group by “Region”' }))
    fireEvent.change(select, { target: { value: '11' } })   // Region → Gain group, in the same edit
    const keep = screen.getByRole('button', { name: 'Keep “Region”' })
    expect(keep).toHaveAccessibleDescription(/under the group “High”/)
    expect(keep).not.toHaveAccessibleDescription(/Region/)
    expect(screen.getByRole('button', { name: 'Group by “Gain group”' })).toBeInTheDocument()
  })

  it('#1705 (a) (D386): once its lists answer, the builder lands on the title — not on Close', async () => {
    mountEdit(held)
    const title = await screen.findByRole('textbox', { name: 'Display title' })
    await waitFor(() => expect(title).toHaveFocus())
  })

  it('choosing no variable reads Remove the grouping', async () => {
    mountEdit(held)
    const select = await screen.findByLabelText('Variable that forms the groups') as HTMLSelectElement
    await within(select).findByRole('option', { name: /Region/ })
    fireEvent.change(select, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Remove the grouping' })).toBeInTheDocument()
  })
})
