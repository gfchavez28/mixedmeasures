/**
 * #1561 — a CLOSED chart-option picker shows the chosen option's label only.
 *
 * `SelectItem` wraps every child in Radix's `ItemText`, and an empty `<SelectValue />`
 * mirrors the selected item's whole `ItemText` into the 28 px trigger. *Value display*
 * and *Denominator* carry a description line inside each item, so the trigger held label
 * AND description; #1529 lengthened *Coded only*'s to ~95 characters and it ran to five
 * lines over *Value display* and *Sort* (the 2026-11-07 `/ux-audit`, D2/12).
 *
 * jsdom cannot measure the overflow; what it CAN check is the cause — the trigger's
 * text. Every option of both pickers is rendered selected in turn, so a fix applied to
 * one picker, or one option, fails here. The positive control opens the menu and finds
 * the description still on its option: the fix must not drop the words, only move them
 * out of the closed box.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import QualChartOptionsPanel from './QualChartOptionsPanel'
import { DEFAULT_FORMATTING } from '@/lib/chart-data'

afterEach(cleanup)

beforeAll(() => {
  // Radix Select's open path calls these; jsdom has none of them.
  Element.prototype.scrollIntoView ??= vi.fn()
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.releasePointerCapture ??= vi.fn()
})

// The option text as the panel declares it — written here, not imported, so a change
// to the wording is a deliberate change to this test too.
const VALUE_MODES = [
  { value: 'count', label: 'Count', description: 'Coded segments per source' },
  { value: 'segment_proportion', label: 'Proportion', description: 'Fraction of segments with code' },
  { value: 'text_coverage', label: 'Word Coverage', description: 'Fraction of text in coded segments' },
] as const
const DENOMINATORS = [
  { value: 'total', label: 'All segments', description: 'Divide by total segments in source' },
  {
    value: 'coded',
    label: 'Coded only',
    description: 'Divide by coded segments — one marked only with a universal code (such as Unclear) is not coded',
  },
] as const

function renderPanel(valueMode: string, denominatorMode: string) {
  const props = {
    chartType: 'bar',
    valueMode,
    onValueModeChange: vi.fn(),
    denominatorMode,
    onDenominatorModeChange: vi.fn(),
    sortOrder: 'import',
    onSortOrderChange: vi.fn(),
    showSummaryRow: true,
    onShowSummaryRowChange: vi.fn(),
    showRowN: true,
    onShowRowNChange: vi.fn(),
    formatting: DEFAULT_FORMATTING,
    onFormattingChange: vi.fn(),
    customOrder: [],
    onCustomOrderChange: vi.fn(),
    axisEntities: [{ id: 1, name: 'Access' }],
    categoryMode: false,
    groupBy: null,
    onGroupByChange: vi.fn(),
    demoFilters: [],
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
  } as unknown as React.ComponentProps<typeof QualChartOptionsPanel>
  return render(<QualChartOptionsPanel {...props} />)
}

/** The closed trigger of the picker in the option row labelled `rowLabel`. */
function trigger(rowLabel: string): HTMLElement {
  const row = screen.getByText(rowLabel).closest('label') as HTMLElement
  return within(row).getByRole('combobox')
}

describe('#1561 — the closed picker shows the label only', () => {
  it.each(VALUE_MODES)('Value display = $label', ({ value, label, description }) => {
    renderPanel(value, 'total')
    const t = trigger('Value display')
    expect(t).toHaveTextContent(label)
    expect(t.textContent).not.toContain(description)
  })

  it.each(DENOMINATORS)('Denominator = $label', ({ value, label, description }) => {
    // The Denominator row renders only under Proportion.
    renderPanel('segment_proportion', value)
    const t = trigger('Denominator')
    expect(t).toHaveTextContent(label)
    expect(t.textContent).not.toContain(description)
  })

  it('positive control: the open menu still carries every description', () => {
    renderPanel('segment_proportion', 'coded')
    fireEvent.keyDown(trigger('Denominator'), { key: 'Enter' })
    const options = screen.getAllByRole('option')
    for (const d of DENOMINATORS) {
      const option = options.find(o => o.textContent?.includes(d.label))
      expect(option, d.label).toBeDefined()
      expect(option).toHaveTextContent(d.description)
    }
  })
})
