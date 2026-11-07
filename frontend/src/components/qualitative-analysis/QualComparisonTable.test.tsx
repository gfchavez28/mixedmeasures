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

/**
 * #1421 — a group with no segments in the material compared has no share.
 *
 * The server sends `proportion: null` with `undefined_reason: 'no_segments'` (it sent
 * 0.0, so the table printed "0.0%" beside "(n=0)" and a full-size Δ). The cell reads
 * `—`, the group is named once with the reason, and a REAL zero — a group with
 * segments that never used the code — still prints "0.0%".
 */
describe('QualComparisonTable — a group with no segments (#1421)', () => {
  const EMPTY = { count: 0, proportion: null, undefined_reason: 'no_segments' }

  function emptyGroupPayload(groups: string[], byGroup: Record<string, unknown>, totals: Record<string, number>) {
    return {
      groups,
      group_totals: Object.fromEntries(groups.map(g => [g, { total_segments: totals[g], total_word_count: 0 }])),
      codes: [{
        code_id: 1, code_name: 'Cost', category_name: null,
        by_group: byGroup, delta_proportion: null, test: null,
      }],
    } as unknown as DemographicComparisonResponse
  }

  function cellsOf(code: string) {
    const row = screen.getByText(code).closest('tr')!
    return Array.from(row.querySelectorAll('td')).map(td => td.textContent)
  }

  it('prints — for the empty group and names it with the reason', () => {
    render(<QualComparisonTable data={emptyGroupPayload(
      ['Interviewed', 'Survey only'],
      { Interviewed: { count: 1, proportion: 0.25, undefined_reason: null }, 'Survey only': EMPTY },
      { Interviewed: 4, 'Survey only': 0 },
    )} />)
    // [code, category, I count, I %, S count, S %, Δ, p, sig, effect]
    const cells = cellsOf('Cost')
    expect(cells[3]).toBe('25.0%')          // control: the group with segments keeps its share
    expect(cells[4]).toBe('0')              // the COUNT is a real 0 and stays one
    expect(cells[5]).toBe('—')              // HEAD: "0.0%"
    expect(cells[5]).not.toBe('0.0%')
    expect(cells[6]).toBe('—')
    expect(screen.getByText(/Nobody in this group has material in the sources compared/))
      .toBeInTheDocument()
    expect(screen.getByText('Survey only:')).toBeInTheDocument()
  })

  it('keeps a REAL zero beside an empty group (three groups)', () => {
    render(<QualComparisonTable data={emptyGroupPayload(
      ['Interviewed', 'Phone', 'Survey only'],
      {
        Interviewed: { count: 1, proportion: 0.25, undefined_reason: null },
        Phone: { count: 0, proportion: 0, undefined_reason: null },
        'Survey only': EMPTY,
      },
      { Interviewed: 4, Phone: 2, 'Survey only': 0 },
    )} />)
    // [code, category, I n, I %, P n, P %, S n, S %, p, sig, effect] — no χ² column:
    // no result here carries a statistic (#1323 D8).
    const cells = cellsOf('Cost')
    expect(cells[3]).toBe('25.0%')
    expect(cells[5]).toBe('0.0%')           // falsy-zero control: a measured 0 is not "—"
    expect(cells[7]).toBe('—')
    expect(screen.queryByText('Phone:')).not.toBeInTheDocument()
    expect(screen.getByText('Survey only:')).toBeInTheDocument()
  })

  it('says nothing when every group has a share', () => {
    render(<QualComparisonTable data={emptyGroupPayload(
      ['Interviewed', 'Phone'],
      {
        Interviewed: { count: 1, proportion: 0.25, undefined_reason: null },
        Phone: { count: 0, proportion: 0, undefined_reason: null },
      },
      { Interviewed: 4, Phone: 2 },
    )} />)
    expect(screen.queryByText(/Nobody in this group has material/)).not.toBeInTheDocument()
    expect(cellsOf('Cost')[5]).toBe('0.0%')
  })
})
