/**
 * #1190 — the Merge page, end to end through the handoff: what the Review step says the
 * merge will ALSO add (D15, `merge_additions`), and what the Report step says it left
 * out for a withdrawn person and re-inserted without a link (D13).
 *
 * The pure rules are pinned in `lib/merge-report-rows.test.ts` and
 * `lib/merge-additions.test.ts`; this file proves the two steps READ them — a field
 * declared on the wire and rendered by no step is #855's half-landed class.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route } from 'react-router'
import type { ImportValidationResult, MergeReport } from '@/lib/api'
import type { MergeAdditions } from '@/lib/api/project-portability'
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

const REPORT: MergeReport = {
  sources_matched: 2, applications_added: 5, duplicates_skipped: 0,
  coders_created: 0, coders_matched: 1, codes_collapsed: 0, codes_linked: 0, codes_created: 0,
}

async function openReview(additions: MergeAdditions | null | undefined) {
  api.codes.mockResolvedValue({ codes: [] })
  const validation = {
    manifest: { project_name: 'Study', app_version: '1.5.8', project_summary: null },
    existing_project: { id: 7, name: 'Study' },
    warnings: [], merge_coders: [], merge_codes_preview: [],
    ...(additions === undefined ? {} : { merge_additions: additions }),
  } as unknown as ImportValidationResult
  setPendingMerge(new File(['x'], 'study.mmproject'), validation, 7)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/7/merge']}>
        <Routes><Route path="/projects/:projectId/merge" element={<MergeProject />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Continue to review' }))
  await screen.findByRole('button', { name: /Merge into my project/ })
}

const section = () => screen.queryByRole('region', { name: 'Also added from the file' })

describe('#1190 (D15) — the Review step says what else the merge adds', () => {
  it('names the sources and participants, counts the rest, BEFORE the merge runs', async () => {
    await openReview({
      ...NONE,
      sources: [{ kind: 'conversation', name: 'Interview 4' }], source_count: 1,
      participants: ['P08', 'P09'], participant_count: 2,
      records: [{ dataset: 'Wave 1', count: 3 }], record_count: 3,
      quotes: 2,
      withdrawn_participants: 1, withdrawn_items: 4,
    })
    const box = section()!
    expect(box).toBeInTheDocument()
    expect(within(box).getByText(/something deleted here since their copy was made/)).toBeInTheDocument()
    const items = within(box).getAllByRole('listitem').map(li => li.textContent)
    expect(items).toEqual([
      '1 source: Interview 4',
      '2 participants: P08, P09',
      '3 records in datasets this project has: Wave 1 (3)',
      '2 quotes',
    ])
    // A withdrawn person is counted as LEFT OUT — not an item in the list.
    expect(within(box).getByText(
      'The file holds 1 participant who withdrew from this project, and 4 items of theirs. The merge leaves them out.',
    )).toBeInTheDocument()
    expect(api.importProject).not.toHaveBeenCalled()
  })

  it('says plainly when the file adds nothing beyond codings', async () => {
    await openReview(NONE)
    expect(within(section()!).getByText(/The file brings no sources, participants, datasets/)).toBeInTheDocument()
    expect(within(section()!).queryByRole('list')).toBeNull()
  })

  it('a server that sent no preview: no section at all, never "nothing is added"', async () => {
    await openReview(undefined)
    expect(section()).toBeNull()
    cleanup()
    await openReview(null)
    expect(section()).toBeNull()
  })
})

describe('#1190 — the Report step', () => {
  async function merged(report: MergeReport) {
    api.importProject.mockResolvedValue({
      project_id: 7, project_name: 'Study', merge_report: report,
      safety_backup_filename: null, metrics_marked_stale: 0, tests_marked_stale: 0,
    })
    await openReview(NONE)
    fireEvent.click(screen.getByRole('button', { name: /Merge into my project/ }))
    await screen.findByRole('heading', { name: 'Merge complete' })
  }
  const term = (label: string) => screen.queryByText(label, { selector: 'dt' })

  it('counts what was left out of a withdrawn person, and what came back unlinked', async () => {
    await merged({
      ...REPORT, withdrawn_participants_skipped: 1, withdrawn_items_skipped: 6, records_reinserted_unlinked: 2,
    })
    expect(term('Participants who withdrew, left out')?.nextElementSibling).toHaveTextContent('1')
    expect(term('Their records, speakers, quotes and notes, left out')?.nextElementSibling).toHaveTextContent('6')
    expect(term('Records added without a participant link')?.nextElementSibling).toHaveTextContent('2')
    expect(screen.getByText(/so they were added without a link/)).toBeInTheDocument()
    expect(screen.getByText(/nothing of theirs was brought back/)).toBeInTheDocument()
  })

  it('none of the rows when nothing happened', async () => {
    await merged({ ...REPORT, withdrawn_participants_skipped: 0, withdrawn_items_skipped: 0, records_reinserted_unlinked: 0 })
    expect(term('Codings added')).toBeInTheDocument()   // POSITIVE CONTROL: the report rendered
    expect(term('Participants who withdrew, left out')).toBeNull()
    expect(term('Records added without a participant link')).toBeNull()
    expect(screen.queryByText(/withdrew/)).toBeNull()
  })
})
