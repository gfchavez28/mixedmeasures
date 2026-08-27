/**
 * #785 / #790 on the DOCUMENT row — the third of three row implementations.
 *
 * ⚠️ This surface is here because ENUMERATING the siblings found it, not because anyone
 * reported it. #785 was filed against the transcript row alone; measured, the document
 * workbench had the identical ungated quote gutter (20 rendered rows, 20 stops, every one
 * named the same bare word) plus the #790 state divergence in mirror image — its label is
 * a VERB, so a segment carrying only a sub-segment quote announced "Unquote" while
 * pressing it CREATES a whole-segment one.
 *
 * The Observations clip row already had both fixes (#771/#747). Three implementations of
 * one row, and the two that were never diffed against it had drifted.
 */
import type React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DocumentSegmentRow } from './DocumentCodingWorkbench'

/** The row's own segment type (`VisibleSegment`) is module-private; read it off
 * the component so the fixture cannot drift from the prop it feeds. */
type RowSegment = React.ComponentProps<typeof DocumentSegmentRow>['segment']

vi.mock('@/lib/theme-context', () => ({
  useTheme: () => ({ isDark: false, mode: 'light', setMode: vi.fn() }),
}))

function makeSegment(over: Record<string, unknown> = {}): RowSegment {
  return {
    id: 1,
    document_id: 4,
    text: 'Implementation fidelity varied by site.',
    sequence_order: 2,
    heading_level: null,
    page_number: null,
    codes: [],
    applied_codes: [],
    applied_code_details: [],
    excerpt_info: { has_whole_segment: false, sub_segment_count: 0 },
    attached_notes: [],
    ...over,
  } as unknown as RowSegment
}

function renderRow(over: Record<string, unknown> = {}, isSelected = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DocumentSegmentRow
        segment={makeSegment(over)}
        isSelected={isSelected}
        isEditing={false}
        onClick={vi.fn()}
        onDoubleClick={vi.fn()}
        onEditSave={vi.fn()}
        onEditCancel={vi.fn()}
        showCodes
        showNotes
        showPageNumber={false}
        segmentationMode="paragraph"
        codeMap={new Map()}
        allCodes={[]}
        projectId={1}
        onCodeChange={vi.fn()}
        onToggleQuote={vi.fn()}
        onContextCodeApply={vi.fn()}
        canMerge={false}
        onMergeSegments={vi.fn()}
        onUnmergeSegment={vi.fn()}
        onUnsplitSegment={vi.fn()}
        codes={[]}
        selectedCount={0}
        documentName="Trailhead Implementation Guide"
        positionInSet={3}
        setSize={39}
      />
    </QueryClientProvider>
  )
}

afterEach(cleanup)

describe('#785 — an unselected document row costs no tab stops', () => {
  it('EVERY button in an unselected row is out of the tab order', () => {
    renderRow()
    const row = screen.getByRole('option')
    const buttons = within(row).getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const btn of buttons) {
      expect(btn).toHaveAttribute('tabindex', '-1')
    }
  })

  it('the quote control names its segment and joins the tab order when selected', () => {
    renderRow({}, true)
    const btn = screen.getByRole('button', { name: 'Quote segment 3' })
    expect(btn).not.toHaveAttribute('tabindex', '-1')
  })
})

describe('#790 — the document quote button announces what its press changes', () => {
  it('is not pressed with no quote', () => {
    renderRow()
    expect(screen.getByRole('button', { name: 'Quote segment 3' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('is pressed for a whole-segment quote', () => {
    renderRow({ excerpt_info: { has_whole_segment: true, sub_segment_count: 0 } })
    expect(screen.getByRole('button', { name: 'Quote segment 3' })).toHaveAttribute('aria-pressed', 'true')
  })

  /**
   * 🔴 The mirror-image defect: the old label was `hasExcerpt ? 'Unquote' : 'Quote'` over
   * the shape-AGNOSTIC flag, so this state announced the exact opposite of what the press
   * does. A verb naming the wrong action is the worst form of the #770 family.
   */
  it('is NOT pressed for a sub-segment-only quote — the press would CREATE one', () => {
    renderRow({ excerpt_info: { has_whole_segment: false, sub_segment_count: 2 } })
    expect(screen.getByRole('button', { name: 'Quote segment 3' })).toHaveAttribute('aria-pressed', 'false')
  })
})
