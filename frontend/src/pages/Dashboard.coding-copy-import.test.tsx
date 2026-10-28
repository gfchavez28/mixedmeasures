/**
 * #1321 — with no local project sharing the file's identity, the project list's import
 * KEEPS the identity by default (`copy_for_coding`), so a colleague's copy can be merged
 * back; re-minting it is the named second choice. At 2fe78dc7 the dialog offered only
 * *Import*, which sent `new`.
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const api = vi.hoisted(() => ({ list: vi.fn(), validate: vi.fn(), importProject: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const auth = vi.hoisted(() => ({ user: null as null | { id: number; username: string } }))
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  projectsApi: { list: api.list, delete: vi.fn(), update: vi.fn(), create: vi.fn(), get: vi.fn() },
  projectPortabilityApi: { validateImport: api.validate, importProject: api.importProject },
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: auth.user }) }))
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
  auth.user = null
})

const fileCoder = (originalId: number, username: string, apps: number, match: null | { id: number; basis: 'identity' | 'name' }) => ({
  original_id: originalId, username, coder_type: 'human', archived: false, file_app_count: apps,
  local_match: match && { id: match.id, username, archived: false, local_app_count: 0, basis: match.basis },
  name_in_use: null, match_options: [], machine_provenance: null, create_username: username,
})
const ME = 7

async function open(over: Record<string, unknown> = {}) {
  api.list.mockResolvedValue({ projects: [] })
  api.validate.mockResolvedValue({
    manifest: { project_name: 'Clinic study', app_version: '1.5.7', project_summary: null, project_uuid: 'u-1' },
    existing_project: null, merge_coders: null, merge_codes_preview: null, file_coders: [], warnings: [],
    ...over,
  })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><Dashboard /></MemoryRouter>
    </QueryClientProvider>,
  )
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['x'], 'clinic.mmproject')] } })
  await screen.findByRole('alertdialog')
}

const done = { project_id: 4, project_name: 'Clinic study', metrics_marked_stale: 0, tests_marked_stale: 0 }

describe('#1321 — a file no project here shares keeps its identity', () => {
  it('*Import* sends a coding copy, which keeps the identity', async () => {
    api.importProject.mockResolvedValue(done)
    await open()
    expect(screen.getByText(/It keeps the identity of\s+the project it was exported from/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(api.importProject).toHaveBeenCalledWith(
      expect.anything(), { mode: 'copy_for_coding', targetProjectId: undefined }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported "Clinic study"', undefined))
  })

  it('re-minting it is the named second choice', async () => {
    api.importProject.mockResolvedValue(done)
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Import as an independent project' }))
    await waitFor(() => expect(api.importProject).toHaveBeenCalledWith(
      expect.anything(), { mode: 'new', targetProjectId: undefined }))
  })

  it('says what makes the merge refuse, in both copies, and what clears it — in the description', async () => {
    await open()
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleDescription(expect.stringMatching(
      /A merge refuses copies whose units or words differ, so in neither copy split or join a turn or paragraph, edit its words, or freeze or unfreeze an observation's clips\./))
    // The workbench menu's own labels (SegmentRow / DocumentCodingWorkbench): Rejoin, Unmerge.
    expect(dialog).toHaveAccessibleDescription(expect.stringMatching(
      /undoing it in the copy that changed \(Rejoin, Unmerge, or putting the words back\) clears that refusal/))
  })

  it('control: a file with no identity is offered only as a new project', async () => {
    api.importProject.mockResolvedValue(done)
    await open({ manifest: { project_name: 'Old', app_version: '1.0.0', project_summary: null, project_uuid: null } })
    expect(screen.queryByRole('button', { name: 'Import as an independent project' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(api.importProject).toHaveBeenCalledWith(
      expect.anything(), { mode: 'new', targetProjectId: undefined }))
  })
})

describe('D2 — "Which of these people is you?" before a coding copy', () => {
  const twoPeople = [fileCoder(1, 'Researcher', 2, { id: ME, basis: 'name' }), fileCoder(2, 'Ana', 1, null)]

  async function asked() {
    auth.user = { id: ME, username: 'Researcher' }
    api.importProject.mockResolvedValue(done)
    await open({ file_coders: twoPeople })
    return screen.getByRole('group', { name: 'Which of these people is you?' })
  }

  it('lists each person by name and codings, plus None of them — the WARNING is gone', async () => {
    const group = await asked()
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(3)
    radios.forEach(r => expect(r).not.toBeChecked())   // nothing is answered for them
    expect(within(group).getByRole('radio', { name: 'Researcher — 2 codings' })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: 'Ana — 1 coding' })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: 'None of them' })).toBeInTheDocument()
    expect(group).toHaveAccessibleDescription(/choose yourself: that coding becomes yours, as Researcher\./)
    expect(screen.queryByText(/will be\s+shown as yours/)).not.toBeInTheDocument()
  })

  it('*Import* is aria-disabled, described by a visible sentence, and its handler refuses — never native disabled', async () => {
    await asked()
    const button = screen.getByRole('button', { name: 'Import' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAccessibleDescription(
      'Choose which of these people is you, or None of them, before importing.')
    // Enter and Space reach a <button> as this same click, so the guard is the refusal.
    fireEvent.click(button)
    await new Promise(r => setTimeout(r, 0))
    expect(api.importProject).not.toHaveBeenCalled()
    expect(button).not.toHaveAttribute('aria-busy')
  })

  it('"None of them" opens it and sends NO coder_mapping', async () => {
    const group = await asked()
    fireEvent.click(within(group).getByRole('radio', { name: 'None of them' }))
    const button = screen.getByRole('button', { name: 'Import' })
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button).not.toHaveAttribute('aria-describedby')
    fireEvent.click(button)
    await waitFor(() => expect(api.importProject).toHaveBeenCalledTimes(1))
    expect(api.importProject.mock.calls[0][1]).toEqual({ mode: 'copy_for_coding', targetProjectId: undefined })
    expect(api.importProject.mock.calls[0][1]).not.toHaveProperty('coderMapping')
  })

  it('the chosen person sends ONE match onto the active coder', async () => {
    const group = await asked()
    fireEvent.click(within(group).getByRole('radio', { name: 'Ana — 1 coding' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(api.importProject).toHaveBeenCalledWith(expect.anything(), {
      mode: 'copy_for_coding', targetProjectId: undefined,
      coderMapping: { '2': { action: 'match', target_user_id: ME } },
    }))
  })

  it('*Import as an independent project* is NOT gated by the question (D6) and sends no mapping', async () => {
    await asked()
    const other = screen.getByRole('button', { name: 'Import as an independent project' })
    expect(other).not.toHaveAttribute('aria-disabled')
    expect(other).not.toHaveAttribute('aria-describedby')
    // Even with an answer given: the question is about the copy that KEEPS the identity.
    fireEvent.click(screen.getByRole('radio', { name: 'Ana — 1 coding' }))
    fireEvent.click(other)
    await waitFor(() => expect(api.importProject).toHaveBeenCalledWith(
      expect.anything(), { mode: 'new', targetProjectId: undefined }))
  })

  it('is skipped when a file coder is already you by identity', async () => {
    auth.user = { id: ME, username: 'Researcher' }
    api.importProject.mockResolvedValue(done)
    await open({ file_coders: [fileCoder(1, 'Researcher', 2, { id: ME, basis: 'identity' }), fileCoder(2, 'Ana', 1, null)] })
    expect(screen.queryByRole('group', { name: 'Which of these people is you?' })).not.toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Import' })
    expect(button).not.toHaveAttribute('aria-disabled')
    fireEvent.click(button)
    await waitFor(() => expect(api.importProject).toHaveBeenCalledWith(
      expect.anything(), { mode: 'copy_for_coding', targetProjectId: undefined }))
  })

  it('is skipped when nobody in the file coded (no gate either)', async () => {
    auth.user = { id: ME, username: 'Researcher' }
    await open({ file_coders: [fileCoder(1, 'Researcher', 0, { id: ME, basis: 'name' })] })
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).not.toHaveAttribute('aria-disabled')
  })

  it('a NEW file is asked again — the answer belonged to the last one', async () => {
    const group = await asked()
    fireEvent.click(within(group).getByRole('radio', { name: 'None of them' }))
    expect(screen.getByRole('button', { name: 'Import' })).not.toHaveAttribute('aria-disabled')
    // The only way the dialog shows another file is a new pick, which validates afresh.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['y'], 'other.mmproject')] } })
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import' })).toHaveAttribute('aria-disabled', 'true'))
    expect(screen.getByRole('radio', { name: 'None of them' })).not.toBeChecked()
  })
})
