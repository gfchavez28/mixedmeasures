/**
 * #1127 — Append's refusal names the file, and Select File stays focusable while
 * the file is read.
 *
 * The upload step shows no file name, so a "Line 4 …" refusal did not say which
 * file it was about; and *Select File* went natively disabled while reading — focus
 * returns there from the file picker, so a refused file's alert arrived with focus
 * on <body> (#1133's class).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ApiError } from '@/lib/api/client'

const api = vi.hoisted(() => ({ get: vi.fn(), appendPreview: vi.fn(), appendImport: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, datasetsApi: { ...actual.datasetsApi, ...api } }
})
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ setBreadcrumbLabel: () => {} }),
}))

import AppendImport from './AppendImport'

const SENTENCE = 'Line 4 opens a value with a quotation mark that is never closed.'

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset())
  api.get.mockResolvedValue({ id: 2, name: 'Survey', managed_kind: null })
})
afterEach(cleanup)

describe('#1127 — Append names the refused file', () => {
  it('the alert names the file, and Select File stays focusable while it reads', async () => {
    let reject!: (e: unknown) => void
    api.appendPreview.mockReturnValue(new Promise((_r, rj) => { reject = rj }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/projects/1/datasets/2/append']}>
          <Routes><Route path="/projects/:projectId/datasets/:datasetId/append" element={<AppendImport />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const select = await screen.findByRole('button', { name: 'Select File' })
    select.focus()
    fireEvent.change(container.querySelector('#append-file-input')!, {
      target: { files: [new File(['a,b\n1,2\n'], 'wave2.csv')] },
    })
    await waitFor(() => expect(select).toHaveTextContent('Analyzing...'))
    expect(select).toHaveAttribute('aria-disabled', 'true')
    expect(select).toHaveAttribute('aria-busy', 'true')
    expect(select).not.toBeDisabled()

    reject(new ApiError(400, { detail: SENTENCE }, {}))
    expect(await screen.findByRole('alert')).toHaveTextContent(`“wave2.csv”: ${SENTENCE}`)
    expect(document.activeElement).toBe(select)
  })
})

describe('#1127 — Append N Responses stays focusable while it appends', () => {
  it('busy, not disabled, and a second press is refused', async () => {
    api.appendPreview.mockResolvedValue({
      matched_columns: [{ csv_column_name: 'a', csv_column_index: 0, column_id: 5, column_code: null,
        column_text: 'a', column_type: 'numeric', match_method: 'text' }],
      unmatched_csv_columns: [], unmatched_columns: [],
      total_rows: 2, duplicate_count: 0, in_file_duplicate_count: 0,
      preview_rows: [], next_row_id: 'R0003', row_pad_width: 4,
      overlong_records: { count: 0, header_width: 1, examples: [] },
    })
    api.appendImport.mockReturnValue(new Promise(() => {}))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/projects/1/datasets/2/append']}>
          <Routes><Route path="/projects/:projectId/datasets/:datasetId/append" element={<AppendImport />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByRole('button', { name: 'Select File' })
    fireEvent.change(container.querySelector('#append-file-input')!, {
      target: { files: [new File(['a\n1\n2\n'], 'wave2.csv')] },
    })
    const append = await screen.findByRole('button', { name: 'Append 2 Responses' })
    fireEvent.click(append)
    await waitFor(() => expect(append).toHaveTextContent('Importing...'))
    expect(append).toHaveAttribute('aria-disabled', 'true')
    expect(append).not.toBeDisabled()
    fireEvent.click(append)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(api.appendImport).toHaveBeenCalledTimes(1)
  })
})
