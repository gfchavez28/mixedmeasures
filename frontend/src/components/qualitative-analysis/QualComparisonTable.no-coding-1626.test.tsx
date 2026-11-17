/**
 * #1626 (D244): the comparison table SAYS how many of each group's participants have no
 * coding in scope — a header addition and one note, inside the component so the PNG and
 * the Canvas embed (which render this table) carry it. The words are
 * `lib/coding-completeness.ts`'s; the scope is the payload's, never inferred.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import QualComparisonTable from './QualComparisonTable'
import type { DemographicComparisonResponse } from '@/lib/api'
import { noCodingNote } from '@/lib/coding-completeness'

afterEach(() => cleanup())

function result(withoutA: number, withoutB: number, scope = 'every'): DemographicComparisonResponse {
  const cell = (count: number) => ({ count, proportion: count / 4, undefined_reason: null, passages: count })
  return {
    groups: ['Board', 'Staff'],
    group_totals: {
      Board: { n: 4, participants: 4, total_segments: 12, total_word_count: 0, without_coding: withoutA },
      Staff: { n: 4, participants: 4, total_segments: 12, total_word_count: 0, without_coding: withoutB },
    },
    codes: [{
      code_id: 1, code_name: 'Trust', category_name: null,
      by_group: { Board: cell(2), Staff: cell(1) }, delta_proportion: 0.25,
      test: { method: 'fisher_exact', statistic: null, p_value: 1, p_adjusted: 1, significant: false,
              effect_size: null, effect_size_label: null, min_attainable_p: 0.5, can_reach_significance: false },
    }],
    basis: { unit: 'participant', correction: 'discrete_holm', family_size: 1, family_reachable: 0,
             tarone_family_size: 0, alpha: 0.05, tested_groups: ['Board', 'Staff'], test_omitted_reason: null },
    scope: { conversations: 1, documents: 0, text_columns: 0, observations_left_out: 0,
             unassigned_passages: 0, participants_without_group: 0, no_coding_scope: scope },
  }
}

describe('QualComparisonTable — participants with no coding (#1626)', () => {
  it('adds the count to a group header with any, and says the note once', () => {
    const { container } = render(<QualComparisonTable data={result(2, 0)} />)
    expect(screen.getByRole('columnheader', { name: /Board \(n=4 participants · 2 with no coding\)/ })).toBeInTheDocument()
    // A group with none says nothing in its header (absence makes no claim).
    expect(screen.getByRole('columnheader', { name: /Staff \(n=4 participants\)/ })).toBeInTheDocument()
    const notes = container.querySelectorAll('[data-no-coding-note]')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toHaveTextContent(noCodingNote([['Board', 2], ['Staff', 0]], 'every')!)
  })

  it('names whose coding it is about from the payload (a coder scope)', () => {
    render(<QualComparisonTable data={result(0, 1, 'coders')} />)
    expect(screen.getByText(/Some participants have no coding by the coders shown here \(Board: 0, Staff: 1\)\./))
      .toBeInTheDocument()
  })

  it('POSITIVE CONTROL: no group with any — no note and no header addition', () => {
    const { container } = render(<QualComparisonTable data={result(0, 0)} />)
    expect(container.querySelector('[data-no-coding-note]')).toBeNull()
    expect(screen.queryByText(/with no coding/)).toBeNull()
  })
})
