/**
 * Row 46 — the "this document is about…" picker.
 *
 * The assertion that matters most here is the CLEAR path. `participant_id: null`
 * is a meaningful value on the PATCH (it unlinks), not an absence, so the dialog
 * has to offer it as an explicit choice — a researcher cannot deselect their way
 * out of a list of radio-like rows, and the backend distinguishes an omitted key
 * from an explicit null on purpose.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import DocumentSubjectDialog from './DocumentSubjectDialog'

const listParticipants = vi.fn()

vi.mock('@/lib/api', () => ({
  participantsApi: {
    list: (...args: unknown[]) => listParticipants(...args),
  },
}))

afterEach(() => {
  cleanup()
  listParticipants.mockReset()
})

function participant(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    project_id: 1,
    identifier: `P00${id}`,
    display_name: null,
    role: null,
    demographics: null,
    role_auto_filled_from: null,
    created_at: '',
    updated_at: '',
    linked_speakers: [],
    dataset_rows: [],
    linked_documents: [],
    ...over,
  }
}

function renderDialog(
  onChoose = vi.fn(),
  participantId: number | null = null,
  participants = [
    participant(1, { display_name: 'Ada Chen', role: 'Communications' }),
    participant(2, { display_name: 'Bo Ruiz', role: 'Finance' }),
  ],
) {
  listParticipants.mockResolvedValue({ participants, total: participants.length })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DocumentSubjectDialog
        open
        projectId={1}
        documentName="Workplan 2026"
        participantId={participantId}
        onClose={vi.fn()}
        onChoose={onChoose}
      />
    </QueryClientProvider>,
  )
  return onChoose
}

describe('DocumentSubjectDialog', () => {
  it('hands back BOTH halves of the value when a participant is picked', async () => {
    // The id is what the PATCH sends and the label is the only half that can be
    // rendered — a caller given one would have to fetch or guess the other.
    const onChoose = renderDialog()
    const row = await screen.findByRole('button', { name: /Ada Chen/ })
    fireEvent.click(row)
    expect(onChoose).toHaveBeenCalledWith(1, 'Ada Chen')
  })

  it('offers an explicit clear, and sends null for it', async () => {
    const onChoose = renderDialog(vi.fn(), 1)
    await screen.findByRole('button', { name: /Ada Chen/ })
    fireEvent.click(screen.getByRole('button', { name: /Not about a specific subject/ }))
    expect(onChoose).toHaveBeenCalledWith(null, null)
  })

  it('falls back to the identifier when a participant has no display name', async () => {
    // Mirrors the backend's `display_name or identifier`, so the label the user
    // picks matches the one the card will show after the write.
    const onChoose = renderDialog(vi.fn(), null, [participant(7)])
    const row = await screen.findByRole('button', { name: /P007/ })
    fireEvent.click(row)
    expect(onChoose).toHaveBeenCalledWith(7, 'P007')
  })

  it('filters by name, identifier and role', async () => {
    renderDialog()
    await screen.findByRole('button', { name: /Ada Chen/ })
    const search = screen.getByRole('textbox', { name: 'Search participants' })

    fireEvent.change(search, { target: { value: 'finance' } })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Ada Chen/ })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Bo Ruiz/ })).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'P002' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Bo Ruiz/ })).toBeInTheDocument()
    })
  })

  it('keeps the clear option reachable while a search excludes everything', async () => {
    // The filter narrows the PARTICIPANTS; unlinking is not a participant, and a
    // search that matches nothing must not strand the researcher.
    renderDialog()
    await screen.findByRole('button', { name: /Ada Chen/ })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search participants' }), {
      target: { value: 'zzzz' },
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Ada Chen/ })).not.toBeInTheDocument()
    })
    expect(
      screen.getByRole('button', { name: /Not about a specific subject/ }),
    ).toBeInTheDocument()
  })

  it('names where to add participants when the project has none', async () => {
    // The remedy is on a different screen and nothing on this one would say so
    // — the empty state IS the feature here (the #830f rule).
    renderDialog(vi.fn(), null, [])
    expect(await screen.findByText(/no participants yet/i)).toBeInTheDocument()
    expect(screen.getByText(/Participants page/)).toBeInTheDocument()
  })

  it('does not fetch participants while it is closed', () => {
    listParticipants.mockResolvedValue({ participants: [], total: 0 })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <DocumentSubjectDialog
          open={false}
          projectId={1}
          documentName="Workplan 2026"
          participantId={null}
          onClose={vi.fn()}
          onChoose={vi.fn()}
        />
      </QueryClientProvider>,
    )
    expect(listParticipants).not.toHaveBeenCalled()
  })
})
