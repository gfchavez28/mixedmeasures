/**
 * AddVariableGroupTile — inline "+ New variable group" affordance rendered
 * after the last bracket. Tests the click-to-create path and the dragActive
 * visual hint. Drop-target wiring (NEW_BRACKET_TILE_DROP_ID) is integration-
 * tested via the useCrosswalkDnD branch — covered separately by manual
 * verification since dnd-kit pointer simulation requires the full DndContext
 * setup (see Bracket.test.tsx for the pattern when needed later).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DndContext } from '@dnd-kit/core'
import { AddVariableGroupTile } from './AddVariableGroupTile'

afterEach(() => cleanup())

// useDroppable requires a DndContext ancestor; wrap the component for tests.
function renderTile(props: { onCreate: () => void; dragActive?: boolean }) {
  return render(
    <DndContext>
      <AddVariableGroupTile {...props} />
    </DndContext>,
  )
}

describe('AddVariableGroupTile', () => {
  it('renders an accessible button with the canonical label', () => {
    renderTile({ onCreate: vi.fn() })
    const tile = screen.getByTestId('add-variable-group-tile')
    expect(tile).toHaveAttribute('aria-label', 'Create a new variable group')
    expect(tile).toHaveTextContent('New variable group')
  })

  it('fires onCreate when clicked', () => {
    const onCreate = vi.fn()
    renderTile({ onCreate })
    fireEvent.click(screen.getByTestId('add-variable-group-tile'))
    expect(onCreate).toHaveBeenCalledOnce()
  })

  it('shows the static idle hint when no drag is active', () => {
    renderTile({ onCreate: vi.fn(), dragActive: false })
    expect(screen.getByTestId('add-variable-group-tile')).toHaveTextContent(
      'Click to create — or drop a column here to seed it',
    )
  })

  it('shows the drag-active hint when dragActive is true', () => {
    renderTile({ onCreate: vi.fn(), dragActive: true })
    expect(screen.getByTestId('add-variable-group-tile')).toHaveTextContent(
      'Drop a column here to start a new group',
    )
  })
})
