/**
 * Tests for SuggestionGhostRow (Phase 4.1).
 *
 * Three visual states map onto suggestion shape:
 *   confident — cross-dataset cluster with members_paired populated (amber)
 *   unpaired  — cross-dataset cluster, pairing inconclusive (greyed)
 *   single    — single-dataset cluster (green)
 *
 * Action buttons (Accept / Dismiss / Edit) wire through the handlers.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SuggestionGhostRow } from './SuggestionGhostRow'
import type { DomainSuggestion, DomainSuggestedItem } from '@/lib/api/analysis-domains'

afterEach(() => cleanup())

function makeMember(
  member_id: number,
  dataset_id: number,
  dataset_name: string,
  label: string,
): DomainSuggestedItem {
  return {
    member_type: 'column',
    member_id,
    label,
    dataset_id,
    dataset_name,
    column_type: 'ordinal',
    reason: null,
  }
}

function confident(): DomainSuggestion {
  return {
    name: 'Wellness',
    members: [
      makeMember(1, 100, 'Board', 'BQ1'),
      makeMember(2, 200, 'Staff', 'SQ1'),
    ],
    members_paired: [[1, 2]],
    unpaired: false,
    pairing_reason: 'text_match:0.85',
  }
}

function unpaired(): DomainSuggestion {
  return {
    name: 'Climate',
    members: [
      makeMember(11, 100, 'Board', 'BQ7'),
      makeMember(12, 200, 'Staff', 'SQ4'),
    ],
    members_paired: [],
    unpaired: true,
    pairing_reason: null,
  }
}

function single(): DomainSuggestion {
  return {
    name: 'Demographics',
    members: [
      makeMember(21, 100, 'Board', 'BQ_age'),
      makeMember(22, 100, 'Board', 'BQ_tenure'),
    ],
    members_paired: [],
    unpaired: false,
    pairing_reason: null,
  }
}

describe('SuggestionGhostRow', () => {
  it('renders confident state with auto-paired badge + pair-slot indicators', () => {
    render(
      <SuggestionGhostRow
        suggestion={confident()}
        index={0}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    const region = screen.getByTestId('suggestion-ghost-0')
    expect(region).toHaveAttribute('data-state', 'confident')
    expect(screen.getByText('Auto-paired')).toBeInTheDocument()
    // Both paired members carry the same pair-slot label
    expect(screen.getAllByLabelText('pair 1')).toHaveLength(2)
  })

  it('renders unpaired state with "Pair manually" prompt', () => {
    render(
      <SuggestionGhostRow
        suggestion={unpaired()}
        index={1}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByTestId('suggestion-ghost-1')).toHaveAttribute('data-state', 'unpaired')
    expect(screen.getByText('Pair manually')).toBeInTheDocument()
    expect(screen.queryByText('Auto-paired')).not.toBeInTheDocument()
  })

  it('renders single-dataset state without pairing UI', () => {
    render(
      <SuggestionGhostRow
        suggestion={single()}
        index={2}
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByTestId('suggestion-ghost-2')).toHaveAttribute('data-state', 'single')
    expect(screen.queryByText('Auto-paired')).not.toBeInTheDocument()
    expect(screen.queryByText('Pair manually')).not.toBeInTheDocument()
  })

  it('Accept button fires onAccept with the suggestion', () => {
    const onAccept = vi.fn()
    const s = confident()
    render(
      <SuggestionGhostRow
        suggestion={s}
        index={0}
        onAccept={onAccept}
        onDismiss={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Accept suggestion Wellness/i }))
    expect(onAccept).toHaveBeenCalledWith(s)
  })

  it('Dismiss button fires onDismiss with the index', () => {
    const onDismiss = vi.fn()
    render(
      <SuggestionGhostRow
        suggestion={single()}
        index={5}
        onAccept={vi.fn()}
        onDismiss={onDismiss}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Dismiss suggestion Demographics/i }))
    expect(onDismiss).toHaveBeenCalledWith(5)
  })

  it('disables actions while accepting', () => {
    render(
      <SuggestionGhostRow
        suggestion={confident()}
        index={0}
        isAccepting
        onAccept={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Accept/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Dismiss/ })).toBeDisabled()
  })
})
