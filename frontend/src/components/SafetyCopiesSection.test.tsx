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

/** #978: the endpoint returns a bounded PAGE with the folder's totals beside it,
 * so a mock that returns a bare array no longer describes the wire. `total_*`
 * default to the page's own contents — the cases where they must DIFFER pass
 * them explicitly, which is the property the bound turns on. */
function page(
  copies: SafetyCopyInfo[],
  overrides: Partial<{ total_count: number; total_bytes: number; truncated: boolean }> = {},
) {
  return {
    copies,
    total_count: copies.length,
    total_bytes: copies.reduce((sum, c) => sum + c.size_bytes, 0),
    truncated: false,
    ...overrides,
  }
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
    listSafetyCopies.mockResolvedValue(page([]))
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
    listSafetyCopies.mockResolvedValue(page([HERE, GONE]))
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
    listSafetyCopies.mockResolvedValue(page([HERE, GONE, DAMAGED]))
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
    listSafetyCopies.mockResolvedValue(page([HERE, DAMAGED]))
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
    listSafetyCopies.mockResolvedValue(page([HERE, GONE]))
    downloadSafetyCopy.mockResolvedValue(undefined)
    renderSection()
    await openList()
    fireEvent.click(screen.getByRole('button', { name: /^Download safety copy of Pilot interviews/ }))
    await waitFor(() => expect(downloadSafetyCopy).toHaveBeenCalledWith(GONE.filename))
  })

  it('confirms before deleting, then deletes that copy and refreshes the list', async () => {
    listSafetyCopies.mockResolvedValueOnce(page([HERE, GONE])).mockResolvedValue(page([GONE]))
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
    listSafetyCopies.mockResolvedValue(page([GONE]))
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
    listSafetyCopies.mockResolvedValue(page([GONE]))
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
    listSafetyCopies.mockResolvedValue(page(many))
    renderSection()
    expect(await screen.findByRole('button', {
      name: new RegExp(`\\(${(1234).toLocaleString()} copies, `),
    })).toBeInTheDocument()
  })

  describe('the list is bounded (#978)', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...HERE,
        filename: `pre-merge_4_20260910_09${String(i).padStart(4, '0')}.mmproject`,
      }))

    it('🔴 states the FOLDER’s totals, not the page’s', async () => {
      // The measured shape: 50 rows returned out of 1,954. Summing the page would
      // understate the disk cost 39×, in the one line whose job is to state that
      // cost before the researcher pays it.
      listSafetyCopies.mockResolvedValue(
        page(many(50), { total_count: 1954, total_bytes: 26_861_722, truncated: true }),
      )
      renderSection()
      expect(await screen.findByRole('button', {
        name: `Safety copies from merges and overwrites (${(1954).toLocaleString()} copies, 25.6 MB)`,
      })).toBeInTheDocument()
    })

    it('says the list is a page, above it, and offers the rest', async () => {
      listSafetyCopies.mockResolvedValue(
        page(many(50), { total_count: 1954, total_bytes: 26_861_722, truncated: true }),
      )
      renderSection()
      await openList()
      expect(screen.getByRole('status')).toHaveTextContent(
        `Showing the 50 most recent of ${(1954).toLocaleString()}.`,
      )
      expect(screen.getAllByRole('listitem')).toHaveLength(50)
      expect(screen.getByRole('button', { name: `Show all ${(1954).toLocaleString()}` }))
        .toBeInTheDocument()
    })

    it('asks the server for every copy when Show all is pressed', async () => {
      listSafetyCopies.mockResolvedValue(
        page(many(50), { total_count: 1954, total_bytes: 26_861_722, truncated: true }),
      )
      renderSection()
      await openList()
      expect(listSafetyCopies).toHaveBeenLastCalledWith(50)
      fireEvent.click(screen.getByRole('button', { name: /^Show all/ }))
      // 0 means "no limit" on the wire. A client-side cap alone would leave the
      // payload — and the 1,954 archive opens behind it — unbounded.
      await waitFor(() => expect(listSafetyCopies).toHaveBeenLastCalledWith(0))
    })

    describe('#1038 (f) — Show all keeps the list, and the keyboard user’s place', () => {
      it('keeps the page on screen while the rest loads, and says it is loading', async () => {
        // Before: the key changed, `data` went undefined, the whole section
        // returned null, and the pressed button unmounted with focus on it.
        let finish: (v: unknown) => void = () => {}
        listSafetyCopies.mockImplementation((size: number) =>
          size === 0
            ? new Promise((resolve) => { finish = resolve })
            : Promise.resolve(page(many(50), { total_count: 60, total_bytes: 1, truncated: true })),
        )
        renderSection()
        await openList()
        const showAll = screen.getByRole('button', { name: 'Show all 60' })
        showAll.focus()
        fireEvent.click(showAll)
        await waitFor(() => expect(listSafetyCopies).toHaveBeenLastCalledWith(0))

        expect(screen.getAllByRole('listitem')).toHaveLength(50)
        // The same element, still focused, busy — and its NAME unchanged (#770).
        expect(document.activeElement).toBe(showAll)
        expect(showAll).toHaveAttribute('aria-busy', 'true')
        expect(showAll).toHaveAttribute('aria-disabled', 'true')
        expect(screen.getByRole('status')).toHaveTextContent('Loading the rest…')

        // A second press while busy asks for nothing more.
        const calls = listSafetyCopies.mock.calls.length
        fireEvent.click(showAll)
        expect(listSafetyCopies.mock.calls.length).toBe(calls)

        finish(page(many(60)))
        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(60))
      })

      it('moves focus to the first copy it revealed, not to <body>', async () => {
        listSafetyCopies.mockImplementation((size: number) =>
          Promise.resolve(size === 0
            ? page(many(60))
            : page(many(50), { total_count: 60, total_bytes: 1, truncated: true })),
        )
        renderSection()
        await openList()
        const showAll = screen.getByRole('button', { name: 'Show all 60' })
        showAll.focus()
        fireEvent.click(showAll)
        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(60))
        expect(screen.queryByRole('button', { name: /^Show all/ })).not.toBeInTheDocument()
        const firstRevealed = screen.getAllByRole('listitem')[50]
        await waitFor(() => expect(document.activeElement).toBe(within(firstRevealed).getAllByRole('button')[0]))
        expect(document.activeElement).not.toBe(document.body)
      })
    })

    it('says nothing about paging when the folder fits', async () => {
      // The POSITIVE control: a guard that passes by always showing the notice
      // would pass every assertion above.
      listSafetyCopies.mockResolvedValue(page([HERE, GONE]))
      renderSection()
      await openList()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^Show all/ })).not.toBeInTheDocument()
    })
  })

  it('cancelling deletes nothing', async () => {
    listSafetyCopies.mockResolvedValue(page([HERE]))
    renderSection()
    await openList()
    fireEvent.click(screen.getByRole('button', { name: /^Delete safety copy of/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(deleteSafetyCopy).not.toHaveBeenCalled()
  })

  it('reports the server’s reason when a delete is refused', async () => {
    listSafetyCopies.mockResolvedValue(page([HERE]))
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
    listSafetyCopies.mockResolvedValueOnce(page([HERE])).mockResolvedValue(page([]))
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
