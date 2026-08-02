/**
 * The Timeline chart type's applicability gates (slab 6c, §8q DEC-6c-1/-7):
 * needs an observation, and refuses the consensus layer scope — the timeline
 * is client-computed from the P-1 human-only clip payload, so offering it
 * under consensus would silently show the wrong layer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

import QualChartTypeToolbar from './QualChartTypeToolbar'

afterEach(cleanup)

function renderToolbar(over: Partial<React.ComponentProps<typeof QualChartTypeToolbar>> = {}) {
  return render(
    <TooltipProvider>
      <QualChartTypeToolbar
        chartType="heatmap"
        onChartTypeChange={vi.fn()}
        selectedCodeCount={3}
        conversationSourceCount={2}
        observationSourceCount={1}
        humanLayer
        {...over}
      />
    </TooltipProvider>,
  )
}

describe('the Timeline chart-type gate', () => {
  it('is enabled with an observation on the human layer', () => {
    renderToolbar()
    expect(screen.getByRole('button', { name: 'Timeline' })).toBeEnabled()
  })

  it('disables without an observation', () => {
    renderToolbar({ observationSourceCount: 0 })
    expect(screen.getByRole('button', { name: 'Timeline' })).toBeDisabled()
  })

  it('disables under the consensus layer scope', () => {
    renderToolbar({ humanLayer: false })
    expect(screen.getByRole('button', { name: 'Timeline' })).toBeDisabled()
  })
})
