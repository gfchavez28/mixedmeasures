/**
 * The Data grid says where a row sits in the WHOLE dataset (10-19 pending
 * decisions, row 19).
 *
 * #800 made the grid render one PAGE (200 records), so on page 3 the DOM holds
 * records 401–600 of 75,699 and a screen reader would count "row 1 of 201". The
 * table declares `aria-rowcount` (the records plus the header row) and each row
 * its `aria-rowindex` — 1-based, header first, as `VariablePropertiesGrid` and
 * `ReconciliationGrid` count it — and ONLY when there is more than one page,
 * because a reader counts a set the DOM holds by itself (#758/#772's boundary).
 *
 * ⚠️ The row half is a render; the table half is a SOURCE fact (jsdom cannot
 * mount `DatasetView` here), checked as one, after `stripComments`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/theme-context', () => ({ useTheme: () => ({ isDark: false }) }))
import { render, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { stripComments } from '@/lib/strip-comments'
import { DataRow } from '@/components/DatasetGridComponents'
import type { DatasetColumn, DatasetDataRow } from '@/lib/api'

const COLUMN = {
  id: 905, dataset_id: 1, column_code: null, group_code: null, group_label: null,
  column_name: 'Pre', column_text: 'Pre', column_type: 'numeric',
  sequence_order: 1, display_order: 1, scale_labels: null, scale_values: null,
  scale_points: null, numeric_min: null, numeric_max: null, numeric_format: null,
  missing_values: null, source: 'manual', expression: null, depends_on_column_ids: null,
  stale: false, managed_spec: null, demographic_subtype: null,
  equivalence_group_id: null, equivalence_group_label: null,
  show_in_participant_profile: false, recode_definitions: [], primary_recode: null,
} as unknown as DatasetColumn

const ROW: DatasetDataRow = {
  id: 70, participant_id: null, participant_display_name: null,
  row_identifier: 'R70', submitted_at: null,
  values: { '905': { id: 701, value_text: '1', value_numeric: 1 } },
} as unknown as DatasetDataRow

function renderRow(rowIndex: number, declareRowPosition: boolean | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <table>
          <tbody>
            <DataRow
              row={ROW}
              rowIndex={rowIndex}
              columns={[COLUMN]}
              activeDefinitions={{}}
              onOpenText={vi.fn()}
              projectId={1}
              linkedParticipantMap={new Map()}
              onLink={vi.fn()}
              selectedCell={null}
              onCellSelect={vi.fn()}
              editingCell={null}
              onStartEdit={vi.fn()}
              onCellSave={vi.fn()}
              onCellCancel={vi.fn()}
              onTabNav={vi.fn()}
              onEnterNav={vi.fn()}
              onDeleteRow={vi.fn()}
              declareRowPosition={declareRowPosition}
            />
          </tbody>
        </table>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return document.querySelector('tr[data-row-id="70"]')!
}

afterEach(cleanup)

describe('a paged grid row declares its place in the whole dataset', () => {
  it('record 401 (dataset index 400, the first row of page 3) is row 402 — the header is row 1', () => {
    expect(renderRow(400, true)).toHaveAttribute('aria-rowindex', '402')
  })

  it('control: a grid that holds every record declares nothing', () => {
    expect(renderRow(400, false)).not.toHaveAttribute('aria-rowindex')
    cleanup()
    expect(renderRow(400, undefined)).not.toHaveAttribute('aria-rowindex')
  })

  it('a row already on screen gains its place when the grid becomes paged', () => {
    // A 200-record dataset gaining record 201 flips `hasPaging` while React
    // Query's structural sharing keeps every unchanged row's object, so only
    // the memo comparator's `declareRowPosition` line re-renders page 1's rows
    // (a mutant deleting it survived every other test, Batch 10 build).
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const columns = [COLUMN]
    const defs = {}
    const linked = new Map<number, string>()
    const fns = {
      onOpenText: vi.fn(), onLink: vi.fn(), onCellSelect: vi.fn(), onStartEdit: vi.fn(),
      onCellSave: vi.fn(), onCellCancel: vi.fn(), onTabNav: vi.fn(), onEnterNav: vi.fn(),
      onDeleteRow: vi.fn(),
    }
    const tree = (declare: boolean) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <table>
            <tbody>
              <DataRow
                row={ROW}
                rowIndex={0}
                columns={columns}
                activeDefinitions={defs}
                projectId={1}
                linkedParticipantMap={linked}
                selectedCell={null}
                editingCell={null}
                {...fns}
                declareRowPosition={declare}
              />
            </tbody>
          </table>
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(tree(false))
    expect(document.querySelector('tr[data-row-id="70"]')).not.toHaveAttribute('aria-rowindex')
    rerender(tree(true))
    expect(document.querySelector('tr[data-row-id="70"]')).toHaveAttribute('aria-rowindex', '2')
  })
})

describe('the table declares the whole set, only when it is paged', () => {
  const view = stripComments(readFileSync(join(__dirname, 'DatasetView.tsx'), 'utf8'))

  it('self-check: the scan sees the grid table', () => {
    expect(view).toContain('onKeyDown={handleGridKeyDown}')
  })

  it('aria-rowcount counts the records AND the header row, gated on paging', () => {
    expect(view).toContain('aria-rowcount={hasPaging ? totalRows + 1 : undefined}')
  })

  it('the header row is row 1 under the same gate', () => {
    expect(view).toMatch(/<tr className="bg-mm-bg border-b" aria-rowindex=\{hasPaging \? 1 : undefined\}>/)
  })

  it('the body is told the same gate', () => {
    expect(view).toContain('declareRowPositions={hasPaging}')
  })
})
