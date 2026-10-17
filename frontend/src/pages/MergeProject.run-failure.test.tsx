/**
 * #1232 — what the Merge page says, and forgets, when the merge itself fails.
 *
 * It said "Merge failed. Your project was not changed." for every failure: a 400
 * carrying #977's merge refusal reached no screen, and after a timeout — the server
 * keeps working once the client stops waiting (`EXPORT_TIMEOUT_MS`, 15 min) — the page
 * kept the pre-merge pages cached and went back to Review, whose Merge button would
 * send the same decisions again. A finished merge repeated with a "create" decision
 * adds that coder a second time with every coding (#1246, EXECUTED: "Bob (2)" then
 * "Bob (3)").
 *
 * The cached page is `['segments', 31]` — an entity-first key whose id is NOT the
 * project's (7), so a removal keyed on the project would pass by coincidence.
 *
 * The divergence 409 has its own screen and is pinned elsewhere; it is the control
 * that the new arm does not swallow it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route } from 'react-router'
import type { ImportValidationResult } from '@/lib/api'
import { ApiError } from '@/lib/api/client'
import { setPendingMerge } from '@/lib/pending-merge'

const api = vi.hoisted(() => ({ validate: vi.fn(), importProject: vi.fn(), codes: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const roster = vi.hoisted(() => ({ reset: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    projectPortabilityApi: { validateImport: api.validate, importProject: api.importProject },
    codesApi: { ...actual.codesApi, list: (...a: unknown[]) => api.codes(...a) },
  }
})
vi.mock('sonner', () => ({ toast }))
vi.mock('@/hooks/useCoders', () => ({ resetCoderRoster: roster.reset }))
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 7, project: { id: 7, name: 'Study' } }),
}))

import MergeProject from './MergeProject'

afterEach(() => {
  cleanup()
  Object.values(api).forEach(f => f.mockReset())
  toast.error.mockReset(); toast.success.mockReset(); roster.reset.mockClear()
})

const TOO_LARGE = 'Merging was stopped because the project you are merging into is too large to snapshot first, '
  + 'and it is not changed without a snapshot. This project holds 4,100,000 values; the limit is 4,000,000.'

async function runMergeWith(outcome: () => Promise<unknown>) {
  api.codes.mockResolvedValue({ codes: [] })
  api.importProject.mockImplementation(outcome)
  const validation = {
    manifest: { project_name: 'Study', app_version: '1.5.7', project_summary: null },
    existing_project: { id: 7, name: 'Study' },
    warnings: [], merge_coders: [], merge_codes_preview: [],
  } as unknown as ImportValidationResult
  setPendingMerge(new File(['x'], 'study.mmproject'), validation, 7)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
  qc.setQueryData(['segments', 31], [{ id: 501, text: 'pre-merge' }])
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/7/merge']}>
        <Routes><Route path="/projects/:projectId/merge" element={<MergeProject />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Continue to review' }))
  fireEvent.click(await screen.findByRole('button', { name: /Merge into my project/ }))
  return qc
}

describe('#1232 — a refusal the server answered', () => {
  it('says the server’s sentence (#977’s merge refusal), held 10 s, and goes back to Review', async () => {
    const qc = await runMergeWith(() => Promise.reject(new ApiError(400, { detail: TOO_LARGE }, {})))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error).toHaveBeenCalledWith(TOO_LARGE, { duration: 10_000 })
    expect(await screen.findByRole('button', { name: /Merge into my project/ })).toBeInTheDocument()
    // Forgotten on every failure, as the Dashboard's import catch does.
    expect(qc.getQueryData(['segments', 31])).toBeUndefined()
    // Nothing was merged, so nobody was added: the roster is left alone.
    expect(roster.reset).not.toHaveBeenCalled()
  })

  it('an answer with no sentence: it could not be completed', async () => {
    await runMergeWith(() => Promise.reject(new ApiError(500, {}, {})))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error.mock.calls[0][0]).toBe('The merge could not be completed. Your project was not changed.')
  })
})

describe('#1232 — a merge the client stopped waiting for', () => {
  it('says the outcome is not known, offers no second Merge, and forgets the pages', async () => {
    const qc = await runMergeWith(() => Promise.reject(new DOMException('signal timed out', 'TimeoutError')))
    const heading = await screen.findByRole('heading', { name: 'Whether the merge finished is not known' })
    // The step's own heading takes focus (useStepFocus, after the transient `merging`).
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(screen.getByText(/did not answer, so whether the merge finished is not known/)).toBeInTheDocument()
    expect(screen.queryByText(/not changed/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Merge into my project/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Back to project/ })).toBeInTheDocument()
    // The rail stays on Review: "Done" would say the merge finished.
    expect(document.querySelector('nav[aria-label="Merge progress"] [aria-current="step"]'))
      .toHaveTextContent('Review')
    expect(qc.getQueryData(['segments', 31]), 'an entity-first key (cid 31 ≠ pid 7)').toBeUndefined()
    // A merge that finished created the file's coders — the roster is RESET (#964).
    expect(roster.reset).toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a dropped connection is a non-answer too', async () => {
    await runMergeWith(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(await screen.findByRole('heading', { name: 'Whether the merge finished is not known' })).toBeInTheDocument()
  })

  it('CONTROL: a divergence 409 still opens its own screen', async () => {
    await runMergeWith(() => Promise.reject(new ApiError(409, {
      detail: { error: 'diverged', kind: 'segmentation', diverged_sources: [{ name: 'Interview A', local_segments: 3, file_segments: 4 }] },
    }, {})))
    expect(await screen.findByRole('heading', { name: /segmentation differs/ })).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
