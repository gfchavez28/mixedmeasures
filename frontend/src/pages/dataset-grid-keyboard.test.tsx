/**
 * The Data grid's keyboard entry point (#946) — the half the DOM can show.
 *
 * The arithmetic is `lib/dataset-grid-nav.test.ts`. This file renders real rows
 * and asserts what a keyboard user actually meets: exactly one tab stop, focus
 * that selects, and a stop that exists before anything is selected.
 *
 * ⚠️ **The scan at the bottom covers what a render CANNOT.** `EditableCell`
 * returns six display `<td>` branches and a fixture reaches only the branches
 * its data produces — so "every branch carries the tab stop" is a claim about
 * source, not about this render, and it is checked as one. That split is
 * deliberate: a render test that silently covered two branches while claiming
 * six would be the instrument-blindness shape (#954's class).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// `EditableCell` reads only `isDark` for its ordinal gradient. Mocking the hook
// beats installing a `matchMedia` stub for the real provider: jsdom has none,
// and the theme is not what this file is about.
vi.mock('@/lib/theme-context', () => ({ useTheme: () => ({ isDark: false }) }))
import { render, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { stripComments } from '@/lib/strip-comments'
import { nextGridCoord, rovingStop } from '@/lib/dataset-grid-nav'
import { DataRow } from '@/components/DatasetGridComponents'
import type { DatasetColumn, DatasetDataRow } from '@/lib/api'

const SRC = join(__dirname, '..')

const col = (id: number, name: string, source: 'manual' | 'imported'): DatasetColumn => ({
  id, dataset_id: 1, column_code: null, group_code: null, group_label: null,
  column_name: name, column_text: name, column_type: 'numeric',
  sequence_order: id, display_order: id, scale_labels: null, scale_values: null,
  scale_points: null, numeric_min: null, numeric_max: null, numeric_format: null,
  missing_values: null, source, expression: null, depends_on_column_ids: null,
  stale: false, managed_spec: null, demographic_subtype: null,
  equivalence_group_id: null, equivalence_group_label: null,
  show_in_participant_profile: false, recode_definitions: [], primary_recode: null,
} as unknown as DatasetColumn)

const COLUMNS = [col(905, 'Pre', 'manual'), col(906, 'Post', 'manual')]

const row = (id: number, a: number, b: number): DatasetDataRow => ({
  id, participant_id: null, participant_display_name: null,
  row_identifier: `R${id}`, submitted_at: null,
  values: {
    '905': { id: id * 10 + 1, value_text: String(a), value_numeric: a },
    '906': { id: id * 10 + 2, value_text: String(b), value_numeric: b },
  },
})

const ROWS = [row(70, 1, 2), row(71, 3, 4)]

function renderGrid(selected: { rowId: number; columnId: number } | null) {
  const onCellSelect = vi.fn()
  const rowIds = ROWS.map(r => r.id)
  const columnIds = COLUMNS.map(c => c.id)
  const roving = rovingStop(selected, rowIds, columnIds)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <table>
          <tbody>
            {ROWS.map((r, i) => (
              <DataRow
                key={r.id}
                row={r}
                rowIndex={i}
                columns={COLUMNS}
                activeDefinitions={{}}
                onOpenText={vi.fn()}
                projectId={1}
                linkedParticipantMap={new Map()}
                onLink={vi.fn()}
                selectedCell={selected}
                rovingCell={roving}
                onCellSelect={onCellSelect}
                editingCell={null}
                onStartEdit={vi.fn()}
                onCellSave={vi.fn()}
                onCellCancel={vi.fn()}
                onTabNav={vi.fn()}
                onEnterNav={vi.fn()}
                onDeleteRow={vi.fn()}
              />
            ))}
          </tbody>
        </table>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onCellSelect }
}

/** The data cells, in DOM order. Excludes the record `<th>` and the participant cell. */
function dataCells(): HTMLTableCellElement[] {
  return Array.from(document.querySelectorAll<HTMLTableCellElement>('td'))
    .filter(td => td.hasAttribute('tabindex'))
}

afterEach(cleanup)

