/**
 * The Merge page, whole: two findings from Batch 5's review.
 *
 * - **#1203** — a file from a NEWER version was read, and refused by the server with
 *   a sentence saying to update; the page said "That file could not be read as an
 *   .mmproject." and sent the researcher looking for a damaged file.
 * - **#1206** — after a merge the page invalidated queries whose key INCLUDED the
 *   project id. That missed the entity-first keys (`['segments', cid]`) and only
 *   invalidated, so a page opened next painted the pre-merge copy first. Now every
 *   page not on screen is forgotten and the page on screen refetches.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route } from 'react-router'
import type { ImportValidationResult } from '@/lib/api'
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
vi.mock('@/hooks/useCoders', () => ({ resetCoderRoster: () => Promise.resolve() }))
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 7, project: { id: 7, name: 'Study' } }),
}))

import MergeProject from './MergeProject'

afterEach(() => { cleanup(); Object.values(api).forEach(f => f.mockReset()) })

function renderMerge(qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })) {
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/7/merge']}>
        <Routes><Route path="/projects/:projectId/merge" element={<MergeProject />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return qc
}

describe('#1203 — the upload step says the server’s reason', () => {
  it('a file from a newer version: the server’s sentence, not "could not be read"', async () => {
    const newer = 'This file was created by a newer version of Mixed Measures (format version 8). '
      + 'Please update to import it.'
    api.codes.mockResolvedValue({ codes: [] })
    api.validate.mockRejectedValue(Object.assign(new Error('Request failed'), {
      status: 400, response: { status: 400, data: { detail: newer } },
    }))
    renderMerge()
    await screen.findByRole('button', { name: 'Choose file…' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'from-1.6.mmproject')] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(newer)
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument()
  })

  it('an answer with no reason keeps the old sentence', async () => {
    api.codes.mockResolvedValue({ codes: [] })
    api.validate.mockRejectedValue(new TypeError('Failed to fetch'))
    renderMerge()
    await screen.findByRole('button', { name: 'Choose file…' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.mmproject')] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('That file could not be read as an .mmproject.')
  })
})

describe('#1206 — a merge forgets every page not on screen and refreshes the one that is', () => {
  it('an entity-first key (cid 31 ≠ pid 7) is forgotten; the codebook on screen is asked again', async () => {
    api.codes.mockResolvedValue({ codes: [] })
    api.importProject.mockResolvedValue({
      project_id: 7, project_name: 'Study', safety_backup_filename: null,
      metrics_marked_stale: 0, tests_marked_stale: 0,
      merge_report: {
        sources_matched: 1, applications_added: 3, duplicates_skipped: 0, coders_created: 0,
        coders_matched: 1, codes_collapsed: 0, codes_linked: 0, codes_created: 0,
      },
    })
    const validation = {
      manifest: { project_name: 'Study', app_version: '1.5.7', project_summary: null },
      existing_project: { id: 7, name: 'Study' },
      warnings: [], merge_coders: [], merge_codes_preview: [],
    } as unknown as ImportValidationResult
    setPendingMerge(new File(['x'], 'study.mmproject'), validation, 7)

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
    qc.setQueryData(['segments', 31], [{ id: 501, text: 'pre-merge' }])
    qc.setQueryData(['conversation', 7, 31], { id: 31, name: 'pre-merge' })
    renderMerge(qc)

    fireEvent.click(await screen.findByRole('button', { name: 'Continue to review' }))
    fireEvent.click(await screen.findByRole('button', { name: /Merge into my project/ }))
    expect(await screen.findByRole('heading', { name: 'Merge complete' })).toBeInTheDocument()

    expect(qc.getQueryData(['segments', 31])).toBeUndefined()
    expect(qc.getQueryData(['conversation', 7, 31])).toBeUndefined()
    // The page on screen keeps its codebook and asks for it again.
    expect(qc.getQueryData(['codes', 7])).toBeDefined()
    await waitFor(() => expect(api.codes).toHaveBeenCalledTimes(2))
  })
})
