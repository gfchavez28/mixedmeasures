import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ChartTypeToolbar from './ChartTypeToolbar'

// #509 regression: chart types with NO requiresMetricTypeChange entry are not
// applicable to the current selection (e.g. vertical bar / cross-tab with 2+
// variables selected on a frequency metric). They previously rendered enabled
// and clicking wrote a dead chartType URL param.
//
// This mirrors getApplicableChartTypes('frequency_distribution', false, 2):
// vertical_bar, cross_tab, line get no entry at itemCount 2.
const freqTwoVars = {
  available: ['heatmap', 'stacked_bar', 'horizontal_bar', 'frequency_table'] as const,
  requiresMetricTypeChange: {
    heatmap: null,
    stacked_bar: null,
    horizontal_bar: null,
    frequency_table: null,
    table: ['mean', 'proportion'],
  },
}

function renderToolbar(onSelect = vi.fn()) {
  render(
    <ChartTypeToolbar
      available={[...freqTwoVars.available]}
      active="heatmap"
      onSelect={onSelect}
      requiresMetricTypeChange={freqTwoVars.requiresMetricTypeChange as never}
      hasGrouping={false}
    />,
  )
  return onSelect
}

describe('ChartTypeToolbar non-applicable types (#509)', () => {
  it('renders a type without a requiresMetricTypeChange entry as disabled', () => {
    renderToolbar()
    const verticalBar = screen.getByRole('button', { name: /vertical bar/i }) as HTMLButtonElement
    expect(verticalBar.disabled).toBe(true)
    expect(verticalBar.title).toMatch(/isn't available for the current selection/i)
    const crossTab = screen.getByRole('button', { name: /cross-tab/i }) as HTMLButtonElement
    expect(crossTab.disabled).toBe(true)
  })

  it('does not fire onSelect when a non-applicable type is clicked', () => {
    const onSelect = renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: /vertical bar/i }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps applicable and metric-type-switching types enabled', () => {
    const onSelect = renderToolbar()
    const stacked = screen.getByRole('button', { name: /stacked bar/i }) as HTMLButtonElement
    expect(stacked.disabled).toBe(false)
    // 'table' requires a metric-type switch — still a live control
    const table = screen.getByRole('button', { name: /summary table/i }) as HTMLButtonElement
    expect(table.disabled).toBe(false)
    fireEvent.click(stacked)
    expect(onSelect).toHaveBeenCalledWith('stacked_bar')
  })
})