describe('#946 — the grid has exactly one tab stop', () => {
  it('every data cell is focusable and exactly ONE is in the tab order', () => {
    renderGrid({ rowId: 71, columnId: 906 })
    const cells = dataCells()
    // Population self-check: four data cells (2 rows x 2 columns). Without it a
    // fixture that rendered nothing would satisfy "exactly one is 0" vacuously.
    expect(cells).toHaveLength(4)
    const stops = cells.filter(c => c.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
    expect(cells.filter(c => c.getAttribute('tabindex') === '-1')).toHaveLength(3)
  })

  it('🔴 there is a tab stop BEFORE anything is selected', () => {
    // The failure this prevents is total: derive the stop from the selection
    // alone and a freshly loaded grid has no tabbable cell, so no key can ever
    // reach it, so nothing can ever become selected (#701a's closed loop).
    renderGrid(null)
    expect(dataCells().filter(c => c.getAttribute('tabindex') === '0')).toHaveLength(1)
  })

  it('the stop is the FIRST cell when nothing is selected', () => {
    renderGrid(null)
    expect(dataCells()[0].getAttribute('tabindex')).toBe('0')
  })

  it('the stop follows the selection when there is one', () => {
    renderGrid({ rowId: 71, columnId: 906 })
    // Row 71 is the second row; column 906 the second column — the last cell.
    expect(dataCells()[3].getAttribute('tabindex')).toBe('0')
  })

  it('the record header and the participant cell are NOT tab stops', () => {
    renderGrid(null)
    // They are not selectable cells today and must not become so: the header is
    // a `<th scope="row">` whose job is to NAME the row for every cell in it.
    expect(document.querySelector('th[scope="row"]')).not.toHaveAttribute('tabindex')
    const untabbable = Array.from(document.querySelectorAll('td'))
      .filter(td => !td.hasAttribute('tabindex'))
    expect(untabbable.length).toBeGreaterThan(0)
  })
})

describe('#946 — focus selects', () => {
  it('focusing a cell selects it, which is what makes F2 work after tabbing in', () => {
    const { onCellSelect } = renderGrid(null)
    dataCells()[2].focus()
    fireEvent.focus(dataCells()[2])
    expect(onCellSelect).toHaveBeenCalledWith(71, 905)
  })

  it('the selected cell carries the selection ring and the unselected ones do not', () => {
    // ⚠️ Matched on `ring-ring/50`, NOT on `ring-2`. The focus ring is spelled
    // `focus-visible:ring-2`, so a `ring-2` assertion is true of EVERY cell and
    // cannot tell selection from focus — it passed on the unselected cell,
    // which is how it was caught.
    renderGrid({ rowId: 70, columnId: 905 })
    const cells = dataCells()
    expect(cells[0].className).toContain('ring-ring/50')
    expect(cells[1].className).not.toContain('ring-ring/50')
  })

  it('a cell carries the shared FOCUS ring, which is a different fact', () => {
    // `lib/selection.ts`: selection is the blue tint recipe, focus is the green
    // ring, and the two must never be conflated. They co-occur here because
    // selection follows focus, which is precisely why both must be present.
    renderGrid(null)
    expect(dataCells()[0].className).toContain('focus-visible:ring-2')
  })
})

describe('#946 — a keydown on the table moves the cursor', () => {
  it('drives the real module against the rendered ids', () => {
    // The handler itself lives in `DatasetView`; what this pins is that the
    // module's coordinates address the cells this row component renders.
    const rowIds = ROWS.map(r => r.id)
    const columnIds = COLUMNS.map(c => c.id)
    renderGrid({ rowId: 70, columnId: 905 })
    const next = nextGridCoord({ rowId: 70, columnId: 905 }, rowIds, columnIds, { key: 'ArrowDown' })
    expect(next).toEqual({ rowId: 71, columnId: 905 })
    // ...and re-rendering at that coordinate moves the tab stop to cell 3.
    cleanup()
    renderGrid(next)
    expect(dataCells()[2].getAttribute('tabindex')).toBe('0')
  })
})

// ── What the render cannot see ───────────────────────────────────────────────

describe('#946 — the source facts a fixture cannot reach', () => {
  const cell = stripComments(readFileSync(join(SRC, 'components/EditableCell.tsx'), 'utf8'))
  const page = stripComments(readFileSync(join(SRC, 'pages/DatasetView.tsx'), 'utf8'))

  it('the scan reads real source', () => {
    // Self-check: a stripper that blanked the file would pass every assertion
    // below by finding nothing (#823f's blindness, the worse direction).
    expect(cell).toContain('export default function EditableCell')
    expect(page).toContain('handleGridKeyDown')
  })

  it('🔴 EVERY display branch spreads the shared nav props', () => {
    // Six display `<td>` returns (manual-empty, imported-empty, excluded,
    // numeric, open-text, default). A fixture reaches only the branches its
    // data produces, so this is the only place the POPULATION is checked.
    const displayTds = (cell.match(/\{\.\.\.navProps\}/g) ?? []).length
    expect(displayTds).toBe(6)
    // ...and the object is declared ONCE, or "shared" is a claim rather than a
    // fact and the six can drift apart again.
    expect((cell.match(/const navProps = \{/g) ?? []).length).toBe(1)
  })

  it('the predicate fires on the shape it is written to catch', () => {
    // Falsifier: without this, a rotted regex would report six from nowhere.
    expect(/\{\.\.\.navProps\}/.test('<td {...navProps} className="x">')).toBe(true)
    expect(/\{\.\.\.navProps\}/.test('<td className="x">')).toBe(false)
  })

  it('🔴 the arrow handler is on the TABLE, never added to the window listener', () => {
    // A window listener would see every arrow on a page that also holds a
    // search box, the pager's jump input and a dozen popovers, and would have
    // to stand down for all of them (#784/#789's trap). Scoping it to the table
    // is what makes that unnecessary.
    expect(page).toContain('onKeyDown={handleGridKeyDown}')
    const windowListener = page.slice(page.indexOf('const handler = (e: KeyboardEvent)'))
      .slice(0, page.slice(page.indexOf('const handler = (e: KeyboardEvent)')).indexOf('addEventListener'))
    expect(windowListener).not.toMatch(/Arrow(Up|Down|Left|Right)/)
  })

  it('the handler stands down for the cell editors and for edit mode', () => {
    const handler = page.slice(page.indexOf('const handleGridKeyDown'))
    expect(handler.slice(0, 600)).toContain('focusIsOnAnotherControl')
    expect(handler.slice(0, 600)).toContain('if (editingCell) return')
  })

  it('🔴 moving the editor moves the SELECTION with it', () => {
    // `handleTabNav`/`handleEnterNav` set `editingCell` alone before this, so
    // the ring and the editor drifted apart and F2 re-opened the cell the
    // researcher had left. Both route through `moveEditor` now.
    const tabNav = page.slice(page.indexOf('const handleTabNav'), page.indexOf('const handleEnterNav'))
    expect(tabNav).not.toMatch(/setEditingCell\(/)
    expect(tabNav).toMatch(/moveEditor\(/)
    const enterNav = page.slice(page.indexOf('const handleEnterNav'))
      .slice(0, 700)
    expect(enterNav).not.toMatch(/setEditingCell\(/)
    expect(enterNav).toMatch(/moveEditor\(/)
  })
})
