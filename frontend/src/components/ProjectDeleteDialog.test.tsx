/**
 * #1035 review §4 #2, #3, #10 — deleting a project names it, offers Archive, says
 * the wait, and reports how it ended in words that are true.
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project } from '@/lib/api'

const api = vi.hoisted(() => ({ del: vi.fn() }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  projectsApi: { delete: api.del },
}))
vi.mock('sonner', () => ({ toast }))

import ProjectDeleteDialog from './ProjectDeleteDialog'

afterEach(() => {
  cleanup()
  api.del.mockReset()
  toast.success.mockReset()
  toast.error.mockReset()
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 4, name: 'BES — most important issue', description: null, status: 'active',
  created_at: '', updated_at: '', conversation_count: 0, document_count: 0, dataset_count: 1,
  observation_count: 0, participant_count: 122382, coder_count: 3, ...over,
} as Project)

function mount(p: Project | null = project()) {
  const onClose = vi.fn()
  const onArchive = vi.fn()
  const qc = new QueryClient()
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  render(
    <QueryClientProvider client={qc}>
      <ProjectDeleteDialog project={p} onClose={onClose} onArchive={onArchive} />
    </QueryClientProvider>,
  )
  return { onClose, onArchive, invalidate }
}

describe('#1035 — the delete confirmation', () => {
  it('names the project and what it holds, and offers Archive', () => {
    mount()
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining(
      '“BES — most important issue” and everything in it will be deleted. This cannot be undone.'))
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining(
      'It holds 1 dataset and 122,382 participants, with all of their coding, notes and memos.'))
    expect(screen.getByRole('button', { name: 'Archive instead' })).toBeInTheDocument()
    // Technique only (jsdom has no layout): held within the viewport, scrolling
    // inside — the wait made it 416 px tall at 640×360, driven live.
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog.className).toContain('overflow-y-auto')
  })

  it('Archive instead archives and closes, deleting nothing', () => {
    const { onArchive, onClose } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Archive instead' }))
    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }))
    expect(onClose).toHaveBeenCalled()
    expect(api.del).not.toHaveBeenCalled()
  })

  it('an archived project is not offered Archive', () => {
    mount(project({ status: 'archived' }))
    expect(screen.queryByRole('button', { name: 'Archive instead' })).not.toBeInTheDocument()
  })

  it('says the wait while it runs, refuses a second press, and names the project when done', async () => {
    let finish!: () => void
    api.del.mockReturnValue(new Promise<void>(r => { finish = r }))
    const { onClose, invalidate } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    expect(await screen.findByText('Deleting “BES — most important issue”…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive instead' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Deleting…' }))
    expect(api.del).toHaveBeenCalledTimes(1)
    expect(api.del).toHaveBeenCalledWith(4)
    finish()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Deleted “BES — most important issue”'))
    expect(onClose).toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('no answer is said as not known, and the list is refreshed to tell', async () => {
    api.del.mockRejectedValue(Object.assign(new TypeError('Failed to fetch')))
    const { invalidate } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Mixed Measures did not answer, so whether “BES — most important issue” was deleted is not known. '
      + 'The list has been refreshed: if the project is still there, it was not deleted.',
      { duration: 10_000 },
    ))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('a refusal is the server’s own sentence', async () => {
    api.del.mockRejectedValue(Object.assign(new Error('Request failed'), {
      status: 409, response: { data: { detail: 'A restore is running.' } },
    }))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A restore is running.', { duration: 10_000 }))
  })
})
