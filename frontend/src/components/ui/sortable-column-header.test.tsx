/**
 * #1465 — a table a reader can sort is sorted by a BUTTON in its header.
 *
 * Name-sweep run 15 (2026-10-29) measured the qualitative comparison table's
 * sort headers as `<th onClick>`: `tabIndex` −1, no focusable child, so a
 * keyboard or screen-reader user could not re-sort it at all (WCAG 2.1.1). The
 * pickup review (2026-11-06c, D128) found the same shape on two more tables —
 * Data Quality's missing-values table and the post-hoc table — while the code
 * summary table beside them had the button. The shape lives in ONE component
 * now (`sortable-column-header.tsx`); this file holds it there:
 *
 * 1. a POPULATION scan: no header cell anywhere in `src/` carries an `onClick`,
 *    with a floor, the four tables that sort as sentinels, and a predicate
 *    falsifier on the real shapes;
 * 2. the component's own contract (D129: the name is the label alone, the arrow
 *    hidden, `aria-sort` only on the sorted column);
 * 3. each converted table, rendered: every sortable header holds a focusable
 *    button named exactly its label, and pressing it moves `aria-sort`.
 *
 * ⚠️ Enter and Space activating a focused `<button>` is the BROWSER's native
 * behaviour, which jsdom does not synthesise from a key event — so these tests
 * assert the MECHANISM (a real, focusable button whose click sorts), and the key
 * presses themselves were driven in Chrome (the record's §6).
 */
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { stripComments } from '@/lib/strip-comments'
import { sourceFiles, srcRel } from '@/test-support/source-tree'
import { columnSort } from '@/lib/column-sort'
import { SortableColumnHeader } from './sortable-column-header'
import QualComparisonTable from '@/components/qualitative-analysis/QualComparisonTable'
import MissingSummaryTable from '@/components/data-quality/MissingSummaryTable'
import PostHocTable from '@/components/analysis/PostHocTable'
import type { DemographicComparisonResponse, VariableMissingSummary } from '@/lib/api'

// ---------------------------------------------------------------------------
// 1. The population: no header cell is clickable
// ---------------------------------------------------------------------------

/** The end of a JSX opening tag, skipping a `>` inside `{…}` (an arrow function). */
function openTagEnd(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return i
  }
  return -1
}

/**
 * Every opening tag of a header CELL in `src`: `<th …>`, `<TableHead …>`, and
 * any element given `role="columnheader"` (the grids draw headers from `div`s).
 */
function headerCellTags(src: string): string[] {
  const starts = new Set<number>()
  for (const m of src.matchAll(/<(?:th|TableHead)(?=[\s>/])/g)) starts.add(m.index)
  for (const m of src.matchAll(/role=(?:"columnheader"|'columnheader'|\{'columnheader'\}|\{"columnheader"\})/g)) {
    const open = src.lastIndexOf('<', m.index)
    if (open !== -1) starts.add(open)
  }
  const tags: string[] = []
  for (const start of starts) {
    const end = openTagEnd(src, start)
    if (end !== -1) tags.push(src.slice(start, end + 1))
  }
  return tags
}

const clickable = (tag: string) => /\bonClick\s*=/.test(tag)

/** The four tables that sort by their header — each must use the shared control. */
const SORTING_TABLES = [
  'components/qualitative-analysis/QualSummaryTable.tsx',
  'components/qualitative-analysis/QualComparisonTable.tsx',
  'components/data-quality/MissingSummaryTable.tsx',
  'components/analysis/PostHocTable.tsx',
]

