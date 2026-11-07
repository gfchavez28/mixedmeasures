/**
 * #1470 (D69–D71) — a copy that records a withdrawal of someone THIS project still holds.
 *
 * The merge is refused until the person is withdrawn here. The page says so from the
 * PREVIEW (`merge_additions.withdrawn_here`), before any coder or code decision is asked
 * for, and the merge's own 409 (`kind: 'withdrawal'`) opens the same screen for a caller
 * that reached the merge anyway. Each person is named by this project's own ID.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route } from 'react-router'
import type { ImportValidationResult } from '@/lib/api'
import type { MergeAdditions } from '@/lib/api/project-portability'
import { ApiError } from '@/lib/api/client'
import { setPendingMerge } from '@/lib/pending-merge'

const api = vi.hoisted(() => ({ validate: vi.fn(), importProject: vi.fn(), codes: vi.fn() }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    projectPortabilityApi: { validateImport: api.validate, importProject: api.importProject },
    codesApi: { ...actual.codesApi, list: (...a: unknown[]) => api.codes(...a) },
  }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useCoders', () => ({ resetCoderRoster: vi.fn(() => Promise.resolve()) }))
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 7, project: { id: 7, name: 'Study' } }),
}))

import MergeProject from './MergeProject'

afterEach(() => {
  cleanup()
  Object.values(api).forEach(f => f.mockReset())
})

const NONE: MergeAdditions = {
  sources: [], source_count: 0, participants: [], participant_count: 0,
  datasets: [], dataset_count: 0, records: [], record_count: 0,
  quotes: 0, notes: 0, memos: 0, withdrawn_participants: 0, withdrawn_items: 0,
  withdrawn_here: [],
}

const HEADING = "Can't merge yet — this copy records a withdrawal"

function open(additions: MergeAdditions) {
  api.codes.mockResolvedValue({ codes: [] })
  const validation = {
    manifest: { project_name: 'Study', app_version: '1.5.9', project_summary: null },
    existing_project: { id: 7, name: 'Study' },
    warnings: [], merge_coders: [], merge_codes_preview: [], merge_additions: additions,
  } as unknown as ImportValidationResult
  setPendingMerge(new File(['x'], 'study.mmproject'), validation, 7)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/7/merge']}>
        <Routes>
          <Route path="/projects/:projectId/merge" element={<MergeProject />} />
          <Route path="/projects/:projectId/participants" element={<h1>Participants page</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function expectTheRefusal(ids: string[], railAt: string) {
  const list = screen.getByRole('list', { name: 'Participants to withdraw in this project' })
  expect(within(list).getAllByRole('listitem').map(li => li.textContent)).toEqual(ids)
  // The rail says where the flow stopped, and never that a step it skipped was completed.
  const rail = screen.getByRole('navigation', { name: 'Merge progress' })
  expect(within(rail).getByText(railAt).closest('[aria-current="step"]')).not.toBeNull()
  expect(screen.getByText(/this project still holds their data/)).toBeInTheDocument()
  const link = screen.getByRole('link', { name: 'Participants page' })
  expect(link).toHaveAttribute('href', '/projects/7/participants')
  expect(screen.getByText(/Withdraw them in this project first/)).toBeInTheDocument()
  // No way on to a merge from here — only back.
  expect(screen.queryByRole('button', { name: 'Continue to review' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Merge into my project/ })).toBeNull()
  expect(screen.getByRole('button', { name: /Back to project/ })).toBeInTheDocument()
}

describe('#1470 — the Merge page refuses a copy that withdrew someone held here', () => {
  it('from the PREVIEW: the refusal screen opens before any decision is asked for', async () => {
    open({ ...NONE, withdrawn_here: [
      { participant_id: 11, identifier: 'M01' }, { participant_id: 12, identifier: 'P07' },
    ] })
    expect(await screen.findByRole('heading', { name: HEADING })).toBeInTheDocument()
    expectTheRefusal(['M01', 'P07'], 'Confirm coders')
    expect(screen.getByText(/records that 2 participants withdrew/)).toBeInTheDocument()
    expect(api.importProject).not.toHaveBeenCalled()
  })

  it('the link goes where the remedy is', async () => {
    open({ ...NONE, withdrawn_here: [{ participant_id: 11, identifier: 'M01' }] })
    expect(await screen.findByText(/records that 1 participant withdrew/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Participants page' }))
    expect(await screen.findByRole('heading', { name: 'Participants page' })).toBeInTheDocument()
  })

  it("from the merge's own 409: the same screen", async () => {
    api.importProject.mockRejectedValue(new ApiError(409, {
      detail: {
        error: 'merge_divergence', kind: 'withdrawal',
        withdrawn_here: [{ participant_id: 11, identifier: 'M01' }],
      },
    }, {}))
    open(NONE)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to review' }))
    fireEvent.click(await screen.findByRole('button', { name: /Merge into my project/ }))
    expect(await screen.findByRole('heading', { name: HEADING })).toBeInTheDocument()
    expectTheRefusal(['M01'], 'Review')
  })

  it('CONTROL: an empty list goes to the ordinary confirm step', async () => {
    open(NONE)
    expect(await screen.findByRole('button', { name: 'Continue to review' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: HEADING })).toBeNull()
  })
})
