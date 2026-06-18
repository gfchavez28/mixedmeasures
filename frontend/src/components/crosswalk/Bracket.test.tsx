/**
 * #327 — Bracket collapse + drag-handle wiring tests.
 *
 * Focused on Bracket's user-facing behavior:
 *   - chevron click toggles collapse
 *   - aria-expanded tracks state
 *   - rows + "Add variable row" button hide when collapsed
 *   - chevron click does NOT activate the sortable drag (ID isolation)
 *   - keyboard reorder via Ctrl+Shift+Up/Down on the grip handle
 *
 * Test harness: minimal DndContext + SortableContext wrapper since
 * useSortable requires both. The bracket fixture is a single bracket
 * with one EG row containing two cells.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DndContext } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Bracket } from './Bracket'
import { makeBracketSortId } from './drop-ids'
import type { BracketData } from './crosswalk-types'

afterEach(() => cleanup())

function buildBracket(overrides: Partial<BracketData> = {}): BracketData {
  return {
    domain_id: 50,
    name: 'Leadership',
    description: null,
    color: null,
    sequence_order: 0,
    is_cross_dataset: true,
    dataset_count: 2,
    scale_score_metric_id: null,
    scale_score_metric_state: 'missing',
    rows: [
      {
        kind: 'eg',
        equivalence_group_id: 100,
        auto_label: 'Q1 Trust in leadership',
        has_scale_labels_mismatch: false,
        cells_by_dataset: new Map([
          [
            10,
            {
              column_id: 1,
              dataset_id: 10,
              dataset_name: 'Board',
              column_code: 'BQ1',
              column_text: 'Trust in leadership',
              column_type: 'ordinal',
              scale_points: 5,
              is_reverse_scored: false,
              equivalence_group_id: 100,
            },
          ],
          [
            11,
            {
              column_id: 2,
              dataset_id: 11,
              dataset_name: 'Staff',
              column_code: 'SQ1',
              column_text: 'Trust in leadership',
              column_type: 'ordinal',
              scale_points: 5,
              is_reverse_scored: false,
              equivalence_group_id: 100,
            },
          ],
        ]),
      },
    ],
    ...overrides,
  }
}

function renderBracket(props: {
  bracket?: BracketData
  isCollapsed?: boolean
  onToggleCollapse?: (id: number) => void
  onReorderDomain?: (id: number, dir: 'up' | 'down') => void
}) {
  const bracket = props.bracket ?? buildBracket()
  const datasetNames = new Map([
    [10, 'Board'],
    [11, 'Staff'],
  ])
  return render(
    <DndContext>
      <SortableContext
        items={[makeBracketSortId(bracket.domain_id)]}
        strategy={verticalListSortingStrategy}
      >
        <Bracket
          bracket={bracket}
          activeDatasetIds={[10, 11]}
          datasetNames={datasetNames}
          searchHighlightIds={new Set()}
          bracketIndex={0}
          bracketCount={1}
          isCollapsed={props.isCollapsed ?? false}
          onToggleCollapse={props.onToggleCollapse}
          onReorderDomain={props.onReorderDomain}
        />
      </SortableContext>
    </DndContext>,
  )
}

describe('Bracket collapse', () => {
  it('renders rows and Add variable row button when expanded', () => {
    renderBracket({ isCollapsed: false })
    // Both Board and Staff cells render the same column text — assert at
    // least one is present.
    expect(screen.getAllByText('Trust in leadership').length).toBeGreaterThan(0)
    expect(
      screen.getByRole('button', { name: /add a new variable row to leadership/i }),
    ).toBeInTheDocument()
  })

  it('chevron renders aria-expanded=true when not collapsed', () => {
    renderBracket({ isCollapsed: false })
    const chevron = screen.getByRole('button', { name: /collapse leadership/i })
    expect(chevron).toHaveAttribute('aria-expanded', 'true')
  })

  it('chevron renders aria-expanded=false when collapsed', () => {
    renderBracket({ isCollapsed: true })
    const chevron = screen.getByRole('button', { name: /expand leadership/i })
    expect(chevron).toHaveAttribute('aria-expanded', 'false')
  })

  it('clicking chevron calls onToggleCollapse with the domain id', () => {
    const onToggleCollapse = vi.fn()
    renderBracket({ isCollapsed: false, onToggleCollapse })
    fireEvent.click(screen.getByRole('button', { name: /collapse leadership/i }))
    expect(onToggleCollapse).toHaveBeenCalledWith(50)
    expect(onToggleCollapse).toHaveBeenCalledTimes(1)
  })

  it('omits rows and Add variable row from the DOM when collapsed', () => {
    renderBracket({ isCollapsed: true })
    // The thin one-line collapsed strip drops cell content + the
    // "Add variable row" button entirely, not just visually — that's what
    // makes the bracket footprint actually shrink instead of just blanking.
    expect(screen.queryByText('Trust in leadership')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /add a new variable row to leadership/i }),
    ).not.toBeInTheDocument()
  })

  it('keeps name + dropdown actions reachable when collapsed', () => {
    renderBracket({ isCollapsed: true })
    expect(screen.getByText('Leadership')).toBeInTheDocument()
    // "Actions for Leadership" — the dropdown trigger is always present.
    expect(
      screen.getByRole('button', { name: /actions for leadership/i }),
    ).toBeInTheDocument()
  })

  it('drags reorder grip remains present (and reachable via keyboard) when collapsed', () => {
    renderBracket({ isCollapsed: true })
    expect(
      screen.getByRole('button', { name: /reorder variable group: leadership/i }),
    ).toBeInTheDocument()
  })

  it('section aria-label notes the collapsed state for screen readers', () => {
    const { container } = renderBracket({ isCollapsed: true })
    const section = container.querySelector('[data-testid="crosswalk-bracket-50"]')
    expect(section).toHaveAttribute(
      'aria-label',
      'Variable group: Leadership (collapsed)',
    )
  })
})

describe('Bracket drag handle isolation', () => {
  it('chevron click does NOT trigger the reorder callback', () => {
    // The chevron and the grip handle are separate buttons; clicks on the
    // chevron must not bubble into a sortable activation. We verify this
    // indirectly by confirming the chevron's onClick fires the toggle, not
    // any drag-end side effect.
    const onToggleCollapse = vi.fn()
    const onReorderDomain = vi.fn()
    renderBracket({ onToggleCollapse, onReorderDomain })
    fireEvent.click(screen.getByRole('button', { name: /collapse leadership/i }))
    expect(onToggleCollapse).toHaveBeenCalled()
    // onReorderDomain feeds the bracket's dropdown Move up / Move down
    // items — chevron click must not invoke it.
    expect(onReorderDomain).not.toHaveBeenCalled()
  })
})

describe('Cell hover tooltip (Step 2: full column text)', () => {
  it('cell wrapper carries a title with full column text + dataset + type', () => {
    renderBracket({ isCollapsed: false })
    // The fixture renders 2 cells (Board + Staff), both with column_text
    // "Trust in leadership". The cell wrapper exposes role="gridcell" and
    // the tooltip-style title.
    const cells = screen.getAllByRole('gridcell')
    expect(cells.length).toBeGreaterThanOrEqual(2)
    const boardCell = cells[0]
    const title = boardCell.getAttribute('title') ?? ''
    expect(title).toContain('Trust in leadership')
    expect(title).toContain('Board')
    expect(title).toContain('ordinal')
  })
})

describe('Equivalence indicator (Layer 2: ⇄ between paired cells)', () => {
  it('renders an indicator on the second cell of a 2-dataset EG row', () => {
    renderBracket({ isCollapsed: false })
    const indicators = screen.getAllByLabelText('Equivalent variable across datasets')
    // First populated cell has nothing to its left → no indicator. Second
    // cell does → exactly one indicator total.
    expect(indicators).toHaveLength(1)
  })

  it('does NOT render the indicator for a synthetic single-cell row', () => {
    const bracket = buildBracket({
      dataset_count: 1,
      rows: [
        {
          kind: 'unlinked',
          column_id: 99,
          member_id: 999,
          auto_label: 'Solo',
          cells_by_dataset: new Map([
            [
              10,
              {
                column_id: 99,
                dataset_id: 10,
                dataset_name: 'Board',
                column_code: 'Q1',
                column_name: 'Q1',
                column_text: 'Solo',
                column_type: 'ordinal',
                scale_points: 5,
                scale_labels: null,
                recode_def_count: 0,
                equivalence_group_id: null,
                equivalence_group_label: null,
              },
            ],
          ]),
        },
      ],
    })
    renderBracket({ bracket })
    expect(screen.queryAllByLabelText('Equivalent variable across datasets')).toHaveLength(0)
  })
})

describe('Bracket label (Layer 1: variables · datasets)', () => {
  it('renders "N variables · M datasets" instead of structural row count', () => {
    const bracket = buildBracket({ dataset_count: 3 })
    renderBracket({ bracket })
    // 1 row in fixture × 3 datasets
    expect(screen.getByText(/1 variable.*3 datasets/i)).toBeInTheDocument()
  })

  it('uses singular forms for 1 variable / 1 dataset', () => {
    const bracket = buildBracket({ dataset_count: 1 })
    renderBracket({ bracket })
    expect(screen.getByText(/1 variable .*1 dataset/i)).toBeInTheDocument()
    expect(screen.queryByText(/variables/)).not.toBeInTheDocument()
  })

  it('shows "Empty" for a bracket with no rows', () => {
    const bracket = buildBracket({ rows: [], dataset_count: 0 })
    renderBracket({ bracket })
    expect(screen.getByText('Empty')).toBeInTheDocument()
    // The structural count surface is dropped for empty brackets — no
    // "0 variables · 0 datasets" string in the label gutter.
    expect(screen.queryByText(/0 variables?/)).not.toBeInTheDocument()
    expect(screen.queryByText(/0 datasets?/)).not.toBeInTheDocument()
  })

  it('aria-label includes the count summary for screen readers', () => {
    const bracket = buildBracket({ dataset_count: 2 })
    renderBracket({ bracket })
    const region = screen.getByRole('grid', { name: /Variable group: Leadership/i })
    expect(region.getAttribute('aria-label')).toMatch(/1 variable across 2 datasets/i)
  })
})

describe('Bracket grip handle keyboard reorder', () => {
  it('Ctrl+Shift+ArrowDown calls onReorderDomain with "down"', () => {
    const onReorderDomain = vi.fn()
    renderBracket({ bracket: buildBracket(), onReorderDomain })
    // Bracket is at index 0 of count 2 to allow down move.
    // Re-render with bracketIndex/bracketCount adjusted.
    cleanup()
    const bracket = buildBracket()
    const datasetNames = new Map([[10, 'Board'], [11, 'Staff']])
    render(
      <DndContext>
        <SortableContext
          items={[makeBracketSortId(bracket.domain_id)]}
          strategy={verticalListSortingStrategy}
        >
          <Bracket
            bracket={bracket}
            activeDatasetIds={[10, 11]}
            datasetNames={datasetNames}
            searchHighlightIds={new Set()}
            bracketIndex={0}
            bracketCount={2}
            onReorderDomain={onReorderDomain}
          />
        </SortableContext>
      </DndContext>,
    )
    const grip = screen.getByRole('button', { name: /reorder variable group: leadership/i })
    fireEvent.keyDown(grip, { key: 'ArrowDown', ctrlKey: true, shiftKey: true })
    expect(onReorderDomain).toHaveBeenCalledWith(50, 'down')
  })

  it('Ctrl+Shift+ArrowUp on a first-position bracket is a no-op', () => {
    const onReorderDomain = vi.fn()
    renderBracket({ onReorderDomain })
    const grip = screen.getByRole('button', { name: /reorder variable group: leadership/i })
    fireEvent.keyDown(grip, { key: 'ArrowUp', ctrlKey: true, shiftKey: true })
    expect(onReorderDomain).not.toHaveBeenCalled()
  })

  it('Plain ArrowDown without modifiers does not fire reorder', () => {
    const onReorderDomain = vi.fn()
    renderBracket({ onReorderDomain })
    const grip = screen.getByRole('button', { name: /reorder variable group: leadership/i })
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(onReorderDomain).not.toHaveBeenCalled()
  })
})

describe('Bracket "+ Add variable row" droppable visual states', () => {
  it('renders compact button when dragActive=false (idle)', () => {
    render(
      <DndContext>
        <SortableContext
          items={[makeBracketSortId(50)]}
          strategy={verticalListSortingStrategy}
        >
          <Bracket
            bracket={buildBracket()}
            activeDatasetIds={[10, 11]}
            datasetNames={new Map([[10, 'Board'], [11, 'Staff']])}
            searchHighlightIds={new Set()}
            bracketIndex={0}
            bracketCount={1}
          />
        </SortableContext>
      </DndContext>,
    )
    const button = screen.getByRole('button', { name: /add a new variable row to leadership/i })
    expect(button.textContent).toContain('Add variable row')
  })

  it('expands to "Drop to add as new row" copy when dragActive=true', () => {
    render(
      <DndContext>
        <SortableContext
          items={[makeBracketSortId(50)]}
          strategy={verticalListSortingStrategy}
        >
          <Bracket
            bracket={buildBracket()}
            activeDatasetIds={[10, 11]}
            datasetNames={new Map([[10, 'Board'], [11, 'Staff']])}
            searchHighlightIds={new Set()}
            bracketIndex={0}
            bracketCount={1}
            dragActive
          />
        </SortableContext>
      </DndContext>,
    )
    const button = screen.getByRole('button', { name: /drop here to add a new row/i })
    expect(button.textContent).toContain('Drop to add as new row')
  })

  it('applies pulse class when pulseAddRow=true', () => {
    render(
      <DndContext>
        <SortableContext
          items={[makeBracketSortId(50)]}
          strategy={verticalListSortingStrategy}
        >
          <Bracket
            bracket={buildBracket()}
            activeDatasetIds={[10, 11]}
            datasetNames={new Map([[10, 'Board'], [11, 'Staff']])}
            searchHighlightIds={new Set()}
            bracketIndex={0}
            bracketCount={1}
            pulseAddRow
          />
        </SortableContext>
      </DndContext>,
    )
    const button = screen.getByRole('button', { name: /add a new variable row to leadership/i })
    expect(button.className).toContain('crosswalk-add-row-pulse')
  })
})
