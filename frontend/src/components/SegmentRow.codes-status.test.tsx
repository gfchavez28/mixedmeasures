/**
 * #961 — a transcript row re-renders when the code list's STATUS changes, even
 * though `allCodes` does not.
 *
 * `SegmentRow` is `React.memo` with a hand-written comparator that lists every
 * prop it cares about. The page derives `allCodes` as a memoised
 * `codesData?.codes ?? []`, which stays the SAME empty array from "loading"
 * through "failed" — so a comparator that forgot `codesStatus` would freeze
 * every row's add-code popover on whatever it first said. A comparator is a
 * second list of the props, and a list is what drifts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SegmentRow from './SegmentRow'
import type { Code, Segment } from '@/lib/api'
import type { ListStatus } from '@/lib/list-status'

vi.mock('@/lib/theme-context', () => ({
  useTheme: () => ({ isDark: false, mode: 'light', setMode: vi.fn() }),
}))

afterEach(cleanup)

const SEGMENT = {
  id: 1, conversation_id: 7, text: 'What made the implementation uneven?',
  speaker_id: 3, speaker_name: 'Participant', speaker_color: null, speaker_color_index: 0,
  speaker_is_facilitator: false, sequence_order: 2, start_time: 73, end_time: 88,
  applied_codes: [], applied_code_details: [], excerpts: [], attached_notes: [],
} as unknown as Segment

const NO_CODES: Code[] = []            // ONE array, reused — exactly what the page's memo does
const CODE_MAP = new Map<number, Code>()
const onCodeChange = vi.fn()
const onClick = vi.fn()

function Row({ codesStatus }: { codesStatus: ListStatus }) {
  return (
    <SegmentRow
      segment={SEGMENT} isSelected onClick={onClick} conversationId={7} codes={NO_CODES}
      positionInSet={1} setSize={1} projectId={1} allCodes={NO_CODES} codesStatus={codesStatus}
      codeMap={CODE_MAP} onCodeChange={onCodeChange} showCodes
    />
  )
}

describe('SegmentRow — codesStatus reaches a memoised row (#961)', () => {
  it('a list that fails after loading changes what the open popover says', () => {
    const qc = new QueryClient()
    const { rerender } = render(<QueryClientProvider client={qc}><Row codesStatus="loading" /></QueryClientProvider>)

    fireEvent.click(screen.getByRole('button', { name: 'Add code' }))
    const popover = screen.getByRole('dialog', { name: 'Add a code' })
    expect(within(popover).getByRole('status')).toHaveTextContent('Loading codes…')

    rerender(<QueryClientProvider client={qc}><Row codesStatus="failed" /></QueryClientProvider>)
    expect(within(screen.getByRole('dialog', { name: 'Add a code' })).getByRole('status'))
      .toHaveTextContent('Codes could not be loaded.')
  })
})
