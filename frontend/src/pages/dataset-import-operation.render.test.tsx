/**
 * #1010 (i) — the Dataset Import says what is RUNNING, and how long THAT takes.
 *
 * The estimate and the button's word were chosen by STEP. The import announced
 * the PREVIEW's estimate (about a third of the import's, #796b's own warning),
 * and a worksheet change on the configure step — a preview — read "Importing…"
 * with the import's fill and estimate.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { estimatedProcessingSeconds, SLOW_UPLOAD_THRESHOLD_BYTES } from '@/lib/dataset-import-formats'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  import: vi.fn(),
  describeColumns: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, datasetsApi: { ...actual.datasetsApi, ...api } }
})
vi.mock('@/lib/participant-snapshot', () => ({
  projectHadParticipants: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ setBreadcrumbLabel: () => {} }),
}))

import DatasetImport from './DatasetImport'

const column = {
  column_name: 'Q1', column_index: 0, sample_values: ['3'], unique_count: 5,
  empty_count: 0, empty_percent: 0, na_count: 0, all_numeric: true,
  avg_text_length: 1, suggested_type: 'numeric', suggested_scale_name: null,
  suggested_scale_labels: null, suggested_scale_values: null, suggested_scale_unmatched: null,
  distinct_numeric_values: null, suggested_column_code: null, suggested_group_code: null,
  suggested_column_text: 'Q1', suggested_column_name: null,
  suggested_demographic_subtype: null, numeric_format: null,
  numeric_min: 1, numeric_max: 5,
}

const preview = (sheetNames: string[] | null = null) => ({
  total_rows: 5,
  columns: [column],
  sheet_names: sheetNames,
  overlong_records: { count: 0, header_width: 1, examples: [] },
})

/** A file past the slow threshold, without allocating its bytes. */
function bigFile(name: string): File {
  const file = new File(['Q1\n3\n'], name)
  Object.defineProperty(file, 'size', { value: SLOW_UPLOAD_THRESHOLD_BYTES * 3 })
  return file
}

async function openConfigure(file: File) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/1/datasets/import']}>
        <Routes><Route path="/projects/:projectId/datasets/import" element={<DatasetImport />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.change(container.querySelector('#dataset-file-input')!, { target: { files: [file] } })
  fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
  await screen.findByRole('button', { name: 'Import Dataset' })
}

const status = () => document.querySelector('[role="status"][aria-live="polite"].sr-only')!

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset())
  api.list.mockResolvedValue({ datasets: [], total: 0 })
})
afterEach(cleanup)

describe('#1010 (i) — the wizard names the operation that is running', () => {
  it('a large IMPORT announces the import’s estimate, not the preview’s', async () => {
    const file = bigFile('big.csv')
    api.preview.mockResolvedValue(preview())
    api.import.mockReturnValue(new Promise(() => {}))
    await openConfigure(file)
    fireEvent.click(screen.getByRole('button', { name: 'Import Dataset' }))
    const importEstimate = estimatedProcessingSeconds(file.size, 'import')
    // The two must differ, or this proves nothing about which was quoted.
    expect(importEstimate).not.toBe(estimatedProcessingSeconds(file.size, 'preview'))
    await waitFor(() => expect(status()).toHaveTextContent(
      `Importing. This is a large file and may take around ${importEstimate} seconds.`,
    ))
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeInTheDocument()
  })

  it('#1133: step 1’s Next stays FOCUSABLE while it reads — busy, not disabled — and refuses a second press', async () => {
    api.preview.mockReturnValue(new Promise(() => {}))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/projects/1/datasets/import']}>
          <Routes><Route path="/projects/:projectId/datasets/import" element={<DatasetImport />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.change(container.querySelector('#dataset-file-input')!, { target: { files: [new File(['Q1\n3\n'], 'a.csv')] } })
    const next = await screen.findByRole('button', { name: 'Next' })
    next.focus()
    fireEvent.click(next)
    const busy = await screen.findByRole('button', { name: 'Reading…' })
    expect(busy).toBe(next)
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).not.toBeDisabled()
    expect(document.activeElement).toBe(busy)
    fireEvent.click(busy)
    expect(api.preview).toHaveBeenCalledTimes(1)
  })

  it('#1133: a file the reader refuses leaves focus on Next, and the status names no direction', async () => {
    api.preview.mockRejectedValue(Object.assign(new Error('bad'), {
      response: { status: 400, data: { detail: 'Line 3 holds a value longer than 131,072 characters.' } },
    }))
    api.describeColumns.mockRejectedValue(new Error('still bad'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/projects/1/datasets/import']}>
          <Routes><Route path="/projects/:projectId/datasets/import" element={<DatasetImport />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.change(container.querySelector('#dataset-file-input')!, { target: { files: [new File(['x'], 'q.csv')] } })
    const next = await screen.findByRole('button', { name: 'Next' })
    next.focus()
    fireEvent.click(next)
    await screen.findByRole('alert')
    await waitFor(() => expect(status()).toHaveTextContent('The file could not be read.'))
    expect(status()).not.toHaveTextContent(/above|Import failed/)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
  })

  it('a worksheet change on the configure step reads "Reading…", never "Importing…"', async () => {
    api.preview.mockResolvedValueOnce(preview(['Wave 1', 'Wave 2']))
    api.preview.mockReturnValueOnce(new Promise(() => {}))
    await openConfigure(new File(['Q1\n3\n'], 'waves.xlsx'))
    fireEvent.change(screen.getByLabelText('Worksheet'), { target: { value: 'Wave 2' } })
    expect(await screen.findByRole('button', { name: 'Reading…' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Importing…' })).toBeNull()
  })
})
