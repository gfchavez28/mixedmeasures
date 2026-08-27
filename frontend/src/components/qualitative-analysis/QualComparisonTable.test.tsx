import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import QualComparisonTable from './QualComparisonTable'
import type { DemographicComparisonResponse } from '@/lib/api'

/**
 * #830(g) — a code applied NOWHERE is not a row of this table by default.
 *
 * Measured on the Ferncrest corpus: 32 rows, 20 of them reading `– – – 0`, on a
 * 12-code result. The payload is the whole codebook, which is correct — the
 * server cannot know whether a researcher is asking "what went unused?" — so
 * the suppression is a DISPLAY decision, and it states what it hid.
 */

const GROUPS = ['Ferncrest', 'Northgate']

function entry(name: string, counts: [number, number]) {
  return {
    code_id: name.length + counts[0] * 100 + counts[1],
    code_name: name,
    category_name: null,
    by_group: {
      Ferncrest: { count: counts[0], proportion: counts[0] / 10 },
      Northgate: { count: counts[1], proportion: counts[1] / 10 },
    },
    delta_proportion: null,
    test: null,
  }
}

function payload(codes: ReturnType<typeof entry>[]): DemographicComparisonResponse {
  return {
    groups: GROUPS,
    group_totals: {
      Ferncrest: { total_segments: 10, total_participants: 5 },
      Northgate: { total_segments: 10, total_participants: 5 },
    },
    codes,
  } as unknown as DemographicComparisonResponse
}

const USED_A = entry('Pacing concerns', [4, 2])
const USED_B = entry('Manipulatives', [1, 3])
const UNUSED_1 = entry('Never applied', [0, 0])
const UNUSED_2 = entry('Also never applied', [0, 0])

describe('QualComparisonTable — unused codes', () => {
  it('hides the codes applied to nothing, and says how many', () => {
    render(<QualComparisonTable data={payload([USED_A, UNUSED_1, USED_B, UNUSED_2])} />)

    expect(screen.getByText('Pacing concerns')).toBeInTheDocument()
    expect(screen.getByText('Manipulatives')).toBeInTheDocument()
    expect(screen.queryByText('Never applied')).not.toBeInTheDocument()
    expect(screen.queryByText('Also never applied')).not.toBeInTheDocument()

    // ⚠️ STATED, never silent — the Batch B rule that a bound chosen for
    // readability must not quietly decide relevance.
    expect(screen.getByText(/2 of 4 codes were applied to nothing here and are hidden/))
      .toBeInTheDocument()
  })

  it('brings them back on request, and says so', () => {
    render(<QualComparisonTable data={payload([USED_A, UNUSED_1, USED_B, UNUSED_2])} />)

    fireEvent.click(screen.getByRole('button', { name: 'Show them' }))

    expect(screen.getByText('Never applied')).toBeInTheDocument()
    expect(screen.getByText('Also never applied')).toBeInTheDocument()
    expect(screen.getByText(/Showing all 4 codes, including 2 applied to nothing/))
      .toBeInTheDocument()
    // …and back again.
    fireEvent.click(screen.getByRole('button', { name: 'Hide unused codes' }))
    expect(screen.queryByText('Never applied')).not.toBeInTheDocument()
  })

  it('says nothing at all when every code was applied', () => {
    render(<QualComparisonTable data={payload([USED_A, USED_B])} />)
    expect(screen.queryByText(/applied to nothing/)).not.toBeInTheDocument()
    expect(screen.getByText('Pacing concerns')).toBeInTheDocument()
  })

  it('does NOT hide everything when nothing was applied anywhere', () => {
    // The boundary that turns a readable table into a broken-looking screen: a
    // header with nothing under it reads as a failure, not as an answer.
    render(<QualComparisonTable data={payload([UNUSED_1, UNUSED_2])} />)
    expect(screen.getByText('Never applied')).toBeInTheDocument()
    expect(screen.getByText('Also never applied')).toBeInTheDocument()
    expect(screen.queryByText(/are hidden/)).not.toBeInTheDocument()
  })

  it('keeps a code that is used in only ONE group', () => {
    // Zero in a group is a FINDING; zero everywhere is an absence. The
    // predicate must be "every group", never "any group".
    const oneSided = entry('Only at Ferncrest', [3, 0])
    render(<QualComparisonTable data={payload([USED_A, oneSided, UNUSED_1])} />)
    expect(screen.getByText('Only at Ferncrest')).toBeInTheDocument()
    expect(screen.getByText(/1 of 3 codes/)).toBeInTheDocument()
  })
})
