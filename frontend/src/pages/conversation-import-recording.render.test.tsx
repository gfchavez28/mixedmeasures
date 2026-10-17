/**
 * #1161 — the transcript wizard's RECORDING slot runs the one file check.
 *
 * It ran `validateMediaFile`, which checked size before type and named no file
 * ("Accepted formats: …" under a slot the researcher had just dropped two files
 * on), and its drop kept `files[0]` and left the rest in silence.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'

const api = vi.hoisted(() => ({
  conversations: { list: vi.fn() },
  participants: { list: vi.fn() },
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    conversationsApi: { ...actual.conversationsApi, ...api.conversations },
    participantsApi: { ...actual.participantsApi, ...api.participants },
  }
})
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ setBreadcrumbLabel: () => {} }),
}))

import ConversationImport from './ConversationImport'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/1/conversations/import']}>
        <Routes><Route path="/projects/:projectId/conversations/import" element={<ConversationImport />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rec = (name: string, size = 10) => {
  const f = new File(['x'], name, { type: '' })
  Object.defineProperty(f, 'size', { value: size, configurable: true })
  return f
}
const slot = () => screen.getByText(/Add the audio or video this transcript came from/).closest('div') as HTMLElement

beforeEach(() => {
  api.conversations.list.mockResolvedValue({ conversations: [], total: 0 })
  api.participants.list.mockResolvedValue([])
})
afterEach(cleanup)

describe('#1161 — the recording slot', () => {
  it('a two-file drop stages the first and names the second in an alert', () => {
    renderPage()
    fireEvent.drop(slot(), { dataTransfer: { files: [rec('a.mp4'), rec('b.mov')] } })
    expect(screen.getByText('a.mp4')).toBeInTheDocument()
    // (A second alert offers Observations — a recording with no transcript yet.)
    const said = screen.getAllByRole('alert').filter(a => /Only one recording/.test(a.textContent ?? ''))
    expect(said).toHaveLength(1)
    expect(said[0]).toHaveTextContent('Only one recording can be added — “b.mov” was not added.')
  })

  it('a picked wrong file is named, and the sentence says what a recording may be', () => {
    const { container } = renderPage()
    fireEvent.change(container.querySelector('#recording-input')!, { target: { files: [rec('notes.pdf')] } })
    expect(screen.getByRole('alert')).toHaveTextContent(
      '“notes.pdf” is not a recording file. A recording can be MP3, M4A, WAV audio; MP4, MOV, WebM video.')
  })

  it('the note before any file is chosen spells the limit the refusal does — "4 GB", not "4.0 GB"', () => {
    renderPage()
    expect(screen.getByText(/recordings can be up to 4 GB\.$/)).toBeInTheDocument()
  })

  it('a picked oversized recording is named with its size and the limit as "4 GB"', () => {
    const { container } = renderPage()
    fireEvent.change(container.querySelector('#recording-input')!, {
      target: { files: [rec('long.mp4', 4 * 1024 ** 3 + 1)] },
    })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('“long.mp4” (4.0 GB) was not added.')
    expect(alert).toHaveTextContent('files of 4 GB or smaller')
  })
})
