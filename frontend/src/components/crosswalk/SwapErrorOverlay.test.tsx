/**
 * SwapErrorOverlay — tests cover the isRetrying disabled-state contract
 * (#340: rapid-double-click guard on the Retry button).
 *
 * Visual rendering of the affected-columns list is exercised by manual
 * verification — these tests are scoped to the button-state contract that
 * the parent (CrosswalkView) depends on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SwapErrorOverlay } from './SwapErrorOverlay'
import type { ProjectColumnInfo } from './crosswalk-types'

afterEach(() => cleanup())

const columns: ProjectColumnInfo[] = [
  {
    id: 1,
    dataset_id: 10,
    dataset_name: 'Wave 1',
    dataset_color: null,
    column_code: 'q1',
    column_name: null,
    column_text: 'Trust',
    column_type: 'ordinal',
    scale_points: 5,
    scale_labels: null,
    recode_def_count: 0,
    equivalence_group_id: null,
    equivalence_group_label: null,
  },
]

function renderOverlay(overrides: Partial<Parameters<typeof SwapErrorOverlay>[0]> = {}) {
  return render(
    <SwapErrorOverlay
      open
      message="Type mismatch"
      affectedColumnIds={[1]}
      allColumns={columns}
      projectId={42}
      onRetry={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  )
}

describe('SwapErrorOverlay — isRetrying disabled-state (#340)', () => {
  it('Retry button is enabled and labeled "Retry swap" by default', () => {
    renderOverlay()
    const button = screen.getByRole('button', { name: /retry swap/i })
    expect(button).not.toBeDisabled()
  })

  it('Retry button is disabled and labeled "Retrying…" when isRetrying=true', () => {
    renderOverlay({ isRetrying: true })
    const button = screen.getByRole('button', { name: /retrying/i })
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Retrying…')
  })

  it('does not invoke onRetry when the disabled button is clicked', () => {
    const onRetry = vi.fn()
    renderOverlay({ isRetrying: true, onRetry })
    fireEvent.click(screen.getByRole('button', { name: /retrying/i }))
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('Cancel button stays enabled while isRetrying — user can dismiss', () => {
    renderOverlay({ isRetrying: true })
    expect(screen.getByRole('button', { name: /cancel/i })).not.toBeDisabled()
  })

  it('invokes onRetry when clicked in the default (non-retrying) state', () => {
    const onRetry = vi.fn()
    renderOverlay({ onRetry })
    fireEvent.click(screen.getByRole('button', { name: /retry swap/i }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