describe('#1465 — no header cell in src/ is clickable', () => {
  const files = sourceFiles({ ext: 'tsx', floor: 100, sentinels: SORTING_TABLES })
  const scanned = files.map(abs => ({ rel: srcRel(abs), src: stripComments(readFileSync(abs, 'utf8'), abs) }))
  const cells = scanned.flatMap(f => headerCellTags(f.src).map(tag => ({ rel: f.rel, tag })))

  it('every header cell is a cell — the sort control is a button inside it', () => {
    const offenders = cells.filter(c => clickable(c.tag)).map(c => `${c.rel}: ${c.tag.slice(0, 80)}`)
    expect(
      offenders,
      'A clickable <th> (or columnheader) is mouse-only: nothing to Tab to, and Enter/Space '
        + 'do nothing. Use `SortableColumnHeader` (or `SortButton` beside other content) from '
        + '`components/ui/sortable-column-header.tsx` (#1465).',
    ).toEqual([])
  })

  it('the scan sees the header cells it polices (a floor, so a rotted matcher cannot pass)', () => {
    // 2026-11-06c: well over 100 header-cell tags in src/ (the floor sits below the count).
    expect(cells.length).toBeGreaterThanOrEqual(100)
  })

  it('each table that sorts by its header uses the shared control', () => {
    const importing = scanned
      .filter(f => f.src.includes("from '@/components/ui/sortable-column-header'"))
      .map(f => f.rel)
    for (const table of SORTING_TABLES) expect(importing).toContain(table)
  })

  it('a hand-written aria-sort sits only beside the shared button (the summary table\'s info arm)', () => {
    const outside = scanned
      .filter(f => f.rel !== 'components/ui/sortable-column-header.tsx' && /aria-sort\s*=/.test(f.src))
      .filter(f => !f.src.includes('<SortButton'))
      .map(f => f.rel)
    expect(outside).toEqual([])
  })

  it('the predicate catches every clickable shape, and only those (falsifier)', () => {
    const found = (src: string) => headerCellTags(src).filter(clickable).length
    // The three shapes #1465 removed, one per table.
    expect(found('<th scope="col" className="x" onClick={() => onSort(field)} aria-sort="ascending">p</th>')).toBe(1)
    expect(found('<th\n  className="sticky"\n  style={{ minWidth: 160 }}\n  onClick={() => handleSort(\'name\')}\n>V</th>')).toBe(1)
    expect(found('<th scope="col" aria-sort={a ? \'ascending\' : \'descending\'} onClick={() => setSortAsc(v => !v)}>p</th>')).toBe(1)
    // An arrow's `>` inside the tag does not end it early.
    expect(found('<th title={x => x > 1 ? "a" : "b"} onClick={f}>p</th>')).toBe(1)
    expect(found('<TableHead onClick={f}>p</TableHead>')).toBe(1)
    expect(found('<div role="columnheader" onClick={f}>p</div>')).toBe(1)
    // A button INSIDE the cell is the right shape; <thead> is not a cell.
    expect(found('<th scope="col"><button type="button" onClick={f}>p</button></th>')).toBe(0)
    expect(found('<thead onClick={f}><tr><th>p</th></tr></thead>')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. The component (D129)
// ---------------------------------------------------------------------------

function inTable(node: React.ReactNode) {
  return render(<table><thead><tr>{node}</tr></thead></table>)
}

describe('#1465 — SortableColumnHeader', () => {
  it('is a column header holding a button named by its label alone; the arrow is hidden', () => {
    const onSort = vi.fn()
    inTable(<SortableColumnHeader label="p" sort="ascending" onSort={onSort} />)
    const th = screen.getByRole('columnheader')
    expect(th).toHaveAttribute('aria-sort', 'ascending')
    expect(th).toHaveAttribute('scope', 'col')
    const button = within(th).getByRole('button')
    expect(button).toHaveAccessibleName('p') // never "p↑" (run 15 measured "p↑")
    expect(button).toHaveAttribute('type', 'button')
    expect(th.textContent).toBe('p↑') // the arrow is drawn…
    expect(th.querySelector('[aria-hidden="true"]')!.textContent).toBe('↑') // …for the eye only
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(onSort).toHaveBeenCalledTimes(1)
  })

  it('draws ↓ for descending, and an unsorted column states nothing', () => {
    const { unmount } = inTable(<SortableColumnHeader label="Count" sort="descending" onSort={() => {}} />)
    expect(screen.getByRole('columnheader').textContent).toBe('Count↓')
    unmount()
    inTable(<SortableColumnHeader label="Count" sort={undefined} onSort={() => {}} />)
    const th = screen.getByRole('columnheader')
    expect(th).not.toHaveAttribute('aria-sort')
    expect(th.textContent).toBe('Count')
  })

  it('columnSort states the sorted column only', () => {
    expect(columnSort(true, 'asc')).toBe('ascending')
    expect(columnSort(true, 'desc')).toBe('descending')
    expect(columnSort(false, 'asc')).toBeUndefined()
    expect(columnSort(false, 'desc')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. The tables
// ---------------------------------------------------------------------------

/** The sortable headers' buttons, by their drawn label (the arrow left off), in a container. */
function sortButtons(container: HTMLElement): string[] {
  return within(container).getAllByRole('columnheader')
    .flatMap(th => within(th).queryAllByRole('button'))
    .map(b => (b.textContent ?? '').replace(/[↑↓]/, ''))
}

function header(name: string) {
  const button = screen.getByRole('button', { name })
  return { button, th: button.closest('th')! }
}

const sortedHeaders = () => screen.getAllByRole('columnheader')
  .filter(th => th.hasAttribute('aria-sort'))
  .map(th => [within(th).getByRole('button').textContent?.replace(/[↑↓]/, ''), th.getAttribute('aria-sort')])

const cell = (count: number, n: number) => ({ count, proportion: count / n, undefined_reason: null, passages: count })

function twoGroups(): DemographicComparisonResponse {
  return {
    groups: ['Board', 'Staff'],
    group_totals: {
      Board: { n: 1, participants: 1, total_segments: 1, total_word_count: 0 },
      Staff: { n: 8, participants: 8, total_segments: 40, total_word_count: 0 },
    },
    codes: [
      { code_id: 1, code_name: 'Alpha', category_name: 'Cat B',
        by_group: { Board: cell(1, 1), Staff: cell(2, 8) }, delta_proportion: 0.75,
        test: { method: 'fisher_exact', statistic: null, p_value: 0.2, p_adjusted: 0.4,
                significant: false, effect_size: 0.3, effect_size_label: 'odds_ratio',
                min_attainable_p: 0.1, can_reach_significance: true } },
      { code_id: 2, code_name: 'Beta', category_name: 'Cat A',
        by_group: { Board: cell(0, 1), Staff: cell(6, 8) }, delta_proportion: -0.75,
        test: { method: 'fisher_exact', statistic: null, p_value: 0.01, p_adjusted: 0.02,
                significant: true, effect_size: 0.9, effect_size_label: 'odds_ratio',
                min_attainable_p: 0.1, can_reach_significance: true } },
    ],
    basis: { unit: 'participant', correction: 'holm', family_size: 2, family_reachable: 2,
             tarone_family_size: 2, alpha: 0.05, tested_groups: ['Board', 'Staff'], test_omitted_reason: null },
    scope: { conversations: 1, documents: 0, text_columns: 0, observations_left_out: 0,
             unassigned_passages: 0, participants_without_group: 0 },
  } as unknown as DemographicComparisonResponse
}

function threeGroups(): DemographicComparisonResponse {
  const base = twoGroups() as unknown as Record<string, unknown>
  return {
    ...base,
    groups: ['Board', 'Staff', 'Clinical Services'],
    group_totals: {
      ...(base.group_totals as object),
      'Clinical Services': { n: 0, participants: 0, total_segments: 0, total_word_count: 0 },
    },
    codes: (twoGroups().codes).map(c => ({
      ...c, by_group: { ...c.by_group, 'Clinical Services': { count: 0, proportion: null, undefined_reason: 'no_segments', passages: 0 } },
      delta_proportion: null,
    })),
  } as unknown as DemographicComparisonResponse
}

describe('#1465 — QualComparisonTable', () => {
  it('two groups: every sortable header is a focusable button named its label', () => {
    const { container } = render(<QualComparisonTable data={twoGroups()} />)
    expect(sortButtons(container)).toEqual(expect.arrayContaining(['Code', 'Category', 'Δ Prop', 'p', 'Effect']))
    for (const name of ['Code', 'Category', 'Δ Prop', 'p', 'Effect']) {
      const { button } = header(name)
      button.focus()
      expect(document.activeElement).toBe(button)
    }
    // The default order (Δ descending) is stated once, on its own column.
    expect(sortedHeaders()).toEqual([['Δ Prop', 'descending']])
  })

  it('pressing a header re-sorts and moves aria-sort to it', () => {
    render(<QualComparisonTable data={twoGroups()} />)
    const rowsNow = () => screen.getAllByRole('row').slice(1).map(r => r.querySelector('td')?.textContent).filter(Boolean)
    fireEvent.click(header('Category').button)
    expect(sortedHeaders()).toEqual([['Category', 'ascending']])
    expect(rowsNow()).toEqual(['Beta', 'Alpha']) // Cat A before Cat B
    fireEvent.click(header('Category').button)
    expect(sortedHeaders()).toEqual([['Category', 'descending']])
    expect(rowsNow()).toEqual(['Alpha', 'Beta'])
    fireEvent.click(header('p').button)
    expect(header('p').th).toHaveAttribute('aria-sort', 'descending')
    expect(header('Category').th).not.toHaveAttribute('aria-sort')
  })

  it('a group header says its n with a space, and one passage is singular (D130)', () => {
    render(<QualComparisonTable data={twoGroups()} />)
    const board = screen.getByRole('columnheader', { name: 'Board (n=1 participant)' })
    expect(board).toHaveAttribute('title', 'n = 1 participant with material here (1 passage)')
    expect(screen.getByRole('columnheader', { name: 'Staff (n=8 participants)' }))
      .toHaveAttribute('title', 'n = 8 participants with material here (40 passages)')
  })

  it('a payload with no basis counts passages, and one is singular', () => {
    const { basis: _basis, ...rest } = twoGroups() as unknown as Record<string, unknown>
    void _basis
    render(<QualComparisonTable data={rest as unknown as DemographicComparisonResponse} />)
    expect(screen.getByRole('columnheader', { name: 'Board (n=1 passage)' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Staff (n=40 passages)' })).toBeInTheDocument()
  })

  it('three groups: the group row says it the same way, and the p header is a button', () => {
    render(<QualComparisonTable data={threeGroups()} />)
    expect(screen.getByRole('columnheader', { name: 'Clinical Services (n=0 participants)' }))
      .toHaveAttribute('title', 'n = 0 participants with material here (0 passages)')
    expect(sortedHeaders()).toEqual([['p', 'ascending']])
  })
})

const variable = (id: number, name: string, pct: number): VariableMissingSummary => ({
  column_id: id, variable_name: name, full_label: name, dataset_id: 1, dataset_name: 'Survey',
  column_type: 'likert', n_total: 10, n_valid: 10 - pct / 10, n_missing: pct / 10, pct_missing: pct,
  n_empty: 0, n_na: pct / 10,
})

describe('#1465 — MissingSummaryTable (Data Quality)', () => {
  const props = {
    variables: [variable(1, 'b_second', 10), variable(2, 'a_first', 30)],
    totalCells: 20, totalMissing: 4, overallPctMissing: 20,
  }

  it('its seven sortable headers are focusable buttons; Type and N Valid are plain headers', () => {
    const { container } = render(<MissingSummaryTable {...props} />)
    expect(sortButtons(container)).toEqual(['Variable', 'Dataset', 'N Total', 'N Missing', '% Missing', 'N Empty', 'N NA'])
    for (const name of ['Variable', 'Dataset', 'N Total', 'N Missing', '% Missing', 'N Empty', 'N NA']) {
      const { button } = header(name)
      button.focus()
      expect(document.activeElement).toBe(button)
    }
    expect(within(screen.getByRole('columnheader', { name: 'Type' })).queryByRole('button')).toBeNull()
    expect(within(screen.getByRole('columnheader', { name: 'N Valid' })).queryByRole('button')).toBeNull()
  })

  it('aria-sort is on the sorted column only — never "none" on the other six', () => {
    render(<MissingSummaryTable {...props} />)
    expect(sortedHeaders()).toEqual([['% Missing', 'descending']])
    const firstCells = () => screen.getAllByRole('row').slice(1, 3).map(r => r.querySelector('td')?.textContent)
    expect(firstCells()).toEqual(['a_first', 'b_second'])
    fireEvent.click(header('Variable').button)
    expect(sortedHeaders()).toEqual([['Variable', 'ascending']])
    expect(firstCells()).toEqual(['a_first', 'b_second'])
    fireEvent.click(header('Variable').button)
    expect(sortedHeaders()).toEqual([['Variable', 'descending']])
    expect(firstCells()).toEqual(['b_second', 'a_first'])
  })

  it('keeps the Variable column sticky and its width', () => {
    render(<MissingSummaryTable {...props} />)
    const { th } = header('Variable')
    expect(th.className).toContain('sticky')
    expect(th.style.minWidth).toBe('160px')
    expect(header('Dataset').th.className).not.toContain('sticky')
  })
})

describe('#1465 — PostHocTable', () => {
  const comparisons = [
    { group_a: 'A', group_b: 'B', mean_diff: 1, p: 0.3, ci_lower: 0, ci_upper: 2 },
    { group_a: 'A', group_b: 'C', mean_diff: 2, p: 0.01, ci_lower: 1, ci_upper: 3 },
  ]
  const sig = { show_05: true, show_01: true, show_001: true }

  it('the p header is a focusable button named "p", ascending first; pressing it reverses', () => {
    render(<PostHocTable comparisons={comparisons} variableName="Trust" sigLevels={sig} expanded onToggle={() => {}} />)
    const { button, th } = header('p')
    button.focus()
    expect(document.activeElement).toBe(button)
    expect(th).toHaveAttribute('aria-sort', 'ascending')
    expect(th).not.toHaveAttribute('title') // the mouse-only "Click to toggle sort order"
    const firstB = () => screen.getAllByRole('row')[1].querySelectorAll('td')[1].textContent
    expect(firstB()).toBe('C')
    fireEvent.click(button)
    expect(th).toHaveAttribute('aria-sort', 'descending')
    expect(firstB()).toBe('B')
  })
})
