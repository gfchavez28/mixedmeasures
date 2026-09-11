/**
 * #675 — the Custom order LIST, checked at the caller.
 *
 * `applyCustomOrder` is unit-tested in `qual-chart-data.test.ts`, and that
 * proves the rule. It does not prove this panel uses it: the list used to render
 * `customOrder` verbatim, so it disagreed with the chart whenever a code had
 * been added since the order was authored (absent from the list) or deleted
 * (rendered as the literal text `Code 17`). Testing the shared helper alone
 * would have reported green through both.
 *
 * The panel is also where the CATEGORY-mode trap lives: the drag list was seeded
 * from the project's codes regardless of `codeMode`, while the chart's axis
 * switches to categories — two independent id sequences, so an order authored
 * against one addressed whatever rows in the other happened to share a number.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import QualChartOptionsPanel from './QualChartOptionsPanel'
import { DEFAULT_FORMATTING } from '@/lib/chart-data'

afterEach(cleanup)

const CODES = [
  { id: 1, name: 'Access' },
  { id: 2, name: 'Cost' },
  { id: 3, name: 'Staff' },
]

function renderPanel(over: Partial<React.ComponentProps<typeof QualChartOptionsPanel>> = {}) {
  const props: React.ComponentProps<typeof QualChartOptionsPanel> = {
    chartType: 'heatmap',
    valueMode: 'count',
    onValueModeChange: vi.fn(),
    denominatorMode: 'total',
    onDenominatorModeChange: vi.fn(),
    sortOrder: 'custom',
    onSortOrderChange: vi.fn(),
    showSummaryRow: true,
    onShowSummaryRowChange: vi.fn(),
    showRowN: true,
    onShowRowNChange: vi.fn(),
    formatting: DEFAULT_FORMATTING,
    onFormattingChange: vi.fn(),
    customOrder: [],
    onCustomOrderChange: vi.fn(),
    axisEntities: CODES,
    categoryMode: false,
    orientation: 'sources-rows',
    onOrientationChange: vi.fn(),
    title: '',
    subtitle: '',
    footnote: '',
    onTitleChange: vi.fn(),
    onSubtitleChange: vi.fn(),
    onFootnoteChange: vi.fn(),
    showChartN: false,
    onShowChartNChange: vi.fn(),
    ...over,
  }
  return render(<QualChartOptionsPanel {...props} />)
}

/** The drag list, in rendered order, read off the reorder handles' names. */
function listedNames(): string[] {
  return screen
    .getAllByRole('button', { name: /^Drag to reorder/ })
    .map(b => (b.getAttribute('aria-label') ?? '').replace(/^Drag to reorder \w+ /, '').replace(/, \d+ of \d+$/, ''))
}

describe('#675 — the custom-order list mirrors the chart axis', () => {
  it('lists every entity even when nothing has been authored yet', () => {
    // Import order, and no seeding step: the old panel wrote a full order into
    // the URL the instant "Custom" was picked, which made choosing the option a
    // state mutation before the researcher had reordered anything.
    renderPanel()
    expect(listedNames()).toEqual(['Access', 'Cost', 'Staff'])
  })

  it('appends an entity that post-dates the authored order', () => {
    renderPanel({ customOrder: [3, 1] })
    expect(listedNames()).toEqual(['Staff', 'Access', 'Cost'])
  })

  it('drops an id whose entity is gone rather than rendering a bare number', () => {
    renderPanel({ customOrder: [99, 2, 1, 3] })
    expect(listedNames()).toEqual(['Cost', 'Access', 'Staff'])
    expect(screen.queryByText('#99')).not.toBeInTheDocument()
  })

  it('names each row with its position, so the list is navigable without sight of it', () => {
    renderPanel({ customOrder: [2] })
    expect(screen.getByRole('button', { name: 'Drag to reorder code Cost, 1 of 3' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Drag to reorder code Access, 2 of 3' })).toBeInTheDocument()
  })

  it('orders CATEGORIES in category mode, and says so', () => {
    renderPanel({
      categoryMode: true,
      axisEntities: [{ id: 1, name: 'Barriers' }, { id: 2, name: 'Supports' }],
      customOrder: [2, 1],
    })
    expect(listedNames()).toEqual(['Supports', 'Barriers'])
    expect(screen.getByText('Drag to reorder categories')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /category Supports/ })).toBeInTheDocument()
  })
})

describe('#675 — Sort is offered only where it is consumed', () => {
  it.each(['heatmap', 'bar', 'stacked_bar'] as const)('%s offers Sort', chartType => {
    renderPanel({ chartType })
    expect(screen.getByText('Sort')).toBeInTheDocument()
  })

  it.each(['summary', 'saturation', 'timeline'] as const)('%s does not', chartType => {
    // `timeline` is the one this fixes: `TimedAnalytics` takes no sortOrder prop,
    // so the dropdown was offered and moved nothing.
    renderPanel({ chartType })
    expect(screen.queryByText('Sort')).not.toBeInTheDocument()
  })
})

describe('#900 — the Fonts group names each size picker', () => {
  /**
   * Measured in Chrome before the fix: three `combobox`es with NO name, values
   * `12px / 12px / 16px`, visibly captioned *Label · Data · Title*. They sit in an
   * `OptionRow fullWidth`, whose labelled `role="group"` names the SET and cannot
   * name the members — so each caption is paired with its control by id.
   *
   * ⚠️ Their siblings (*Matrix Colors*, *Font Size* on the co-occurrence chart)
   * were always named, by the wrapping `<label>` of `OptionRow`'s default branch.
   * That asymmetry is the whole of #900.
   */
  it('each caption names its own control, and the group carries "Fonts"', () => {
    renderPanel({ chartType: 'bar' })
    fireEvent.click(screen.getByRole('button', { name: /appearance/i }))

    const group = screen.getByRole('group', { name: 'Fonts' })
    expect(group).toBeInTheDocument()

    for (const caption of ['Label', 'Data', 'Title']) {
      const control = screen.getByRole('combobox', { name: caption })
      expect(group.contains(control)).toBe(true)
    }

    // ...and no combobox inside the group is left anonymous.
    const anonymous = Array.from(group.querySelectorAll('[role="combobox"]')).filter(
      el => !(el.getAttribute('aria-labelledby') || el.getAttribute('aria-label') || el.id),
    )
    expect(anonymous).toEqual([])
  })
})
