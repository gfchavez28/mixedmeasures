/**
 * #1206 — every door on the project list that can REPLACE a project, or hand a new
 * one an old one's id, forgets the cached project pages before any page opens.
 *
 * SQLite reuses ids: an overwrite came back as the same project with the same
 * conversation and segment ids, and delete-then-create reused the deleted id — so
 * the page opened next painted the old copy from the cache (the app's `staleTime`
 * is 60 s, so it did not even refetch). Driven on a scratch copy, 2026-10-14b.
 *
 * The fixture is the measured shape:
 *  - `['project', 9]` holds the OLD name, and the route stub below reads it the way
 *    the Overview does — so a stub that shows it proves the cache was served;
 *  - `['segments', 31]` is entity-first and **31 is not the project id**, or a
 *    removal keyed on the project id would pass by coincidence;
 *  - `['projects']` is on screen and must SURVIVE (the positive control: the fix
 *    is "forget what no page shows", never "forget everything").
 *
 * The QueryClient uses the app's `staleTime` (60 s), or the stub refetches on its
 * own and the test cannot see the cache being served.
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route, useParams } from 'react-router'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Project } from '@/lib/api'
import { stripComments } from '@/lib/strip-comments'

const api = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), create: vi.fn(), del: vi.fn(),
  validate: vi.fn(), importProject: vi.fn(), duplicate: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  projectsApi: { list: api.list, delete: api.del, update: vi.fn(), create: api.create, get: api.get },
  projectPortabilityApi: {
    validateImport: api.validate, importProject: api.importProject, duplicateProject: api.duplicate,
  },
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('@/lib/theme-context', () => ({ useTheme: () => ({ isDark: false, toggleTheme: () => {} }) }))
vi.mock('@/hooks/useCoders', () => ({
  useCoders: () => ({ selectableCoders: [] }), resetCoderRoster: () => Promise.resolve(),
}))
vi.mock('@/hooks/useCoderSwitch', () => ({ useCoderSwitch: () => ({ requestSwitch: () => {}, dialog: null, switching: false }) }))
vi.mock('@/hooks/useCreateCoder', () => ({ useCreateCoder: () => ({ mutate: () => {} }) }))

import Dashboard from './Dashboard'

afterEach(() => {
  cleanup()
  Object.values(api).forEach(f => f.mockReset())
  toast.success.mockReset(); toast.error.mockReset()
})

function project(id: number, name: string): Project {
  return {
    id, name, description: null, status: 'active', created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z', last_activity_at: null, conversation_count: 1,
    code_count: 0, dataset_count: 0, document_count: 0, observation_count: 0,
    participant_count: 0, coder_count: 1, category_level_names: null, project_uuid: null,
    codebook_frozen_at: null,
  }
}

/** The Overview's read of the project, as a route stub. */
function OverviewStub() {
  const id = Number(useParams().id)
  const { data } = useQuery({ queryKey: ['project', id], queryFn: () => api.get(id) as Promise<{ name: string }> })
  return <p>{data ? `Overview of ${data.name}` : 'Loading the overview'}</p>
}

function renderList(projects: Project[]) {
  // The APP's staleTime — with 0, the stub would refetch anyway and hide the cache.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
  qc.setQueryData(['project', 9], project(9, 'Old copy'))
  qc.setQueryData(['segments', 31], [{ id: 501, text: 'a segment from the replaced copy' }])
  qc.setQueryData(['text-config', 9], { selected_column_ids: [4] })
  api.list.mockResolvedValue({ projects })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects/:id/overview" element={<OverviewStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return qc
}

/** What a page opened after the act would be handed from the cache. */
function expectForgotten(qc: QueryClient) {
  expect(qc.getQueryData(['project', 9]), 'the replaced project').toBeUndefined()
  expect(qc.getQueryData(['segments', 31]), 'an entity-first key (cid 31 ≠ pid 9)').toBeUndefined()
  expect(qc.getQueryData(['text-config', 9]), 'a staleTime: Infinity config').toBeUndefined()
  expect(qc.getQueryData(['projects']), 'the list on screen is kept').toBeDefined()
}

