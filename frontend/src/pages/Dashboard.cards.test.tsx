/**
 * The project cards — both lists built by ONE builder (2026-10-14).
 *
 * The archived list wrote its own props, and its Duplicate called the mutation
 * directly: no #482 confirmation (a copy has its own identity and cannot be merged
 * back), and `duplicating` unscoped, so every archived card read "Duplicating…".
 * And the card's counts had no thousands separator (BES: "122382 participants").
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Project } from '@/lib/api'

const api = vi.hoisted(() => ({ list: vi.fn(), duplicate: vi.fn() }))
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  projectsApi: { list: api.list, delete: vi.fn(), update: vi.fn(), create: vi.fn(), get: vi.fn() },
  projectPortabilityApi: { validateImport: vi.fn(), importProject: vi.fn(), duplicateProject: api.duplicate },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
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
})

function project(id: number, name: string, status: Project['status'], extra: Partial<Project> = {}): Project {
  return {
    id, name, description: null, status, created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z', last_activity_at: null, conversation_count: 0,
    code_count: 0, dataset_count: 1, document_count: 0, observation_count: 0,
    participant_count: 0, coder_count: 1, category_level_names: null, project_uuid: null,
    codebook_frozen_at: null, ...extra,
  }
}

async function renderList(projects: Project[]) {
  api.list.mockResolvedValue({ projects })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><Dashboard /></MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByText(projects[0].name)
}

describe('the project cards', () => {
  it('Duplicate on an ARCHIVED card asks first, as on an active one (#482)', async () => {
    await renderList([project(1, 'Live study', 'active'), project(2, 'Old study', 'archived')])
    fireEvent.contextMenu(screen.getByText('Old study'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }))
    expect(await screen.findByRole('alertdialog', { name: 'Duplicate this project?' })).toBeInTheDocument()
    expect(api.duplicate).not.toHaveBeenCalled()
  })

  it('the active card asks too — the positive control', async () => {
    await renderList([project(1, 'Live study', 'active')])
    fireEvent.contextMenu(screen.getByText('Live study'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }))
    expect(await screen.findByRole('alertdialog', { name: 'Duplicate this project?' })).toBeInTheDocument()
    expect(api.duplicate).not.toHaveBeenCalled()
  })

  it('states large counts with thousands separators', async () => {
    await renderList([project(1, 'BES', 'active', { participant_count: 122382, document_count: 1500, coder_count: 2 })])
    expect(screen.getByText('122,382')).toBeInTheDocument()
    expect(screen.getByText('1,500')).toBeInTheDocument()
    expect(screen.queryByText('122382')).not.toBeInTheDocument()
  })
})
