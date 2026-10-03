/**
 * #1102 — the dataset import's note for values a column's scale does not hold.
 *
 * It said such values would "import blank" and were "Likely typos". Both were
 * wrong: the TEXT is kept (only the number is missing, so statistics leave the
 * answer out), and the value it most often named was a real answer — the
 * midpoint of a five-point scale the matcher had mis-sized. The server now
 * reports only values no known scale accounts for, and the note states the
 * consequence without guessing the cause. Rendered through the wizard, because
 * the note depends on the preview crossing the wire and on the column's
 * effective type.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'

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

const ordinal = (i: number, name: string, unmatched: string[] | null) => ({
  column_name: name, column_index: i, sample_values: ['Agree'], unique_count: 5,
  empty_count: 0, empty_percent: 0, na_count: 0, all_numeric: false,
  avg_text_length: 8, suggested_type: 'ordinal', suggested_scale_name: 'agreement-4pt',
  suggested_scale_labels: ['Strongly Disagree', 'Disagree', 'Agree', 'Strongly Agree'],
  suggested_scale_values: null, suggested_scale_unmatched: unmatched,
  distinct_numeric_values: null, suggested_column_code: null, suggested_group_code: null,
  suggested_column_text: name, suggested_column_name: null,
  suggested_demographic_subtype: null, numeric_format: null,
  numeric_min: null, numeric_max: null,
})

const preview = (columns: ReturnType<typeof ordinal>[]) => ({
  total_rows: 5,
  columns,
  sheet_names: null,
  overlong_records: { count: 0, header_width: columns.length, examples: [] },
})

async function openConfigure() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/1/datasets/import']}>
        <Routes><Route path="/projects/:projectId/datasets/import" element={<DatasetImport />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const file = new File(['Q1\n'], 'survey.csv', { type: 'text/csv' })
  fireEvent.change(container.querySelector('#dataset-file-input')!, { target: { files: [file] } })
  fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
  await screen.findByRole('button', { name: 'Import Dataset' })
}

const scaleNotes = () =>
  screen.queryAllByRole('note').filter(n => /on the .*scale/.test(n.textContent ?? ''))

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset())
  api.list.mockResolvedValue({ datasets: [], total: 0 })
})
afterEach(cleanup)

describe('the unmatched-scale-values note (#1102)', () => {
  it('states the consequence for one value, and guesses no cause', async () => {
    api.preview.mockResolvedValue(preview([ordinal(0, 'Q1', ['Neither agree or disagree'])]))
    await openConfigure()
    const [note] = scaleNotes()
    expect(note).toHaveTextContent(
      '1 value is not on the “agreement-4pt” scale, so it will import without a number ' +
      'and statistics will leave it out: “Neither agree or disagree”. ' +
      'Correct it in the file, or change the column type.',
    )
    expect(note).not.toHaveTextContent(/blank|typo/i)
  })

  it('names three values, counts the rest, and speaks in the plural', async () => {
    api.preview.mockResolvedValue(preview([ordinal(0, 'Q1', ['A', 'B', 'C', 'D', 'E'])]))
    await openConfigure()
    const [note] = scaleNotes()
    expect(note).toHaveTextContent(
      '5 values are not on the “agreement-4pt” scale, so they will import without a number ' +
      'and statistics will leave them out: “A”, “B”, “C”, +2 more. ' +
      'Correct them in the file, or change the column type.',
    )
  })

  it('is silent for a clean column, and once the column is no longer a scale', async () => {
    api.preview.mockResolvedValue(preview([
      ordinal(0, 'Clean', null),
      ordinal(1, 'Stray', ['Neither agree or disagree']),
    ]))
    await openConfigure()
    // The positive control: exactly the column with a stray has a note.
    expect(scaleNotes()).toHaveLength(1)
    fireEvent.change(screen.getByRole('combobox', { name: 'Column type for Stray' }), {
      target: { value: 'nominal' },
    })
    expect(scaleNotes()).toHaveLength(0)
    // The clean column's row never carried one.
    const cleanRow = screen.getByRole('combobox', { name: 'Column type for Clean' }).closest('div')!
    expect(within(cleanRow).queryByRole('note')).toBeNull()
  })
})
