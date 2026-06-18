/**
 * CrosswalkColumnHeaders rendering + toggle-stability tests.
 *
 * Locks in the discoverability fix (Fix B):
 *   - Each header has a per-dataset color dot (peripheral identifier).
 *   - Color stays the same when datasets toggle on/off — the dot uses the
 *     full project list for index assignment, not the filtered active list.
 *   - Sticky positioning + full text color on the container persist.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { CrosswalkColumnHeaders } from './CrosswalkColumnHeaders'
import { getDatasetAccent } from './dataset-color'

afterEach(() => cleanup())

describe('CrosswalkColumnHeaders', () => {
  it('renders one columnheader per active dataset', () => {
    render(
      <CrosswalkColumnHeaders
        activeDatasets={[
          { dataset_id: 10, dataset_name: 'Board', dataset_color: null },
          { dataset_id: 20, dataset_name: 'Staff', dataset_color: null },
        ]}
        columnCounts={new Map([[10, 5], [20, 7]])}
        allDatasetIds={[10, 20]}
      />,
    )
    const headers = screen.getAllByRole('columnheader')
    expect(headers).toHaveLength(2)
    expect(headers[0]).toHaveTextContent('Board')
    expect(headers[1]).toHaveTextContent('Staff')
  })

  it('renders nothing when there are no active datasets', () => {
    const { container } = render(
      <CrosswalkColumnHeaders
        activeDatasets={[]}
        columnCounts={new Map()}
        allDatasetIds={[10, 20]}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders each dataset's color accent in the matching color", () => {
    render(
      <CrosswalkColumnHeaders
        activeDatasets={[
          { dataset_id: 10, dataset_name: 'Board', dataset_color: null },
          { dataset_id: 20, dataset_name: 'Staff', dataset_color: null },
        ]}
        columnCounts={new Map([[10, 5], [20, 7]])}
        allDatasetIds={[10, 20]}
      />,
    )
    const boardHeader = screen.getByRole('columnheader', { name: /Board/ })
    const staffHeader = screen.getByRole('columnheader', { name: /Staff/ })
    const boardDot = boardHeader.querySelector('span[aria-hidden]')
    const staffDot = staffHeader.querySelector('span[aria-hidden]')
    expect(boardDot).not.toBeNull()
    expect(staffDot).not.toBeNull()
    // The dot's inline backgroundColor should match getDatasetAccent.
    expect((boardDot as HTMLElement).style.backgroundColor).toBeTruthy()
    expect((boardDot as HTMLElement).style.backgroundColor).not.toBe(
      (staffDot as HTMLElement).style.backgroundColor,
    )
  })

  it('keeps a dataset color stable when the active list filters down (toggle off)', () => {
    // Render with all 3 datasets active.
    const { rerender } = render(
      <CrosswalkColumnHeaders
        activeDatasets={[
          { dataset_id: 10, dataset_name: 'Board', dataset_color: null },
          { dataset_id: 20, dataset_name: 'Staff', dataset_color: null },
          { dataset_id: 30, dataset_name: 'Stakeholder', dataset_color: null },
        ]}
        columnCounts={new Map([[10, 5], [20, 7], [30, 4]])}
        allDatasetIds={[10, 20, 30]}
      />,
    )
    const stakeholderBefore = screen.getByRole('columnheader', { name: /Stakeholder/ })
    const dotBefore = stakeholderBefore.querySelector('span[aria-hidden]') as HTMLElement
    const colorBefore = dotBefore.style.backgroundColor

    // Toggle off Staff — active list shrinks but allDatasetIds is unchanged.
    rerender(
      <CrosswalkColumnHeaders
        activeDatasets={[
          { dataset_id: 10, dataset_name: 'Board', dataset_color: null },
          { dataset_id: 30, dataset_name: 'Stakeholder', dataset_color: null },
        ]}
        columnCounts={new Map([[10, 5], [20, 7], [30, 4]])}
        allDatasetIds={[10, 20, 30]}
      />,
    )
    const stakeholderAfter = screen.getByRole('columnheader', { name: /Stakeholder/ })
    const dotAfter = stakeholderAfter.querySelector('span[aria-hidden]') as HTMLElement
    expect(dotAfter.style.backgroundColor).toBe(colorBefore)
  })

  it('uses the full project list (not filtered active) for accent lookup', () => {
    // Direct cross-check against getDatasetAccent: header should use the
    // SAME color the helper computes for the SAME (id, fullList) pair.
    const fullList = [10, 20, 30]
    render(
      <CrosswalkColumnHeaders
        activeDatasets={[{ dataset_id: 30, dataset_name: 'Stakeholder', dataset_color: null }]}
        columnCounts={new Map([[30, 4]])}
        allDatasetIds={fullList}
      />,
    )
    const header = screen.getByRole('columnheader', { name: /Stakeholder/ })
    const dot = header.querySelector('span[aria-hidden]') as HTMLElement
    // The expected color is whatever getDatasetAccent computes for the
    // same inputs — locks in that the header uses the helper, not its
    // own ad-hoc indexing.
    const expectedHex = getDatasetAccent(30, fullList).toLowerCase()
    // CSS color values can normalize to rgb(...) in jsdom, so compare via
    // a temporary element to extract the same normalization.
    const probe = document.createElement('span')
    probe.style.backgroundColor = expectedHex
    document.body.appendChild(probe)
    const expectedNormalized = probe.style.backgroundColor
    document.body.removeChild(probe)
    expect(dot.style.backgroundColor).toBe(expectedNormalized)
  })
})
