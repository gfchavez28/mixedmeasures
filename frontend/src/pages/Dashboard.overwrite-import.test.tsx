/**
 * #1035 review §4 #8, #9 — the overwrite import on the project list.
 *
 * Escape closed the dialog mid-import (the import ran on, unseen); the buttons went
 * natively `disabled`, which drops focus to <body> (#965); nothing said the wait;
 * and a failure said only "Project import failed".
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const api = vi.hoisted(() => ({ list: vi.fn(), validate: vi.fn(), importProject: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  projectsApi: { list: api.list, delete: vi.fn(), update: vi.fn(), create: vi.fn(), get: vi.fn() },
  projectPortabilityApi: { validateImport: api.validate, importProject: api.importProject },
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
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

async function openOverwrite() {
  api.list.mockResolvedValue({ projects: [] })
  api.validate.mockResolvedValue({
    manifest: { project_name: 'Ferncrest', app_version: '1.5.6', project_summary: null },
    existing_project: { id: 9, name: 'Ferncrest' },
    warnings: [],
  })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><Dashboard /></MemoryRouter>
    </QueryClientProvider>,
  )
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['x'], 'ferncrest.mmproject')] } })
  await screen.findByRole('alertdialog')
  return screen.getByRole('button', { name: 'Overwrite my copy' })
}

describe('#1035 — the overwrite import says its wait and cannot be closed under it', () => {
  it('stays open on Escape while it runs, keeps its buttons focusable, and sends one request', async () => {
    let finish!: (v: unknown) => void
    api.importProject.mockReturnValue(new Promise(r => { finish = r }))
    const overwrite = await openOverwrite()
    fireEvent.click(overwrite)
    expect(await screen.findByText('Replacing your copy…')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    const working = screen.getByRole('button', { name: 'Working…' })
    expect(working).not.toBeDisabled()
    expect(working).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(working)
    fireEvent.click(screen.getByRole('button', { name: 'Import as an independent project' }))
    expect(api.importProject).toHaveBeenCalledTimes(1)
    finish({ project_id: 9, project_name: 'Ferncrest', metrics_marked_stale: 0, tests_marked_stale: 0 })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it('#1258 — the wait and the busy word follow the PRESSED button, which is kept in view', async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    let finish!: (v: unknown) => void
    api.importProject.mockReturnValue(new Promise(r => { finish = r }))
    fireEvent.click(await openOverwrite())
    expect(await screen.findByText('Replacing your copy…')).toBeInTheDocument()
    expect(screen.getByText(/A safety copy of your project is saved first, then it is replaced/)).toBeInTheDocument()
    const working = screen.getByRole('button', { name: 'Working…' })
    expect(working).toHaveAttribute('aria-busy', 'true')
    // The button NOT pressed keeps its own words and claims no wait.
    expect(screen.getByRole('button', { name: 'Import as an independent project' })).not.toHaveAttribute('aria-busy')
    expect(scrolled.mock.contexts).toContain(working)
    finish({ project_id: 9, project_name: 'Ferncrest', metrics_marked_stale: 0, tests_marked_stale: 0 })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it('a refusal is the server’s own sentence', async () => {
    api.importProject.mockRejectedValue(Object.assign(new Error('Request failed'), {
      status: 400, response: { data: { detail: 'This file was made by a newer version.' } },
    }))
    fireEvent.click(await openOverwrite())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'This file was made by a newer version.', { duration: 10_000 }))
  })
})

// #1508 (a): the button was *Import as new copy*; mode `new` has one name now.
describe('#1258 — *Import as an independent project* never says the project is being replaced', () => {
  it('says it imports a separate project, puts the busy word on its own button, and keeps it in view', async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    let finish!: (v: unknown) => void
    api.importProject.mockReturnValue(new Promise(r => { finish = r }))
    await openOverwrite()
    fireEvent.click(screen.getByRole('button', { name: 'Import as an independent project' }))
    expect(await screen.findByText(/imported as a separate project; your copy here is not changed/)).toBeInTheDocument()
    expect(screen.queryByText('Replacing your copy…')).not.toBeInTheDocument()
    expect(screen.queryByText(/then it is replaced/)).not.toBeInTheDocument()
    const busy = screen.getByRole('button', { name: 'Importing…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    // The red button was not pressed: its name and its state are its own.
    const overwrite = screen.getByRole('button', { name: 'Overwrite my copy' })
    expect(overwrite).not.toHaveAttribute('aria-busy')
    expect(screen.queryByRole('button', { name: 'Working…' })).not.toBeInTheDocument()
    expect(scrolled.mock.contexts).toContain(busy)
    expect(api.importProject).toHaveBeenCalledWith(expect.anything(), { mode: 'new', targetProjectId: undefined })
    finish({ project_id: 10, project_name: 'Ferncrest (imported)', metrics_marked_stale: 0, tests_marked_stale: 0 })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported "Ferncrest (imported)"', undefined))
  })
})
