/**
 * The all-notes panel must consume EVERY group the response carries.
 *
 * #515 (documents) and #676 (observations) are the same defect twice: the
 * backend returned a group, the TS type declared it, and the panel consumed a
 * subset — so notes that plainly existed reported as "No notes yet".
 *
 * ⚠️ The original version of this file was titled *"the `documents` group must
 * actually render"* and asserted exactly that. It pinned the PARENT, so it
 * stayed green while observations were added and dropped a week later. The
 * `renders a note from every group` test below therefore counts notes by
 * WALKING the fixture — add a group to `RESPONSE` and the expected total moves
 * on its own, with no assertion to remember to update.
 */
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const list = vi.fn()
vi.mock('@/lib/api', () => ({
  allNotesApi: { list: (...a: unknown[]) => list(...a) },
}))
vi.mock('@/lib/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}))

import AllNotesPanel from './AllNotesPanel'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const DOC_NOTE = {
  id: 41,
  content: 'Check the fidelity rubric wording',
  sequence_number: 3,
  segment_id: 12,
  segment_text: 'Teachers receive 24 hours of training',
  created_at: '2026-07-01T10:00:00+00:00',
}

const OBS_NOTE = {
  id: 55,
  content: 'Pupil disengages when the group splits',
  sequence_number: 1,
  segment_id: 88,
  segment_text: 'Small-group rotation',
  created_at: '2026-07-02T10:00:00+00:00',
}

const RESPONSE = {
  conversations: [
    {
      conversation_id: 5,
      conversation_name: 'PI – Jefferson',
      general_notes: [{
        id: 7, content: 'Follow up on pacing', sequence_number: 1,
        segment_id: null, segment_text: null, created_at: '2026-07-01T09:00:00+00:00',
      }],
      speakers: [],
    },
  ],
  texts: [
    {
      column_id: 3,
      column_name: 'Open response',
      column_text: 'What would you change?',
      rows: [{
        dataset_row_id: 9,
        row_label: 'R-009',
        notes: [{
          id: 71, content: 'Mentions the same rubric', sequence_number: 1,
          dataset_value_id: 61, source_text: 'more planning time',
          created_at: '2026-07-01T11:00:00+00:00',
        }],
      }],
    },
  ],
  documents: [
    { document_id: 2, document_name: 'Implementation Guide', notes: [DOC_NOTE] },
  ],
  observations: [
    { observation_id: 4, observation_name: 'Session 1', notes: [OBS_NOTE] },
  ],
}

/** Count every note anywhere in a response, without naming the groups. */
function countNotes(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((s, x) => s + countNotes(x), 0)
  if (node && typeof node === 'object') {
    let n = 0
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === 'notes' || k === 'general_notes') && Array.isArray(v)) n += v.length
      else n += countNotes(v)
    }
    return n
  }
  return 0
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AllNotesPanel projectId={1} />
    </QueryClientProvider>,
  )
}

it('renders a note from every group the response carries (arity, not per-parent)', async () => {
  list.mockResolvedValue(RESPONSE)
  renderPanel()
  await screen.findByRole('button', { name: /Implementation Guide/ })

  // The header badge is the panel's own total. A group the panel does not
  // consume makes this short — which is precisely how #515 and #676 shipped.
  const expected = countNotes(RESPONSE)
  expect(expected).toBe(4)
  const header = screen.getByText('Notes').parentElement as HTMLElement
  expect(within(header).getByText(String(expected))).toBeInTheDocument()
})

it('renders the observations group with its notes and clip label (#676)', async () => {
  list.mockResolvedValue(RESPONSE)
  renderPanel()

  const obsGroup = await screen.findByRole('button', { name: /Session 1/ })
  expect(obsGroup).toHaveTextContent('1 note')
  obsGroup.click()
  await screen.findByText('Pupil disengages when the group splits')
  // The clip LABEL is the context line for an observation note.
  expect(screen.getByText('Small-group rotation')).toBeInTheDocument()
})

it('deep-links an observation note to its clip in the workbench', async () => {
  list.mockResolvedValue(RESPONSE)
  renderPanel()
  const obsGroup = await screen.findByRole('button', { name: /Session 1/ })
  obsGroup.click()
  await screen.findByText('Pupil disengages when the group splits')

  const link = screen.getByRole('link', { name: /Open this note's observation/ })
  expect(link).toHaveAttribute('href', '/projects/1/observations/4?clip=88')
})

it('offers an Observations source filter that isolates observation notes', async () => {
  list.mockResolvedValue(RESPONSE)
  renderPanel()
  await screen.findByRole('button', { name: /Session 1/ })

  screen.getByRole('button', { name: 'Observations' }).click()
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: /Implementation Guide/ })).toBeNull()
  })
  expect(screen.getByRole('button', { name: /Session 1/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /PI – Jefferson/ })).toBeNull()
})

it('renders the documents group with its notes and count', async () => {
  list.mockResolvedValue(RESPONSE)
  renderPanel()

  const docGroup = await screen.findByRole('button', { name: /Implementation Guide/ })
  expect(docGroup).toHaveTextContent('1 note')
  docGroup.click()
  await screen.findByText('Check the fidelity rubric wording')
})

it('offers a Documents source filter that isolates document notes', async () => {
  list.mockResolvedValue(RESPONSE)
  renderPanel()
  await screen.findByRole('button', { name: /Implementation Guide/ })

  const docsFilter = screen.getByRole('button', { name: 'Documents' })
  docsFilter.click()
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: /PI – Jefferson/ })).toBeNull()
  })
  expect(screen.getByRole('button', { name: /Implementation Guide/ })).toBeInTheDocument()

  // Conversations filter hides the document group again.
  screen.getByRole('button', { name: 'Conversations' }).click()
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: /Implementation Guide/ })).toBeNull()
  })
  expect(screen.getByRole('button', { name: /PI – Jefferson/ })).toBeInTheDocument()
})

it('empty-state copy names every source notes can come from', async () => {
  list.mockResolvedValue({ conversations: [], texts: [], documents: [], observations: [] })
  renderPanel()
  await screen.findByText('No notes yet')
  const copy = screen.getByText(/Notes are created in/)
  // Naming a subset is what told a researcher their observation note did not exist.
  for (const source of ['conversations', 'documents', 'observations', 'Text Coding']) {
    expect(copy).toHaveTextContent(source)
  }
})

it('groups are exposed as list items, not bare divs', async () => {
  // role="list" whose children carry no listitem role announces as an empty list.
  list.mockResolvedValue(RESPONSE)
  renderPanel()
  await screen.findByRole('button', { name: /Session 1/ })
  expect(screen.getAllByRole('listitem')).toHaveLength(4)
})
