/**
 * #1054 review D6 / §4 #4, #7, #11 — Link by column asks first, from the server's
 * dry run, says the wait, and hands the result to the page to keep.
 *
 * ⚠️ `fireEvent`, never `user-event` — it is not a dependency of this repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ParticipantLinkReport } from '@/lib/api'

const api = vi.hoisted(() => ({
  previewLinkByColumn: vi.fn(),
  linkByColumn: vi.fn(),
  getProject: vi.fn(),
}))
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  datasetsApi: { previewLinkByColumn: api.previewLinkByColumn, linkByColumn: api.linkByColumn },
  projectsApi: { get: api.getProject },
}))

import LinkByColumnDialog, { LinkByColumnOutcomeNotice, type LinkByColumnOutcome } from './LinkByColumnDialog'

afterEach(() => {
  cleanup()
  Object.values(api).forEach(f => f.mockReset())
})

const report = (over: Partial<ParticipantLinkReport> = {}): ParticipantLinkReport => ({
  linked: 0, created: 0, matched: 0, skipped_missing: 0, skipped_duplicate: 0,
  skipped_conflict: 0, already_linked: 0, duplicate_values: [], ...over,
})

function mount() {
  const onClose = vi.fn()
  const onFinished = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  render(
    <QueryClientProvider client={qc}>
      <LinkByColumnDialog projectId={3} datasetId={11} columnId={49} columnLabel="id"
        onClose={onClose} onFinished={onFinished} />
    </QueryClientProvider>,
  )
  return { onClose, onFinished, invalidate }
}

const confirmButton = () => screen.getAllByRole('button').find(b => /^Link/.test(b.textContent ?? ''))!

describe('#1054 — the confirmation comes from the dry run', () => {
  it('cannot be confirmed until the plan has answered', async () => {
    let answer!: (r: ParticipantLinkReport) => void
    api.previewLinkByColumn.mockReturnValue(new Promise(r => { answer = r }))
    mount()
    expect(screen.getByText('Checking what linking by “id” would do…')).toBeInTheDocument()
    expect(confirmButton()).toBeDisabled()
    answer(report({ linked: 3, created: 2, matched: 1 }))
    await waitFor(() => expect(confirmButton()).toHaveTextContent('Link 3 records'))
    expect(confirmButton()).not.toBeDisabled()
    expect(api.previewLinkByColumn).toHaveBeenCalledWith(3, 11, 49)
    expect(api.linkByColumn).not.toHaveBeenCalled()
  })

  it('names what will be created and matched, what stays unlinked, and that there is no undo', async () => {
    api.previewLinkByColumn.mockResolvedValue(report({
      linked: 122382, created: 122380, matched: 2, skipped_duplicate: 4, duplicate_values: ['P1', 'P2'],
    }))
    mount()
    const dialog = await screen.findByRole('alertdialog')
    await waitFor(() => expect(dialog).toHaveAccessibleDescription(
      expect.stringContaining('This will link 122,382 records to participants by the IDs in “id”: '
        + '2 to participants already in this project, and 122,380 to new participants created from their IDs.'),
    ))
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining(
      '4 records will stay unlinked: 4 with an ID that appears more than once (P1, P2).'))
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining('There is no undo'))
  })

  it('refuses, with the reason, when there is nothing to link', async () => {
    api.previewLinkByColumn.mockResolvedValue(report({ already_linked: 40 }))
    mount()
    await screen.findByText('Every record is already linked to a participant — there is nothing to link.')
    const confirm = confirmButton()
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    expect(confirm).toHaveAccessibleName(expect.stringContaining('nothing to link'))
    fireEvent.click(confirm)
    expect(api.linkByColumn).not.toHaveBeenCalled()
  })
})

describe('#1054 — the act', () => {
  it('says the wait while it runs, then hands the report to the page and refreshes the link reads', async () => {
    api.previewLinkByColumn.mockResolvedValue(report({ linked: 2, created: 2 }))
    api.getProject.mockResolvedValue({ id: 3, participant_count: 5 })
    let finish!: (r: ParticipantLinkReport) => void
    api.linkByColumn.mockReturnValue(new Promise(r => { finish = r }))
    const { onFinished, onClose, invalidate } = mount()
    await waitFor(() => expect(confirmButton()).toHaveTextContent('Link 2 records'))
    fireEvent.click(confirmButton())
    expect(await screen.findByText('Linking records to participants…')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
      'Linking records to participants. Keep Mixed Measures open until this finishes.')
    // A second press while it runs sends nothing.
    fireEvent.click(screen.getAllByRole('button').find(b => b.textContent === 'Linking…')!)
    finish(report({ linked: 2, created: 2 }))
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({
      kind: 'linked', columnLabel: 'id', report: report({ linked: 2, created: 2 }), hadParticipants: true,
    }))
    expect(api.linkByColumn).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['linkable-rows', 3] })
  })

  it('a refusal is the server’s own sentence, and the reads are refreshed anyway', async () => {
    api.previewLinkByColumn.mockResolvedValue(report({ linked: 2, created: 2 }))
    api.getProject.mockResolvedValue({ id: 3, participant_count: 0 })
    const stopped = 'Linking stopped because the dataset kept changing while it was being linked; '
      + '5,000 records were linked before it stopped. Run Link by column again to finish.'
    api.linkByColumn.mockRejectedValue(Object.assign(new Error('Request failed'), {
      status: 409, response: { data: { detail: stopped } },
    }))
    const { onFinished, invalidate } = mount()
    await waitFor(() => expect(confirmButton()).toHaveTextContent('Link 2 records'))
    fireEvent.click(confirmButton())
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({ kind: 'failed', columnLabel: 'id', message: stopped }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['participants', 3] })
  })

  it('#1231: an error with no sentence never says the records could not be linked', async () => {
    api.previewLinkByColumn.mockResolvedValue(report({ linked: 12000, created: 12000 }))
    api.getProject.mockResolvedValue({ id: 3, participant_count: 0 })
    // What a server error answers: a status and a plain-text body, no `detail`.
    api.linkByColumn.mockRejectedValue(Object.assign(new Error('Request failed'), {
      status: 500, response: { data: 'Internal Server Error' },
    }))
    const { onFinished } = mount()
    await waitFor(() => expect(confirmButton()).toHaveTextContent('Link 12,000 records'))
    fireEvent.click(confirmButton())
    await waitFor(() => expect(onFinished).toHaveBeenCalled())
    const { message } = onFinished.mock.calls[0][0] as { message: string }
    expect(message).not.toMatch(/could not be linked/)
    expect(message).toMatch(/some records may already be linked/)
    expect(message).toMatch(/Running Link by column again finishes the rest\./)
  })
})

describe('#1054 — the result stays on the page', () => {
  it('a success is a status with the shared link note; a failure is an alert; both dismiss', () => {
    const onDismiss = vi.fn()
    const linked: LinkByColumnOutcome = {
      kind: 'linked', columnLabel: 'id', hadParticipants: false,
      report: report({ linked: 122382, created: 122380, matched: 2, skipped_missing: 1 }),
    }
    const { rerender } = render(<LinkByColumnOutcomeNotice outcome={linked} projectId={3} onDismiss={onDismiss} />)
    expect(screen.getByRole('status')).toHaveTextContent('Linked by “id”')
    // Driven live: the shared note printed "122382 new" beside "122,382 records linked".
    expect(screen.getByRole('status')).toHaveTextContent('122,382 records linked (122,380 new, 2 matched to existing)')
    expect(screen.getByRole('status')).toHaveTextContent('1 with a blank or N/A ID')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
    rerender(<LinkByColumnOutcomeNotice
      outcome={{ kind: 'failed', columnLabel: 'id', message: 'Run it again.' }} projectId={3} onDismiss={onDismiss} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Linking by “id” did not finish')
    expect(screen.getByRole('alert')).toHaveTextContent('Run it again.')
  })
})
