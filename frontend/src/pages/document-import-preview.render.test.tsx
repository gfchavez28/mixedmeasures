/**
 * #1494 — Document Import previews the FIRST file only, so with several files the
 * preview, and the omission notice under it (#1318, new in 1.5.8), must say which
 * file they describe and what happens to the others.
 *
 * Before: *"Preview (35 segments)"* and *"Some of this document was not imported: 1
 * table…"* with two files chosen — the second file's omissions appeared only on the
 * Results step, after the import, while the notice's own remedy is "move them into
 * the main text … and import again". The per-file preview is #1494's other half.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import type { SegmentationPreviewResponse } from '@/lib/api'

const api = vi.hoisted(() => ({ uploadPreview: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, documentsApi: { ...actual.documentsApi, uploadPreview: api.uploadPreview } }
})
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1, setBreadcrumbLabel: () => {} }),
}))

import DocumentImport from './DocumentImport'

const PREVIEW: SegmentationPreviewResponse = {
  total_segments: 2,
  segments: [
    { sequence_order: 0, text: 'First paragraph.', page_number: null, heading_level: null, word_count: 2 },
    { sequence_order: 1, text: 'Second paragraph.', page_number: null, heading_level: null, word_count: 2 },
  ],
  warnings: ['Some of this document was not imported: 1 table.'],
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/1/documents/import']}>
        <Routes><Route path="/projects/:projectId/documents/import" element={<DocumentImport />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return view
}

const docx = (name: string) => new File(['x'], name, {
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
})

function chooseAndContinue(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files } })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
}

beforeEach(() => { api.uploadPreview.mockResolvedValue(PREVIEW) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#1494 — the preview says whose it is', () => {
  it('with two files: the heading names the first, and a sentence accounts for the other', async () => {
    const { container } = renderPage()
    chooseAndContinue(container, [docx('policy_harmon.docx'), docx('questionnaire.docx')])
    expect(await screen.findByRole('heading', { name: 'Preview (2 segments — policy_harmon.docx)' }))
      .toBeInTheDocument()
    expect(api.uploadPreview.mock.calls[0][1].name).toBe('policy_harmon.docx')
    expect(screen.getByText('Some of this document was not imported: 1 table.')).toBeInTheDocument()
    expect(screen.getByText(
      'The other file is read when it is imported, and the Results step lists anything left out of it.',
    )).toBeInTheDocument()
  })

  it('with three files: the sentence counts the others', async () => {
    const { container } = renderPage()
    chooseAndContinue(container, [docx('a.docx'), docx('b.docx'), docx('c.docx')])
    expect(await screen.findByRole('heading', { name: 'Preview (2 segments — a.docx)' })).toBeInTheDocument()
    expect(screen.getByText(/^The other 2 files are read when they are imported/)).toBeInTheDocument()
  })

  it('with one file: no name and no sentence — the preview is the whole import', async () => {
    const { container } = renderPage()
    chooseAndContinue(container, [docx('policy_harmon.docx')])
    expect(await screen.findByRole('heading', { name: 'Preview (2 segments)' })).toBeInTheDocument()
    expect(screen.queryByText(/The other/)).not.toBeInTheDocument()
  })
})