/** A request the test finishes by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const IMPORTED = { project_id: 9, project_name: 'Ferncrest', metrics_marked_stale: 0, tests_marked_stale: 0 }

async function openOverwrite() {
  api.validate.mockResolvedValue({
    manifest: { project_name: 'Ferncrest', app_version: '1.5.6', project_summary: null },
    existing_project: { id: 9, name: 'Old copy' },
    warnings: [],
  })
  const qc = renderList([project(9, 'Old copy')])
  await screen.findByText('Old copy')
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['x'], 'ferncrest.mmproject')] } })
  await screen.findByRole('alertdialog')
  return qc
}

describe('#1206 — the overwrite import', () => {
  it('opens the project on the SERVER’s copy: nothing cached is shown, then the fetched name', async () => {
    const fetched = deferred<{ name: string }>()
    api.get.mockReturnValue(fetched.promise)
    api.importProject.mockResolvedValue(IMPORTED)
    const qc = await openOverwrite()
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite my copy' }))

    // The stub is mounted with nothing to paint: the old name never appears.
    expect(await screen.findByText('Loading the overview')).toBeInTheDocument()
    expect(screen.queryByText(/Old copy/)).not.toBeInTheDocument()
    // Waited for, never read at once: the loading text renders before the query's fetch is
    // sent, and on a loaded runner the assertion can land between them (CI run 42408619787
    // on b72a43c4: "Number of calls: 0" here, 7/7 alone). The property is that the page
    // asks the SERVER, which this still requires.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(9))
    expectForgotten(qc)

    await act(async () => { fetched.resolve({ name: 'Ferncrest from the file' }) })
    expect(await screen.findByText('Overview of Ferncrest from the file')).toBeInTheDocument()
  })

  it('an import the client stopped waiting for may have finished — the cache is forgotten too', async () => {
    api.importProject.mockRejectedValue(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }))
    const qc = await openOverwrite()
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite my copy' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expectForgotten(qc)
  })
})

describe('#1206 — the other doors that can hand out a reused id', () => {
  it('create: a new project with a deleted one’s id opens on the server’s copy', async () => {
    const fetched = deferred<{ name: string }>()
    api.get.mockReturnValue(fetched.promise)
    api.create.mockResolvedValue(project(9, 'Fresh study'))
    const qc = renderList([project(1, 'Live study')])
    await screen.findByText('Live study')
    fireEvent.click(screen.getByRole('button', { name: 'New Project' }))
    fireEvent.change(await screen.findByLabelText('Project Name'), { target: { value: 'Fresh study' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }))

    expect(await screen.findByText('Loading the overview')).toBeInTheDocument()
    expect(screen.queryByText(/Old copy/)).not.toBeInTheDocument()
    expectForgotten(qc)
    await act(async () => { fetched.resolve({ name: 'Fresh study' }) })
    expect(await screen.findByText('Overview of Fresh study')).toBeInTheDocument()
  })

  it('duplicate: the copy may take a reused id', async () => {
    api.duplicate.mockResolvedValue({ ...IMPORTED, project_name: 'Live study (copy)' })
    const qc = renderList([project(1, 'Live study')])
    fireEvent.contextMenu(await screen.findByText('Live study'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Duplicate' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expectForgotten(qc)
  })

  it('delete: the next project created can take this one’s id', async () => {
    api.del.mockResolvedValue(undefined)
    const qc = renderList([project(1, 'Live study')])
    fireEvent.contextMenu(await screen.findByText('Live study'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expectForgotten(qc)
  })

  /**
   * BEFORE the navigate, pinned in SOURCE, because no render can tell: jsdom renders a
   * navigation after a 0-ms timer, so a call moved after `navigate` — in the same
   * tick or the next — still lands before the page mounts, and both mutants passed
   * every case above. In Chrome a page that mounts first keeps its cached query
   * (it is then ACTIVE, which the removal spares), so the order is the contract.
   */
  it('each door that opens a project forgets the cache before it navigates (source order)', () => {
    const src = stripComments(readFileSync(resolve(__dirname, 'Dashboard.tsx'), 'utf-8'))
    const opens = [...src.matchAll(/navigate\(`\/projects\/\$\{[a-z_.]+\}\/overview`\)/g)]
    expect(opens.length, 'the import and create doors').toBe(2)
    for (const open of opens) {
      const before = src.slice(0, open.index)
      const doorStart = Math.max(before.lastIndexOf('importProject('), before.lastIndexOf('mutationFn: projectsApi.create'))
      expect(doorStart, 'found the door the navigate belongs to').toBeGreaterThan(0)
      expect(before.slice(doorStart)).toContain('forgetCachedProjectPages(queryClient)')
    }
  })

  it('delete with no answer: it may still have finished, so the cache is forgotten as the list is refreshed', async () => {
    api.del.mockRejectedValue(new TypeError('Failed to fetch'))
    const qc = renderList([project(1, 'Live study')])
    fireEvent.contextMenu(await screen.findByText('Live study'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expectForgotten(qc)
  })
})
