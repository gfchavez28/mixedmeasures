/**
 * UnassignedPanel — covers commit 2 of the drag-first redesign:
 *   - Each card is individually draggable (UnassignedCard extraction).
 *   - Checkbox click still toggles after the draggable wrapper wraps
 *     the card body.
 *   - activeDragColumnId dims the source card.
 *   - Empty-state copy reflects the new "drag is primary" framing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DndContext } from '@dnd-kit/core'
import { UnassignedPanel } from './UnassignedPanel'
import type { ProjectColumnInfo } from './crosswalk-types'

afterEach(() => cleanup())

function col(overrides: Partial<ProjectColumnInfo> & { id: number; dataset_id: number }): ProjectColumnInfo {
  return {
    id: overrides.id,
    dataset_id: overrides.dataset_id,
    dataset_name: overrides.dataset_name ?? `Dataset ${overrides.dataset_id}`,
    dataset_color: null,
    column_code: overrides.column_code ?? `C${overrides.id}`,
    column_name: null,
    column_text: overrides.column_text ?? `Column ${overrides.id}`,
    column_type: overrides.column_type ?? 'ordinal',
    scale_points: overrides.scale_points ?? 5,
    scale_labels: overrides.scale_labels ?? null,
    recode_def_count: overrides.recode_def_count ?? 0,
    equivalence_group_id: null,
    equivalence_group_label: null,
  }
}

function renderPanel(overrides: {
  unassigned?: ProjectColumnInfo[]
  selectedIds?: Set<number>
  onToggle?: (id: number) => void
  activeDragColumnId?: number | null
} = {}) {
  return render(
    <DndContext>
      <UnassignedPanel
        unassigned={overrides.unassigned ?? [col({ id: 1, dataset_id: 10 })]}
        selectedIds={overrides.selectedIds ?? new Set()}
        onToggle={overrides.onToggle ?? vi.fn()}
        searchHighlightIds={new Set()}
        searchActive={false}
        onClose={vi.fn()}
        activeDragColumnId={overrides.activeDragColumnId ?? null}
      />
    </DndContext>,
  )
}

describe('UnassignedPanel — draggable card extraction (commit 2)', () => {
  it('renders one draggable card per unassigned column', () => {
    renderPanel({
      unassigned: [
        col({ id: 1, dataset_id: 10 }),
        col({ id: 2, dataset_id: 10 }),
      ],
    })
    expect(screen.getByTestId('unassigned-card-1')).toBeInTheDocument()
    expect(screen.getByTestId('unassigned-card-2')).toBeInTheDocument()
  })

  it('clicking the checkbox toggles selection (drag listeners do not block)', () => {
    const onToggle = vi.fn()
    renderPanel({
      unassigned: [col({ id: 1, dataset_id: 10 })],
      onToggle,
    })
    const checkbox = screen.getByRole('checkbox', { name: /Select C1 Column 1/i })
    fireEvent.click(checkbox)
    expect(onToggle).toHaveBeenCalledWith(1)
  })

  it('the source card dims (opacity-50) while dragging', () => {
    renderPanel({
      unassigned: [col({ id: 1, dataset_id: 10 })],
      activeDragColumnId: 1,
    })
    const card = screen.getByTestId('unassigned-card-1')
    expect(card.className).toContain('opacity-50')
  })

  it('non-source cards do not dim while another is being dragged', () => {
    renderPanel({
      unassigned: [
        col({ id: 1, dataset_id: 10 }),
        col({ id: 2, dataset_id: 10 }),
      ],
      activeDragColumnId: 1,
    })
    const otherCard = screen.getByTestId('unassigned-card-2')
    expect(otherCard.className).not.toContain('opacity-50')
  })

  it('empty-state copy reflects the new drag-first framing', () => {
    renderPanel({ unassigned: [] })
    // "All columns are assigned to a variable group" replaces the prior
    // "equivalence row" wording — the panel's secondary role is now
    // remove-from-bracket via drag-to-panel.
    expect(
      screen.getByText(/All columns are assigned to a variable group/i),
    ).toBeInTheDocument()
  })

  it('active-state hint mentions drag as the primary gesture', () => {
    renderPanel({ unassigned: [col({ id: 1, dataset_id: 10 })] })
    expect(
      screen.getByText(/Drag a card into a variable group/i),
    ).toBeInTheDocument()
  })

  it('selected card retains the selected style class', () => {
    renderPanel({
      unassigned: [col({ id: 1, dataset_id: 10 })],
      selectedIds: new Set([1]),
    })
    const card = screen.getByTestId('unassigned-card-1')
    // The selected style targets the inner <label>, but the test ID is
    // on the wrapping draggable div. Walk into the label.
    const label = card.querySelector('label')
    expect(label?.className).toContain('bg-mm-blue/15')
  })
})
