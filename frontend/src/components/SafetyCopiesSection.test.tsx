/**
 * #919 — Settings › Backup & Data › Safety copies.
 *
 * The behaviours under test:
 * - the list shows what each copy is OF, how large it is, and what it preceded;
 * - Download reaches the file (the recovery path — the backup folder is not
 *   reachable from the app);
 * - Delete confirms first, names the copy, warns when it may be a project's only
 *   copy, reports the server's reason on failure, and leaves focus somewhere real;
 * - a listing failure SAYS so rather than reading as "there are none".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SafetyCopyInfo } from '@/lib/api'
import { ApiError } from '@/lib/api/client'

const listSafetyCopies = vi.fn()
const downloadSafetyCopy = vi.fn()
const deleteSafetyCopy = vi.fn()
vi.mock('@/lib/api', () => ({
  backupApi: {
    listSafetyCopies: (...a: unknown[]) => listSafetyCopies(...a),
    downloadSafetyCopy: (...a: unknown[]) => downloadSafetyCopy(...a),
    deleteSafetyCopy: (...a: unknown[]) => deleteSafetyCopy(...a),
  },
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

import SafetyCopiesSection from './SafetyCopiesSection'
import { formatTakenAt } from '@/lib/safety-copies'

const HERE: SafetyCopyInfo = {
  filename: 'pre-merge_4_20260910_090000.mmproject',
  act: 'merge',
  taken_at: '2026-09-10T09:00:00+00:00',
  size_bytes: 5 * 1024 * 1024,
  project_name: 'Community health study',
  project_in_app: true,
  readable: true,
}

const GONE: SafetyCopyInfo = {
  filename: 'pre-overwrite_2_20260801_120000.mmproject',
  act: 'merge_or_overwrite',
  taken_at: '2026-08-01T12:00:00+00:00',
  size_bytes: 3 * 1024 * 1024,
  project_name: 'Pilot interviews',
  project_in_app: false,
  readable: true,
}

const DAMAGED: SafetyCopyInfo = {
  filename: 'pre-merge_9_20260701_080000.mmproject',
  act: 'merge',
  taken_at: '2026-07-01T08:00:00+00:00',
  size_bytes: 512,
  project_name: null,
  project_in_app: null,
  readable: false,
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SafetyCopiesSection />
    </QueryClientProvider>,
  )
}

async function openList() {
  const toggle = await screen.findByRole('button', { name: /Safety copies from merges and overwrites/ })
  fireEvent.click(toggle)
  return toggle
}

beforeEach(() => {
  listSafetyCopies.mockReset()
  downloadSafetyCopy.mockReset()
  deleteSafetyCopy.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})

afterEach(cleanup)

describe('SafetyCopiesSection', () => {
  it('renders nothing until a merge or an overwrite has written a copy', async () => {
    listSafetyCopies.mockResolvedValue([])
    const { container } = renderSection()
    await waitFor(() => expect(listSafetyCopies).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('says when the copies could not be listed, rather than showing none', async () => {
    listSafetyCopies.mockRejectedValue(new Error('boom'))
    renderSection()
    expect(await screen.findByText(/could not be listed/)).toBeInTheDocument()
  })

  it('states the count and the disk space before it is opened', async () => {
    listSafetyCopies.mockResolvedValue([HERE, GONE])
    renderSection()
    const toggle = await screen.findByRole('button', {
      name: 'Safety copies from merges and overwrites (2 copies, 8.0 MB)',
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Safety copies' })).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeInTheDocument()
  })

  it('lists what each copy is of, what it preceded, and how large it is', async () => {
    listSafetyCopies.mockResolvedValue([HERE, GONE, DAMAGED])
    renderSection()
    await openList()
    const items = within(screen.getByRole('list', { name: 'Safety copies' })).getAllByRole('listitem')
    expect(items).toHaveLength(3)

    expect(items[0]).toHaveTextContent('Community health study')
    expect(items[0]).toHaveTextContent('Before a merge')
    expect(items[0]).toHaveTextContent('5.0 MB')
    expect(items[0]).not.toHaveTextContent('No longer in Mixed Measures')

    expect(items[1]).toHaveTextContent('Before a merge or overwrite')
    expect(items[1]).toHaveTextContent('No longer in Mixed Measures')

    // An unreadable copy is identified by its file, never by an empty title.
    expect(items[2]).toHaveTextContent(DAMAGED.filename)
    expect(items[2]).toHaveTextContent('This file could not be read')
  })

  it('names every row control after its copy, so N rows are not N identical buttons', async () => {
    listSafetyCopies.mockResolvedValue([HERE, DAMAGED])
    renderSection()
    await openList()
    const when = formatTakenAt(HERE.taken_at)
    expect(screen.getByRole('button', { name: `Download safety copy of Community health study, ${when}` }))
      .toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Delete safety copy of Community health study, ${when}` }))
      .toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(`^Delete safety copy of ${DAMAGED.filename}`) }))
      .toBeInTheDocument()
    // The visible word is at the start of each name (WCAG 2.5.3).
    for (const button of screen.getAllByRole('button', { name: /safety copy of/ })) {
      expect(button.getAttribute('aria-label')!.startsWith(button.textContent!.trim())).toBe(true)
    }
  })

  it('downloads the copy it is on', async () => {
    listSafetyCopies.mockResolvedValue([HERE, GONE])
    downloadSafetyCopy.mockResolvedValue(undefined)
    renderSection()
    await openList()
    fireEvent.click(screen.getByRole('button', { name: /^Download safety copy of Pilot interviews/ }))
    await waitFor(() => expect(downloadSafetyCopy).toHaveBeenCalledWith(GONE.filename))
  })

  it('confirms before deleting, then deletes that copy and refreshes the list', async () => {
    listSafetyCopies.mockResolvedValueOnce([HERE, GONE]).mockResolvedValue([GONE])
    deleteSafetyCopy.mockResolvedValue(undefined)
    renderSection()
    await openList()

    fireEvent.click(screen.getByRole('button', { name: /^Delete safety copy of Community health study/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(deleteSafetyCopy).not.toHaveBeenCalled()
    expect(dialog).toHaveTextContent('Community health study, taken before a merge on')
    expect(dialog).toHaveTextContent('cannot be brought back')
    expect(dialog).not.toHaveTextContent('only copy')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete copy' }))
    await waitFor(() => expect(deleteSafetyCopy).toHaveBeenCalledWith(HERE.filename))
    await waitFor(() => expect(listSafetyCopies).toHaveBeenCalledTimes(2))
    expect(toastSuccess).toHaveBeenCalledWith('Deleted the safety copy of Community health study')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('warns that a copy of a project no longer in the app may be its only copy', async () => {
    listSafetyCopies.mockResolvedValue([GONE])
    renderSection()
    await openList()
    fireEvent.click(screen.getByRole('button', { name: /^Delete safety copy of Pilot interviews/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(
      '“Pilot interviews” is no longer in Mixed Measures, so this file may be the only copy of it anywhere.',
    )
  })

  it('🔴 the only-copy warning is part of the dialog’s DESCRIPTION, not just on screen', async () => {
    // a11y-name-sweep run 6, measured in Chrome: rendered as the dialog's
    // children the warning was visible and SILENT — the computed description
    // stopped before it. The structure that makes it heard is that the warning
    // sits inside the element `aria-describedby` points at.
    listSafetyCopies.mockResolvedValue([GONE])
    renderSection()
    await openList()
    fireEvent.click(screen.getByRole('button', { name: /^Delete safety copy of Pilot interviews/ }))
    const dialog = await screen.findByRole('alertdialog')
    const described = document.getElementById(dialog.getAttribute('aria-describedby')!)
    expect(described).not.toBeNull()
    expect(described).toContainElement(screen.getByTestId('safety-copy-delete-warnings'))
    expect(dialog).toHaveAccessibleDescription(/may be the only copy of it anywhere/)
  })

  it('groups a large count the way the locale does', async () => {
    const many = Array.from({ length: 1234 }, (_, i) => ({ ...HERE, filename: `pre-merge_4_20260910_09${String(i).padStart(4, '0')}.mmproject` }))
    listSafetyCopies.mockResolvedValue(many)
    renderSection()
    expect(await screen.findByRole('button', {
      name: new RegExp(`\\(${(1234).toLocaleString()} copies, `),
    })).toBeInTheDocument()
  })

  it('cancelling deletes nothing', async () => {
    listSafetyCopies.mockResolvedValue([HERE])
    renderSection()
    await openList()
    fireEvent.click(screen.getByRole('button', { name: /^Delete safety copy of/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(deleteSafetyCopy).not.toHaveBeenCalled()
  })

  it('reports the server’s reason when a delete is refused', async () => {
    listSafetyCopies.mockResolvedValue([HERE])
    deleteSafetyCopy.mockRejectedValue(
      new ApiError(409, { detail: 'The safety copy could not be deleted. If it is open in another program, close it and try again.' }, {}),
    )
    renderSection()
    await openList()
    fireEvent.click(screen.getByRole('button', { name: /^Delete safety copy of/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete copy' }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      'The safety copy could not be deleted. If it is open in another program, close it and try again.',
    ))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('returns focus to the list header after deleting the last copy, and keeps the header', async () => {
    listSafetyCopies.mockResolvedValueOnce([HERE]).mockResolvedValue([])
    deleteSafetyCopy.mockResolvedValue(undefined)
    renderSection()
    const toggle = await openList()
    fireEvent.click(screen.getByRole('button', { name: /^Delete safety copy of/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete copy' }))

    expect(await screen.findByText('No safety copies remain.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(toggle))
  })
})
