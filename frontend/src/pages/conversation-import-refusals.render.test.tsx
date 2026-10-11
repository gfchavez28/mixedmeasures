/**
 * #1127 — the transcript import says WHICH file the reader refused, and a refused
 * file stops the wizard.
 *
 * The reader's refusals got sharper in this batch ("Line 2 opens a value with a
 * quotation mark that is never closed…"), and this page was where they landed worst:
 * step 1 never named the file, a refused SECOND file did not block — its reason went
 * into a warning, the wizard went on to Speakers and the import sent it anyway — and
 * the step buttons went natively disabled, so the alert arrived with focus on <body>.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import type { OverlongRecords } from '@/lib/api'

const api = vi.hoisted(() => ({
  conversations: { list: vi.fn(), preview: vi.fn(), import: vi.fn() },
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

const SENTENCE = 'Line 2 opens a value with a quotation mark that is never closed, so everything after it would read as one value. Check the quotation marks on that line.'

const noOverlong: OverlongRecords = { count: 0, header_width: 2, examples: [] }
const preview = (overlong = noOverlong) => ({
  headers: ['Speaker', 'Text'],
  sample_rows: [{ Speaker: 'A', Text: 'hello' }],
  total_rows: 1,
  unique_speakers: ['A'],
  detected_columns: { speaker: 'Speaker', text: 'Text' },
  unique_values_by_column: { Speaker: ['A'], Text: ['hello'] },
  overlong_records: overlong,
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/1/conversations/import']}>
        <Routes><Route path="/projects/:projectId/conversations/import" element={<ConversationImport />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return utils
}

function choose(container: HTMLElement, names: string[]) {
  const files = names.map(n => new File(['Speaker,Text\nA,hello\n'], n, { type: 'text/csv' }))
  fireEvent.change(container.querySelector('#file-input')!, { target: { files } })
}

beforeEach(() => {
  Object.values(api.conversations).forEach(fn => fn.mockReset())
  api.participants.list.mockReset()
  api.conversations.list.mockResolvedValue({ conversations: [], total: 0 })
  api.participants.list.mockResolvedValue([])
})
afterEach(cleanup)

describe('#1127 — a refused transcript is named, and stops the wizard', () => {
  it('step 1: the refusal names the file when several are listed, with focus still on Next', async () => {
    let reject!: (e: Error) => void
    api.conversations.preview.mockReturnValue(new Promise((_r, rj) => { reject = rj }))
    const { container } = renderPage()
    choose(container, ['a.csv', 'b.csv'])
    const next = await screen.findByRole('button', { name: 'Next' })
    next.focus()
    fireEvent.click(next)
    // ("Select Files" reads "Processing..." too, so the button is held by reference.)
    await waitFor(() => expect(next).toHaveTextContent('Processing...'))
    const busy = next
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).not.toBeDisabled()
    fireEvent.click(busy)
    expect(api.conversations.preview).toHaveBeenCalledTimes(1)

    reject(new Error(SENTENCE))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(`“a.csv”: ${SENTENCE}`)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
  })

  it('a single file’s refusal is the sentence alone', async () => {
    api.conversations.preview.mockRejectedValue(new Error(SENTENCE))
    const { container } = renderPage()
    choose(container, ['a.csv'])
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(new RegExp(`^${SENTENCE.slice(0, 40)}`))
  })

  it('a refused SECOND file blocks Continue, is named with its sentence, and offers Remove', async () => {
    api.conversations.preview.mockImplementation((_pid: number, file: File) =>
      file.name === 'b.csv' ? Promise.reject(new Error(SENTENCE)) : Promise.resolve(preview()))
    const { container } = renderPage()
    choose(container, ['a.csv', 'b.csv'])
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(`“b.csv”: ${SENTENCE}`)
    expect(alert).toHaveTextContent('Remove that file below')
    // Still on the Columns step: it did NOT go on to Speakers.
    expect(screen.queryByText('Map Speakers')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove b.csv' })).toBeInTheDocument()
    expect(api.conversations.import).not.toHaveBeenCalled()
  })

  it('Continue stays focusable while it checks the other files, and refuses a second press', async () => {
    api.conversations.preview.mockImplementation((_pid: number, file: File) =>
      file.name === 'b.csv' ? new Promise(() => {}) : Promise.resolve(preview()))
    const { container } = renderPage()
    choose(container, ['a.csv', 'b.csv'])
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    const proceed = await screen.findByRole('button', { name: 'Continue' })
    fireEvent.click(proceed)
    await waitFor(() => expect(proceed).toHaveTextContent('Checking files...'))
    expect(proceed).toHaveAttribute('aria-disabled', 'true')
    expect(proceed).not.toBeDisabled()
    fireEvent.click(proceed)
    expect(api.conversations.preview).toHaveBeenCalledTimes(2)  // a.csv, then b.csv once
  })

  it('Import stays focusable while it imports, and refuses a second press', async () => {
    api.conversations.preview.mockResolvedValue(preview())
    api.conversations.import.mockReturnValue(new Promise(() => {}))
    const { container } = renderPage()
    choose(container, ['a.csv'])
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    const importButton = await screen.findByRole('button', { name: 'Import' })
    fireEvent.click(importButton)
    await waitFor(() => expect(importButton).toHaveTextContent('Importing...'))
    expect(importButton).toHaveAttribute('aria-disabled', 'true')
    expect(importButton).not.toBeDisabled()
    fireEvent.click(importButton)
    expect(api.conversations.import).toHaveBeenCalledTimes(1)
  })

  it('the control: a readable second file goes on to Speakers', async () => {
    api.conversations.preview.mockResolvedValue(preview())
    const { container } = renderPage()
    choose(container, ['a.csv', 'b.csv'])
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByText('Map Speakers')).toBeInTheDocument())
  })
})

describe('#1127 — rows an unquoted comma split are said before the import', () => {
  it('names the line and the counts', async () => {
    api.conversations.preview.mockResolvedValue(preview({
      count: 1, header_width: 2, examples: [{ record: 1, line: 2, cells: 4, row_id: null }],
    }))
    const { container } = renderPage()
    choose(container, ['a.csv'])
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent('Some rows have more values than the file has column headings.')
    expect(note).toHaveTextContent('Line 2 — 4 values for 2 columns')
  })

  it('says nothing for a file without such rows', async () => {
    api.conversations.preview.mockResolvedValue(preview())
    const { container } = renderPage()
    choose(container, ['a.csv'])
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByRole('button', { name: 'Continue' })
    expect(screen.queryByText(/more values than the file has column headings/)).not.toBeInTheDocument()
  })
})
