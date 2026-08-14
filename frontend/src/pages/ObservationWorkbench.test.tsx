/**
 * ObservationWorkbench (slab 3) — the segmentation surface.
 *
 * Pins the #436/#484 listbox pattern on the NEW surface (container listbox +
 * tabIndex + aria-activedescendant threaded to the last-selected row — the
 * wiring a screen reader needs to follow window-level arrow nav), the F2 label
 * edit path through the ONE window keydown listener, the point-event display
 * (D7), the two delete arms (unannotated = immediate + undoable; annotated =
 * confirm-first naming what is lost), the I/O/P marking keys, the nudge
 * COALESCING (one history entry per burst — the accumulation mutant is the
 * real pin; a timer-constant mutant shares the test's macrotask and passes
 * vacuously), the freeze/unfreeze flows on the single-sourced copy, and the
 * split/merge gestures with their id-recapturing undo closures.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { VirtuosoMockContext } from 'react-virtuoso'
import type { Code, Observation, ObservationSegment } from '@/lib/api'

const getObservation = vi.fn()
const listSegments = vi.fn()
const listObservations = vi.fn()
const updateClip = vi.fn()
const deleteClip = vi.fn()
const createClip = vi.fn()
const splitClip = vi.fn()
const mergeClips = vi.fn()
const unmergeClip = vi.fn()
const unsplitClip = vi.fn()
const freezeSegmentation = vi.fn()
const unfreezeSegmentation = vi.fn()
// ── Slab 4d: the coding rail's data surface ──
const listCodes = vi.fn()
const createCode = vi.fn()
const listCategories = vi.fn()
const listCoders = vi.fn()
const listObservationNotes = vi.fn()
const createObservationNote = vi.fn()
const listExcerpts = vi.fn()
const createExcerpt = vi.fn()
const bulkCreateExcerpts = vi.fn()
const deleteExcerpt = vi.fn()
const applyCode = vi.fn()
const removeCode = vi.fn()
const bulkCode = vi.fn()
const listMemos = vi.fn()
const coderCoverage = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    observationsApi: {
      ...actual.observationsApi,
      get: (...a: unknown[]) => getObservation(...a),
      listSegments: (...a: unknown[]) => listSegments(...a),
      list: (...a: unknown[]) => listObservations(...a),
      updateClip: (...a: unknown[]) => updateClip(...a),
      deleteClip: (...a: unknown[]) => deleteClip(...a),
      createClip: (...a: unknown[]) => createClip(...a),
      splitClip: (...a: unknown[]) => splitClip(...a),
      mergeClips: (...a: unknown[]) => mergeClips(...a),
      unmergeClip: (...a: unknown[]) => unmergeClip(...a),
      unsplitClip: (...a: unknown[]) => unsplitClip(...a),
      freezeSegmentation: (...a: unknown[]) => freezeSegmentation(...a),
      unfreezeSegmentation: (...a: unknown[]) => unfreezeSegmentation(...a),
    },
    codesApi: {
      ...actual.codesApi,
      list: (...a: unknown[]) => listCodes(...a),
      create: (...a: unknown[]) => createCode(...a),
    },
    categoriesApi: {
      ...actual.categoriesApi,
      list: (...a: unknown[]) => listCategories(...a),
    },
    authApi: {
      ...actual.authApi,
      listCoders: (...a: unknown[]) => listCoders(...a),
    },
    notesApi: {
      ...actual.notesApi,
      listForObservation: (...a: unknown[]) => listObservationNotes(...a),
      createForObservation: (...a: unknown[]) => createObservationNote(...a),
    },
    excerptsApi: {
      ...actual.excerptsApi,
      list: (...a: unknown[]) => listExcerpts(...a),
      create: (...a: unknown[]) => createExcerpt(...a),
      bulkCreate: (...a: unknown[]) => bulkCreateExcerpts(...a),
      delete: (...a: unknown[]) => deleteExcerpt(...a),
    },
    codingApi: {
      ...actual.codingApi,
      applyCode: (...a: unknown[]) => applyCode(...a),
      removeCode: (...a: unknown[]) => removeCode(...a),
      bulkCode: (...a: unknown[]) => bulkCode(...a),
    },
    memosApi: {
      ...actual.memosApi,
      list: (...a: unknown[]) => listMemos(...a),
    },
    codeAnalysisApi: {
      ...actual.codeAnalysisApi,
      coderCoverage: (...a: unknown[]) => coderCoverage(...a),
    },
  }
})

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1 }),
}))

// The workbench reads only `user` (the active coder id for INV-6 scoping).
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

// The pane is slab-4-adjacent chrome; the list is what this file pins.
vi.mock('@/components/VideoPane', () => ({ default: () => null }))

import ObservationWorkbench from './ObservationWorkbench'

const OBSERVATION = {
  id: 5,
  project_id: 1,
  name: 'Classroom Obs — Day 2',
  description: null,
  created_at: '2026-07-17T00:00:00+00:00',
  updated_at: '2026-07-17T00:00:00+00:00',
  segmentation_frozen_at: null,
  segment_count: 3,
  coded_segment_count: 0,
  code_count: 0,
  media_filename: null,
  media_format: null,
  media_type: null,
  media_duration_seconds: 3260,
  media_offset_seconds: 0,
  media_is_vbr: null,
  has_media: false,
  media_size_bytes: null,
  media_version: null,
} as Observation

/** An excerpt row as the wire sends it — every shape field present.
 *  Module-scope since #621: the slab-5b quote tests and the time-op quote-carry
 *  tests both build rows, and a second copy is a fixture that drifts. */
const excerpt = (
  id: number,
  segment_id: number,
  over: Partial<{ start_offset: number | null; start_time: number | null; end_time: number | null }> = {},
) => ({
  id, segment_id, dataset_value_id: null,
  start_offset: null, end_offset: null, start_time: null, end_time: null,
  excerpt_text: '', conversation_id: null, conversation_name: null,
  observation_id: 5, observation_name: 'Room 12', speaker_name: null,
  segment_timestamp: null, note: null, has_note: false, created_at: '2026-07-18T00:00:00+00:00',
  ...over,
})

const clip = (
  id: number, start: number, end: number, text: string,
  extra: Partial<ObservationSegment> = {},
): ObservationSegment => ({
  id,
  sequence_order: 0,
  start_time: start,
  end_time: end,
  text,
  applied_codes: [],
  applied_code_details: [],
  attached_notes: [],
  created_at: '2026-07-17T00:00:00+00:00',
  ...extra,
})

// Uncategorized codes → plain-digit shortcuts resolve by numeric_id (no chords).
const makeCode = (id: number, numericId: number, name: string, extra: Partial<Code> = {}): Code => ({
  id,
  project_id: 1,
  numeric_id: numericId,
  name,
  description: null,
  color: null,
  is_universal: false,
  is_active: true,
  created_at: '2026-07-17T00:00:00+00:00',
  updated_at: '2026-07-17T00:00:00+00:00',
  usage_count: 0,
  category_id: null,
  category_name: null,
  category_color: null,
  category_order: null,
  ...extra,
})
const CODES = [makeCode(7, 1, 'Engagement'), makeCode(8, 2, 'Disruption')]

// Multi-digit minutes + sub-second boundaries per the fixture rule.
const CLIPS = [
  clip(11, 0, 130, 'Arrival & settling'),
  clip(12, 494.3, 494.3, 'Bell interruption'),          // point event (D7)
  clip(13, 760, 902.4, ''),                              // unlabeled
  clip(14, 1000, 1100, 'Coded moment', {
    applied_codes: [7],
    applied_code_details: [{ code_id: 7, user_id: 1, attribution: null, is_universal: false }],
    // #740: MORE THAN ONE note, on the clip that already carries the extras.
    // A zero-note fixture cannot tell a per-note control from a count badge —
    // the old code rendered nothing there either, so both pass. The defect only
    // shows when a clip has several notes and you want a particular one.
    // Attached here rather than as a fifth clip: two other tests assert the
    // list's length and its end-to-end merge behaviour.
    // ⚠️ sequence_numbers that do NOT match their positions, and that is the
    // whole point of the fixture — a 1,2,3 set cannot tell "numbered by the
    // note" from "numbered by where it sits". #747 made these real (they were
    // all 0, so the badge had to count positions for one release); the gap here
    // is what deleting note 2 leaves behind, which a stable label must survive.
    attached_notes: [
      { id: 901, sequence_number: 1 },
      { id: 902, sequence_number: 3 },
      { id: 903, sequence_number: 7 },
    ],
  }),
]

function renderWorkbench() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/obs/5']}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 1000, itemHeight: 48 }}>
          <Routes>
            <Route path="/obs/:observationId" element={<ObservationWorkbench />} />
          </Routes>
        </VirtuosoMockContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// jsdom 29's Storage proxy has uneven function binding under this vitest config;
// install a clean in-memory shim per test (the useBlindMode.test pattern) so the
// blind-reveal + collapsed-rail persistence starts fresh every test.
let store: Record<string, string> = {}

beforeEach(() => {
  store = {}
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v) },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
    },
  })
  vi.clearAllMocks()
  getObservation.mockResolvedValue(OBSERVATION)
  listSegments.mockResolvedValue(CLIPS)
  listObservations.mockResolvedValue([OBSERVATION])
  updateClip.mockResolvedValue(CLIPS[0])
  deleteClip.mockResolvedValue({ deleted: true })
  // Slab 4d rail defaults: single coder, one code, no notes/excerpts/memos.
  listCodes.mockResolvedValue({ codes: CODES, total: CODES.length })
  listCategories.mockResolvedValue({ categories: [] })
  createCode.mockResolvedValue(makeCode(77, 3, 'Newly made'))
  listCoders.mockResolvedValue([{ id: 1, username: 'Alice', display_color: null, archived: false }])
  listObservationNotes.mockResolvedValue([])
  createObservationNote.mockResolvedValue({ id: 900 })
  listExcerpts.mockResolvedValue({ excerpts: [], total: 0 })
  createExcerpt.mockResolvedValue({ id: 950 })
  bulkCreateExcerpts.mockResolvedValue({ created_count: 1, skipped_count: 0 })
  deleteExcerpt.mockResolvedValue({ deleted: true })
  applyCode.mockResolvedValue({ applied: true })
  removeCode.mockResolvedValue({ removed: true })
  bulkCode.mockResolvedValue({ results: [] })
  listMemos.mockResolvedValue({ memos: [], total: 0 })
  coderCoverage.mockResolvedValue({ coders: [], count: 0 })
})

afterEach(cleanup)

describe('the clip listbox (#436/#484 pattern)', () => {
  it('renders a focusable listbox whose rows are options, with point events and the unlabeled placeholder', async () => {
    renderWorkbench()
    const listbox = await screen.findByRole('listbox', { name: 'Clips' })
    expect(listbox).toHaveAttribute('tabindex', '0')
    expect(listbox).toHaveAttribute('aria-multiselectable', 'true')

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(4)
    // Point event renders "point", never a zero duration.
    expect(screen.getByText('point')).toBeInTheDocument()
    // Unlabeled placeholder teaches the F2 path.
    expect(screen.getByText(/Unlabeled clip — press F2/)).toBeInTheDocument()
  })

  it('clicking a row selects it and threads aria-activedescendant to the container', async () => {
    renderWorkbench()
    const listbox = await screen.findByRole('listbox', { name: 'Clips' })
    expect(listbox).not.toHaveAttribute('aria-activedescendant')

    const row = (await screen.findAllByRole('option'))[0]
    fireEvent.click(row)

    await waitFor(() => {
      expect(row).toHaveAttribute('aria-selected', 'true')
      expect(listbox).toHaveAttribute('aria-activedescendant', 'clip-11')
    })
  })

  it('#751: every option states its position and the real set size', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    expect(rows.length).toBeGreaterThan(0)

    // ⚠️ Asserted against the FIXTURE's clip count, deliberately not against
    // `rows.length`. jsdom gives Virtuoso no viewport so it mounts every row,
    // making those two numbers coincide here — and a test that compares the
    // rendered count to itself would pass on exactly the bug this fixes (NVDA
    // announced "1 of 7" on a 13-clip observation because it counted the DOM).
    for (const [i, row] of rows.entries()) {
      expect(row).toHaveAttribute('aria-setsize', String(CLIPS.length))
      expect(row, 'aria-posinset is 1-based').toHaveAttribute('aria-posinset', String(i + 1))
    }
  })
})

describe('F2 label editing through the window keydown layer', () => {
  it('F2 on a single-selected clip opens the editor; Enter commits via updateClip', async () => {
    renderWorkbench()
    const row = (await screen.findAllByRole('option'))[2] // the unlabeled clip
    fireEvent.click(row)

    fireEvent.keyDown(window, { key: 'F2' })
    const input = await screen.findByRole('textbox', { name: 'Clip label' })

    fireEvent.change(input, { target: { value: 'Group work' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(updateClip).toHaveBeenCalledWith(1, 5, 13, { text: 'Group work' })
    })
  })
})

describe('delete — the two arms', () => {
  it('an unannotated clip deletes immediately (no dialog)', async () => {
    renderWorkbench()
    await screen.findAllByRole('option')
    fireEvent.click(screen.getByRole('button', { name: /Delete clip 0:00\.0/ }))

    await waitFor(() => {
      expect(deleteClip).toHaveBeenCalledWith(1, 5, 11)
    })
    expect(screen.queryByText('Delete this clip?')).not.toBeInTheDocument()
  })

  it('an annotated clip confirms first, naming what is lost, and only then deletes', async () => {
    renderWorkbench()
    await screen.findAllByRole('option')
    fireEvent.click(screen.getByRole('button', { name: /Delete clip 16:40\.0/ }))

    // Confirm dialog up, nothing deleted yet.
    expect(await screen.findByText('Delete this clip?')).toBeInTheDocument()
    expect(deleteClip).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete clip' }))
    await waitFor(() => {
      expect(deleteClip).toHaveBeenCalledWith(1, 5, 14)
    })
  })
})

describe('slab 3d — marking through the window keydown layer', () => {
  it('I then O commits a clip at the marked range (playhead 0 with no media)', async () => {
    createClip.mockResolvedValue(clip(99, 0, 0, ''))
    renderWorkbench()
    await screen.findAllByRole('option')

    fireEvent.keyDown(window, { key: 'i' })
    fireEvent.keyDown(window, { key: 'o' })

    await waitFor(() => {
      expect(createClip).toHaveBeenCalledWith(1, 5, { start_time: 0, end_time: 0 })
    })
  })

  it('P drops a point event at the playhead', async () => {
    createClip.mockResolvedValue(clip(99, 0, 0, ''))
    renderWorkbench()
    await screen.findAllByRole('option')

    fireEvent.keyDown(window, { key: 'p' })

    await waitFor(() => {
      expect(createClip).toHaveBeenCalledWith(1, 5, { start_time: 0, end_time: 0 })
    })
  })

  it('Escape cancels the armed mark — O afterwards is not a gesture', async () => {
    renderWorkbench()
    await screen.findAllByRole('option')

    fireEvent.keyDown(window, { key: 'i' })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'o' })

    await new Promise(r => setTimeout(r, 20))
    expect(createClip).not.toHaveBeenCalled()
  })
})

describe('slab 3d — boundary nudges coalesce into ONE history entry', () => {
  it('two quick ArrowRight nudges commit one PATCH; undo restores the pre-burst value', async () => {
    renderWorkbench()
    const row = (await screen.findAllByRole('option'))[0] // clip 11, end 130
    fireEvent.click(row)
    await waitFor(() => expect(row).toHaveAttribute('aria-selected', 'true'))

    vi.useFakeTimers()
    try {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      await vi.advanceTimersByTimeAsync(700) // the 600ms coalescing window
    } finally {
      vi.useRealTimers()
    }

    await waitFor(() => {
      expect(updateClip).toHaveBeenCalledTimes(1)
      expect(updateClip).toHaveBeenCalledWith(1, 5, 11, { end_time: 130.2 })
    })

    // ONE entry for the whole burst: undo restores the ORIGINAL boundary.
    // redo()'s PATCH resolves async before the history enables — wait for Undo
    // rather than racing the flip (the CI-flake shape from the merge test).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => {
      expect(updateClip).toHaveBeenLastCalledWith(1, 5, 11, { end_time: 130 })
    })
  })
})

describe('slab 3e — the freeze flow', () => {
  it('freeze confirms with the single-sourced consequences, then calls the API', async () => {
    freezeSegmentation.mockResolvedValue({ ...OBSERVATION, segmentation_frozen_at: 'now' })
    renderWorkbench()
    await screen.findAllByRole('option')

    fireEvent.click(screen.getByRole('button', { name: 'Freeze segmentation' }))
    // The module's copy, not a re-typed sentence (the drift scan owns the rest).
    expect(await screen.findByText(/did we apply the same codes/)).toBeInTheDocument()
    expect(freezeSegmentation).not.toHaveBeenCalled()

    // Two buttons now share the name (toolbar + dialog confirm) — the confirm
    // is the last in DOM order (the Radix portal appends).
    const buttons = screen.getAllByRole('button', { name: 'Freeze segmentation' })
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(freezeSegmentation).toHaveBeenCalledWith(1, 5))
  })

  it('zero clips: the freeze control is disabled and its NAME says why (#559)', async () => {
    listSegments.mockResolvedValue([])
    renderWorkbench()
    const btn = await screen.findByRole('button', {
      name: 'Freeze segmentation — there are no clips to freeze yet',
    })
    expect(btn).toBeDisabled()
  })

  it('frozen: pill + Unfreeze flow with the #615 consequence; deletes disabled; no handles-era edits', async () => {
    getObservation.mockResolvedValue({ ...OBSERVATION, segmentation_frozen_at: '2026-07-17T00:00:00+00:00' })
    unfreezeSegmentation.mockResolvedValue(OBSERVATION)
    renderWorkbench()
    await screen.findAllByRole('option')

    expect(screen.getByRole('img', { name: /Segmentation frozen/ })).toBeInTheDocument()
    // Clip-SET affordances disabled, not hidden.
    for (const btn of screen.getAllByRole('button', { name: /^Delete clip/ })) {
      expect(btn).toBeDisabled()
    }

    fireEvent.click(screen.getByRole('button', { name: /Unfreeze…/ }))
    expect(await screen.findByText(/drops this observation’s consensus layer/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Unfreeze' }))
    await waitFor(() => expect(unfreezeSegmentation).toHaveBeenCalledWith(1, 5))
  })

  /**
   * #754 — measured with NVDA on a frozen observation: tabbing the toolbar
   * announced Previous/Rename/Follow/Colleagues/Unfreeze and nothing else.
   * Split, Merge, Undo, Redo and every Delete were ABSENT, because native
   * `disabled` takes a control out of the tab order — so a keyboard user never
   * learned those operations exist, nor that the reason was the agreed cut set.
   * The walkthrough had predicted they would announce as "unavailable"; they
   * did not, they were skipped.
   */
  it('frozen: the segmentation controls stay reachable and name the reason (#754)', async () => {
    getObservation.mockResolvedValue({ ...OBSERVATION, segmentation_frozen_at: '2026-07-17T00:00:00+00:00' })
    renderWorkbench()
    await screen.findAllByRole('option')

    for (const label of ['Split clip at playhead', 'Merge selected clips']) {
      const btn = screen.getByRole('button', { name: `${label} — unavailable while the clip set is frozen` })
      expect(btn).not.toBeDisabled()          // reachable by Tab...
      expect(btn).toHaveAttribute('aria-disabled', 'true')   // ...and announced unavailable
      // The click guard, at the call site: aria-disabled does not stop
      // activation on its own, and splitting a frozen set would 409 anyway.
      fireEvent.click(btn)
    }
    expect(splitClip).not.toHaveBeenCalled()
    expect(mergeClips).not.toHaveBeenCalled()

    // The badge states the same consequence for a browse-mode reader, who never
    // tabs to a control at all.
    expect(screen.getByRole('img', { name: /Splitting, merging and deleting clips are unavailable/ }))
      .toBeInTheDocument()
  })

  it('unfrozen: a transient precondition keeps the plain name and no tab stop', async () => {
    renderWorkbench()
    await screen.findAllByRole('option')
    // Nothing selected → merge is unavailable for a reason that resolves itself.
    const merge = screen.getByRole('button', { name: 'Merge selected clips' })
    expect(merge).toBeDisabled()
    expect(merge).not.toHaveAttribute('aria-disabled')
  })
})

// ── #654: the clip-row context menu ────────────────────────────────────────
//
// Observations was the only workbench without one, and the comment that
// justified the absence ("rows are role=option with no tab stop, so a row menu
// would be mouse-only") was contradicted by SegmentRow — also role="option",
// with the richest menu in the app. What these pin is the part that could
// silently rot: the Radix wrapper must not disturb the #436/#484 listbox
// ownership, right-click must not destroy a multi-selection, and the frozen
// split (D22) must separate segmentation from annotation.
describe('#654 — the clip-row context menu', () => {
  const openMenuOn = async (row: HTMLElement) => {
    fireEvent.contextMenu(row)
    return screen.findByRole('menu')
  }

  it('right-clicking an UNSELECTED row selects it and offers every action', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    expect(rows[0]).toHaveAttribute('aria-selected', 'false')

    const menu = await openMenuOn(rows[0])
    expect(rows[0]).toHaveAttribute('aria-selected', 'true')

    for (const label of [
      'Apply Code', 'Add Note', 'Rename Label', 'Quote Clip',
      'Quote a Portion…', 'Split at Playhead', 'Merge Selected Clips', 'Delete Clip',
    ]) {
      expect(within(menu).getByText(label)).toBeInTheDocument()
    }
  })

  // The wrapper is the risk: Radix's Root renders no DOM and Trigger asChild
  // clones, but a future refactor to a non-asChild trigger would insert a div
  // between the presentational Item and the option — breaking the ownership a
  // screen reader needs to follow window-level arrow nav.
  it('leaves the listbox → presentation → option ownership intact', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    const wrapper = rows[0].parentElement!
    expect(wrapper).toHaveAttribute('role', 'presentation')
    expect(wrapper.closest('[role="listbox"]')).not.toBeNull()
  })

  it('right-clicking INSIDE a multi-selection keeps it, so Merge stays reachable', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { shiftKey: true })
    await waitFor(() => expect(rows[1]).toHaveAttribute('aria-selected', 'true'))

    const menu = await openMenuOn(rows[1])
    expect(rows[0]).toHaveAttribute('aria-selected', 'true')
    expect(within(menu).getByText('Merge Selected Clips').closest('[role="menuitem"]'))
      .not.toHaveAttribute('data-disabled')
  })

  it('splits the clip the menu was opened on, even when the toolbar cannot', async () => {
    getObservation.mockResolvedValue({
      ...OBSERVATION, media_type: 'video' as const, media_filename: 'nasa.mp4',
      media_format: 'mp4', media_size_bytes: 1234, media_version: 'v1', has_media: true,
    })
    splitClip.mockResolvedValue([clip(21, 0, 1, ''), clip(22, 1, 130, '')])
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    const splitBtn = screen.getByRole('button', { name: 'Split clip at playhead' })

    fireEvent.click(rows[0])                       // clip 11 (0–130)
    fireEvent.keyDown(window, { key: '>' })        // playhead → 1.0s, inside clip 11
    await waitFor(() => expect(splitBtn).not.toBeDisabled())

    // Extend to a RANGE: the toolbar's split is single-selection only, so it
    // goes dead — and usePlayback's selection-seek keys on selectedSegments[0],
    // which did not change, so the playhead stays put at 1.0s.
    fireEvent.click(rows[1], { shiftKey: true })   // + clip 12
    await waitFor(() => expect(splitBtn).toBeDisabled())

    // ...but the row menu still splits, because it carries its own clip.
    const menu = await openMenuOn(rows[0])
    const splitItem = within(menu).getByText('Split at Playhead').closest('[role="menuitem"]')!
    expect(splitItem).not.toHaveAttribute('data-disabled')
    fireEvent.click(splitItem)
    await waitFor(() => expect(splitClip).toHaveBeenCalledWith(1, 5, 11, 1))
  })

  it('D22: frozen disables the clip-SET items and leaves annotation alone', async () => {
    getObservation.mockResolvedValue({
      ...OBSERVATION, segmentation_frozen_at: '2026-07-20T00:00:00+00:00',
    })
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    const menu = await openMenuOn(rows[0])
    const item = (label: string) =>
      within(menu).getByText(label).closest('[role="menuitem"]')!

    for (const label of ['Split at Playhead', 'Merge Selected Clips', 'Delete Clip']) {
      expect(item(label)).toHaveAttribute('data-disabled')
    }
    for (const label of ['Rename Label', 'Quote Clip', 'Quote a Portion…']) {
      expect(item(label)).not.toHaveAttribute('data-disabled')
    }
  })

  it('the quote item reads the WHOLE-clip shape, so a sub-clip quote does not say "Unquote"', async () => {
    // A time-range quote on clip 11 makes it "quoted" for DISPLAY (#621/D30)
    // but the `s` toggle is shape-EXACT — offering "Unquote" here would delete
    // the researcher's sub-clip range instead of a whole-clip one.
    listExcerpts.mockResolvedValue({
      excerpts: [excerpt(801, 11, { start_time: 10, end_time: 20 })],
      total: 1,
    })
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    const menu = await openMenuOn(rows[0])
    expect(within(menu).getByText('Quote Clip')).toBeInTheDocument()
  })
})

describe('slab 3e — split at playhead / merge selection', () => {
  const VIDEO_OBS = {
    ...OBSERVATION,
    media_type: 'video' as const,
    media_filename: 'nasa.mp4',
    media_format: 'mp4',
    media_size_bytes: 1234,
    media_version: 'v1',
    has_media: true,
  }

  it('split gates on the playhead being strictly inside the selected clip, then wires undo to BOTH half ids', async () => {
    getObservation.mockResolvedValue(VIDEO_OBS)
    splitClip.mockResolvedValue([clip(21, 0, 1, ''), clip(22, 1, 130, '')])
    renderWorkbench()
    const row = (await screen.findAllByRole('option'))[0] // clip 11: 0–130
    fireEvent.click(row)

    const splitBtn = screen.getByRole('button', { name: 'Split clip at playhead' })
    expect(splitBtn).toBeDisabled() // playhead 0 = ON the boundary, not inside

    fireEvent.keyDown(window, { key: '>' }) // +1s step → playhead 1.0, inside
    await waitFor(() => expect(splitBtn).not.toBeDisabled())

    fireEvent.click(splitBtn)
    await waitFor(() => expect(splitClip).toHaveBeenCalledWith(1, 5, 11, 1))

    // redo() captures BOTH half ids from the resolved response and only then
    // enables the history — wait for Undo rather than racing the id capture.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(unsplitClip).toHaveBeenCalledWith(1, 5, [21, 22]))
  })

  it('merge needs ≥2 selected; undo unmerges by the captured merged id', async () => {
    mergeClips.mockResolvedValue(clip(31, 0, 494.3, 'Arrival & settling / Bell interruption'))
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    const mergeBtn = screen.getByRole('button', { name: 'Merge selected clips' })

    fireEvent.click(rows[0])
    expect(mergeBtn).toBeDisabled()

    fireEvent.click(rows[1], { shiftKey: true }) // range-select 11+12
    await waitFor(() => expect(mergeBtn).not.toBeDisabled())

    fireEvent.click(mergeBtn)
    await waitFor(() => expect(mergeClips).toHaveBeenCalledWith(1, 5, [11, 12]))

    // redo() captures the merged id from the resolved response and only then
    // enables the history — wait for Undo rather than racing the id capture
    // (this is the assertion that flaked 0-calls under CI load).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(unmergeClip).toHaveBeenCalledWith(1, 5, 31))
  })

  // ── #621: the quote carry's client half ──────────────────────────────────
  //
  // The placement rule is the SERVER's (`_clip_excerpt_carry_plan`); what the
  // client owes is (a) not serving a stale quote cache after the op — the row
  // indicator and the `s`-verb duplicate guard both read it — and (b) saying
  // the event happened, since only the resulting STATE is visible on screen.

  it('a split invalidates the excerpt cache and announces the quotes it kept', async () => {
    getObservation.mockResolvedValue(VIDEO_OBS)
    splitClip.mockResolvedValue([clip(21, 0, 1, ''), clip(22, 1, 130, '')])
    listExcerpts.mockResolvedValue({
      excerpts: [
        excerpt(801, 11, { start_time: 10, end_time: 20 }),
        excerpt(802, 11),
      ],
      total: 2,
    })
    renderWorkbench()
    const row = (await screen.findAllByRole('option'))[0]
    fireEvent.click(row)
    await waitFor(() => expect(listExcerpts).toHaveBeenCalled())
    const before = listExcerpts.mock.calls.length

    fireEvent.keyDown(window, { key: '>' })
    const splitBtn = screen.getByRole('button', { name: 'Split clip at playhead' })
    await waitFor(() => expect(splitBtn).not.toBeDisabled())
    fireEvent.click(splitBtn)

    await waitFor(() => expect(splitClip).toHaveBeenCalled())
    // Refetched, not served stale.
    await waitFor(() => expect(listExcerpts.mock.calls.length).toBeGreaterThan(before))
    // Counts the INPUT (2 quotes on clip 11), never a prediction of placement.
    await waitFor(() => expect(screen.getByText('Clip split. 2 quotes kept.')).toBeInTheDocument())
  })

  it('a merge announces the quotes carried, singular when there is one', async () => {
    listExcerpts.mockResolvedValue({
      excerpts: [excerpt(801, 12)],  // one whole-clip quote, on the second clip
      total: 1,
    })
    mergeClips.mockResolvedValue(clip(31, 0, 494.3, 'a / b'))
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { shiftKey: true })
    const mergeBtn = screen.getByRole('button', { name: 'Merge selected clips' })
    await waitFor(() => expect(mergeBtn).not.toBeDisabled())
    await waitFor(() => expect(listExcerpts).toHaveBeenCalled())

    fireEvent.click(mergeBtn)

    await waitFor(() => expect(mergeClips).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByText('2 clips merged. 1 quote carried.')).toBeInTheDocument())
  })

  it('a split with no quotes says so plainly rather than reporting zero', async () => {
    getObservation.mockResolvedValue(VIDEO_OBS)
    splitClip.mockResolvedValue([clip(21, 0, 1, ''), clip(22, 1, 130, '')])
    renderWorkbench()
    const row = (await screen.findAllByRole('option'))[0]
    fireEvent.click(row)
    fireEvent.keyDown(window, { key: '>' })
    const splitBtn = screen.getByRole('button', { name: 'Split clip at playhead' })
    await waitFor(() => expect(splitBtn).not.toBeDisabled())
    fireEvent.click(splitBtn)

    await waitFor(() => expect(screen.getByText('Clip split.')).toBeInTheDocument())
  })
})

// ── Slab 4d: the coding rail — chips, chords, blind threading ──────────────

describe('coding a clip (slab 4d)', () => {
  it('a digit on a single-selected clip applies through codingApi.applyCode and paints the chip optimistically', async () => {
    // Hold the server call open so the assertion window is unambiguous: the
    // chip must be visible BEFORE the promise resolves (the optimistic patch).
    let resolveApply: (v: unknown) => void = () => {}
    applyCode.mockImplementation(() => new Promise(res => { resolveApply = res }))

    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0]) // clip 11, uncoded
    fireEvent.keyDown(window, { key: '1' }) // numeric_id 1 → Engagement (id 7)

    const row = (await screen.findAllByRole('option'))[0]
    await waitFor(() => expect(within(row).getByText('Engagement')).toBeInTheDocument())
    expect(applyCode).toHaveBeenCalledWith(11, 7)

    resolveApply({ applied: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())
  })

  it('a failed apply rolls the optimistic chip back (snapshot restore)', async () => {
    // Hold the rejection open — an immediately-rejected mock collapses the
    // patch and the rollback into one act() flush, hiding the optimistic state.
    let rejectApply: (e: unknown) => void = () => {}
    applyCode.mockImplementation(() => new Promise((_res, rej) => { rejectApply = rej }))

    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.keyDown(window, { key: '1' })

    // Optimistic chip paints…
    const row = (await screen.findAllByRole('option'))[0]
    await waitFor(() => expect(within(row).getByText('Engagement')).toBeInTheDocument())
    // …then the rejection restores the snapshot.
    rejectApply(new Error('boom'))
    await waitFor(() => expect(within(row).queryByText('Engagement')).not.toBeInTheDocument())
  })

  it('a multi-clip selection commits through ONE bulk call (D23), never an N-POST loop', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.click(rows[2], { shiftKey: true }) // range 11, 12, 13

    fireEvent.keyDown(window, { key: '1' })
    await waitFor(() => expect(bulkCode).toHaveBeenCalledWith([11, 12, 13], 7, 'apply'))
    expect(bulkCode).toHaveBeenCalledTimes(1)
    expect(applyCode).not.toHaveBeenCalled()
  })

  it('arming a category prefix shows the chord HUD', async () => {
    listCodes.mockResolvedValue({
      codes: [
        makeCode(7, 1, 'Engagement', { category_id: 5, category_name: 'Behavior', category_order: 0 }),
        makeCode(8, 2, 'Disruption', { category_id: 5, category_name: 'Behavior', category_order: 1 }),
      ],
      total: 2,
    })
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    // Wait for the codes query so the chord structs exist before the prefix.
    await waitFor(() => expect(listCodes).toHaveBeenCalled())
    await screen.findAllByText('Behavior') // CodePanel grouped header — codes are loaded

    fireEvent.keyDown(window, { key: '2' }) // first category prefix
    expect(await screen.findByText(/Behavior — press 1-9/)).toBeInTheDocument()

    fireEvent.keyDown(window, { key: '1' }) // first code in the category
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(11, 7))
  })

  it('`s` marks the selected clip as a whole-clip quote through the bulk excerpt endpoint (D24)', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.keyDown(window, { key: 's' })
    await waitFor(() =>
      expect(bulkCreateExcerpts).toHaveBeenCalledWith(1, [{ segment_id: 11 }]),
    )
  })

  // ⚠️ REWRITTEN for #671. This used to assert `n` focused the RAIL's input —
  // the divergence from Conversations and Documents, which both pop an anchored
  // dialog. The rail composer still exists and still files observation-level
  // notes; `n` no longer routes there.
  it('`n` opens the anchored dialog and creates a clip-anchored note', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.keyDown(window, { key: 'n' })

    const box = await screen.findByPlaceholderText('Note content...')
    fireEvent.change(box, { target: { value: 'Watch this moment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() =>
      expect(createObservationNote).toHaveBeenCalledWith(1, 5, {
        content: 'Watch this moment',
        segment_id: 11,
      }),
    )
  })

  it('the rail composer still files an OBSERVATION-level note — that is its job', async () => {
    renderWorkbench()
    await screen.findAllByRole('option')
    // Reached by opening the rail panel, not by `n` — which is the point: the
    // key now anchors to a clip, and the observation-level path is a deliberate
    // click rather than something you land in by keystroke.
    fireEvent.click(screen.getByRole('button', { name: /^Notes/ }))
    // With nothing selected the composer names its own scope — which is the
    // behaviour under test, and the reason `n` should never have routed here.
    const input = await screen.findByRole('textbox', { name: 'Add observation note' })
    fireEvent.change(input, { target: { value: 'About the session' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(createObservationNote).toHaveBeenCalledWith(1, 5, {
        content: 'About the session',
        segment_id: undefined,
      }),
    )
  })
})

describe('chips + blind mode (the #441 chokepoints through the blind lens)', () => {
  const BOB = { id: 2, username: 'Bob', display_color: null, archived: false }
  const bothCoded = clip(21, 0, 10, 'Both coded', {
    applied_codes: [7, 7],
    applied_code_details: [
      { code_id: 7, user_id: 1, attribution: null, is_universal: false },
      { code_id: 7, user_id: 2, attribution: null, is_universal: false },
    ],
  })
  const colleagueOnly = clip(22, 20, 30, 'Bob only', {
    applied_codes: [7],
    applied_code_details: [
      { code_id: 7, user_id: 2, attribution: null, is_universal: false },
    ],
  })

  it('while blind (the multi-coder default), a colleague chip is hidden and a colleague-only clip leaks NO chip widget', async () => {
    listCoders.mockResolvedValue([
      { id: 1, username: 'Alice', display_color: null, archived: false }, BOB,
    ])
    listSegments.mockResolvedValue([bothCoded, colleagueOnly])
    renderWorkbench()

    // Blind default ON: the toolbar pill announces it.
    expect(await screen.findByText('Colleagues hidden')).toBeInTheDocument()

    const rows = await screen.findAllByRole('option')
    // Both-coded clip: exactly ONE chip (mine), attributed to me.
    await waitFor(() =>
      expect(within(rows[0]).getAllByText(/coded by/)).toHaveLength(1),
    )
    expect(within(rows[0]).getByText('coded by Alice')).toBeInTheDocument()
    // Colleague-only clip: no chip, no attribution, and no add-code affordance
    // either — the widget's PRESENCE would leak "a colleague coded this".
    expect(within(rows[1]).queryByText(/coded by/)).not.toBeInTheDocument()
    expect(within(rows[1]).queryByRole('button', { name: 'Add code' })).not.toBeInTheDocument()
  })

  it('revealed: one chip per (code, coder) — a code applied by two coders renders two attributed chips', async () => {
    localStorage.setItem('mm-blind-revealed-1-1', '1') // Alice already revealed
    listCoders.mockResolvedValue([
      { id: 1, username: 'Alice', display_color: null, archived: false }, BOB,
    ])
    listSegments.mockResolvedValue([bothCoded, colleagueOnly])
    renderWorkbench()

    expect(await screen.findByText('Colleagues shown')).toBeInTheDocument()
    const rows = await screen.findAllByRole('option')
    await waitFor(() =>
      expect(within(rows[0]).getAllByText(/coded by/)).toHaveLength(2),
    )
    expect(within(rows[0]).getByText('coded by Alice')).toBeInTheDocument()
    expect(within(rows[0]).getByText('coded by Bob')).toBeInTheDocument()
    // The colleague-only clip now shows Bob's chip.
    expect(within(rows[1]).getByText('coded by Bob')).toBeInTheDocument()
  })

  // #656: colour is a THIRD channel through which "a colleague coded this"
  // could escape — lane placement (D28) and chip presence already run through
  // the lens, and a bar tinted by a hidden colleague's code would undo both.
  it('a colleague-only clip keeps the neutral bar while blind, and takes the code colour on Reveal', async () => {
    listCoders.mockResolvedValue([
      { id: 1, username: 'Alice', display_color: null, archived: false }, BOB,
    ])
    listCodes.mockResolvedValue({
      codes: [makeCode(7, 1, 'Engagement', { color: '#8b5cf6' })], total: 1,
    })
    listSegments.mockResolvedValue([colleagueOnly])
    const { unmount } = renderWorkbench()

    expect(await screen.findByText('Colleagues hidden')).toBeInTheDocument()
    const blindBar = await screen.findByTestId('clip-bar')
    expect(blindBar).not.toHaveStyle({ backgroundColor: '#8b5cf6' })
    expect(blindBar.getAttribute('title')).not.toContain('Engagement')

    unmount()
    localStorage.setItem('mm-blind-revealed-1-1', '1')
    renderWorkbench()

    expect(await screen.findByText('Colleagues shown')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('clip-bar')).toHaveStyle({ backgroundColor: '#8b5cf6' }),
    )
    expect(screen.getByTestId('clip-bar').getAttribute('title')).toContain('Engagement')
  })

  // ⚠️ The test above passes even if clipFill ignored the lens entirely: a
  // colleague-only clip sits in the UNCODED lane while blind, and that lane is
  // colourless by construction, so lane placement hides the leak transitively.
  // The discriminating fixture is a clip *I* coded that a colleague ALSO coded
  // in the SAME category — lane placement can no longer help, and the colleague's
  // code sorts first, so a lens-less clipFill would paint their colour and name
  // their code. (The coinciding-identifiers rule: pin where they DIFFER.)
  it('a shared-category clip takes MY code colour while blind, never the colleague\'s', async () => {
    listCoders.mockResolvedValue([
      { id: 1, username: 'Alice', display_color: null, archived: false }, BOB,
    ])
    listCodes.mockResolvedValue({
      codes: [
        // Colleague's code FIRST in display_order — it would win any tie.
        makeCode(8, 2, 'Disruption', {
          color: '#ef4444', category_id: 10, category_name: 'Behavior',
        }),
        makeCode(7, 1, 'Engagement', {
          color: '#8b5cf6', category_id: 10, category_name: 'Behavior',
        }),
      ],
      total: 2,
    })
    listSegments.mockResolvedValue([clip(23, 0, 10, 'Shared', {
      applied_codes: [7, 8],
      applied_code_details: [
        { code_id: 7, user_id: 1, attribution: null, is_universal: false }, // me
        { code_id: 8, user_id: 2, attribution: null, is_universal: false }, // Bob
      ],
    })])
    renderWorkbench()

    expect(await screen.findByText('Colleagues hidden')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('clip-bar')).toHaveStyle({ backgroundColor: '#8b5cf6' }),
    )
    const title = screen.getByTestId('clip-bar').getAttribute('title')
    expect(title).toContain('Engagement')
    expect(title).not.toContain('Disruption')
  })

  // Found by the LIVE drive, not by a fixture: every test code here is
  // non-universal, so nothing failed, while real data had a clip marked
  // "Unclear" painting the bar and heading the tooltip ahead of the
  // substantive code beside it.
  it('a universal code never drives the colour — it does not make a clip coded (J-A)', async () => {
    listCodes.mockResolvedValue({
      codes: [
        makeCode(9, 3, 'Unclear', { is_universal: true, color: '#111827' }),
        makeCode(7, 1, 'Engagement', { color: '#8b5cf6' }),
      ],
      total: 2,
    })
    listSegments.mockResolvedValue([
      clip(24, 0, 10, 'Both', {
        applied_codes: [9, 7],
        applied_code_details: [
          { code_id: 9, user_id: 1, attribution: null, is_universal: true },
          { code_id: 7, user_id: 1, attribution: null, is_universal: false },
        ],
      }),
      clip(25, 20, 30, 'Universal only', {
        applied_codes: [9],
        applied_code_details: [
          { code_id: 9, user_id: 1, attribution: null, is_universal: true },
        ],
      }),
    ])
    renderWorkbench()
    await screen.findAllByRole('option')
    const bars = await screen.findAllByTestId('clip-bar')
    const byTitle = (frag: string) =>
      bars.find(b => b.getAttribute('title')?.includes(frag))!

    // The substantive code wins the fill AND the tooltip, though the universal
    // one sorts first in display_order.
    const both = byTitle('Both')
    expect(both).toHaveStyle({ backgroundColor: '#8b5cf6' })
    expect(both.getAttribute('title')).toContain('Engagement')
    expect(both.getAttribute('title')).not.toContain('Unclear')

    // Universal-only is not "coded", so it takes no fill at all.
    expect(byTitle('Universal only')).not.toHaveStyle({ backgroundColor: '#111827' })
  })

  it("the toggle acts on MY layer (INV-6): a code only a colleague applied still APPLIES for me", async () => {
    localStorage.setItem('mm-blind-revealed-1-1', '1')
    listCoders.mockResolvedValue([
      { id: 1, username: 'Alice', display_color: null, archived: false }, BOB,
    ])
    listSegments.mockResolvedValue([colleagueOnly])
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.keyDown(window, { key: '1' })
    // Bob has code 7 on clip 22 — but I don't, so this is an APPLY, not a remove.
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(22, 7))
    expect(removeCode).not.toHaveBeenCalled()
  })
})

// #656 revision: a single fill silently under-reported {A,B} as {A}. Bars now
// band by HEIGHT — never width, which on a time axis would read "A happens,
// then B happens" when in truth every code applies to the whole clip.
// #660 wired `c` to focus the rail's add box. That created the code and then
// merely FOCUSED it, so it never landed on the clip — half the gesture. #665
// restores the sibling workbenches' flow: create AND apply, one undo entry.
// #666: the search box sat INSIDE the column-header flex, eating 196px of the
// `flex-1` Label track the rows give to the label — so "Codes" and "Notes" both
// rendered 196px left of the columns they name, the "Codes" header landing over
// the label text. jsdom has no layout, so this pins the column MODEL (the class
// contract) rather than measured pixels; the live drive checked the geometry.
// #669/#670/#671 — the three parity gaps the comparative audit found.
describe('#669/#670/#671 — parity with the sibling workbenches', () => {
  const openMenu = async (index: number) => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.contextMenu(rows[index])
    return screen.findByRole('menu')
  }

  it('#669: copies the timecode range, the label, and a quote', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    const menu = await openMenu(0)      // clip 11 — 0:00.0–2:10.0, "Arrival & settling"
    fireEvent.click(within(menu).getByText('Copy Timecode Range'))
    expect(writeText).toHaveBeenLastCalledWith('0:00.0–2:10.0')

    fireEvent.contextMenu(screen.getAllByRole('option')[0])
    const again = await screen.findByRole('menu')
    fireEvent.click(within(again).getByText('Copy as Quote'))
    // The clip's attribution is WHERE it is, not who spoke.
    expect(writeText).toHaveBeenLastCalledWith(
      '"Arrival & settling" — Classroom Obs — Day 2, 0:00.0–2:10.0',
    )
  })

  it('#670: merges with the next clip from a single selection', async () => {
    mergeClips.mockResolvedValue(clip(31, 0, 494.3, 'merged'))
    const menu = await openMenu(0)
    fireEvent.click(within(menu).getByText('Merge with Next'))
    // clip 11 + clip 12, in timeline order — NOT the filtered view's order.
    await waitFor(() => expect(mergeClips).toHaveBeenCalledWith(1, 5, [11, 12]))
  })

  it('#670: the ends of the list cannot merge past themselves', async () => {
    const first = await openMenu(0)
    expect(within(first).getByText('Merge with Previous').closest('[role="menuitem"]'))
      .toHaveAttribute('data-disabled')
    cleanup()

    const last = await openMenu(3)
    expect(within(last).getByText('Merge with Next').closest('[role="menuitem"]'))
      .toHaveAttribute('data-disabled')
  })

  // The divergence that mattered: the rail path anchored a note only when
  // EXACTLY ONE clip was selected, so `n` on a multi-selection filed it against
  // the observation instead of the clip the researcher was looking at.
  it('#671: `n` anchors the note to the clip, even with several selected', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { shiftKey: true })
    fireEvent.keyDown(window, { key: 'n' })

    const box = await screen.findByPlaceholderText('Note content...')
    fireEvent.change(box, { target: { value: 'Watch this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createObservationNote).toHaveBeenCalledWith(1, 5, {
      content: 'Watch this',
      segment_id: 11,   // the anchor clip, not undefined
    }))
  })
})

describe('#666 — the clip column header matches the clip row', () => {
  const trackClasses = (el: Element) =>
    [...el.children].map(c => (c.className || '').match(/\b(w-\d+|flex-1)\b/)?.[0] ?? '?')

  it('declares the same column tracks, in the same order', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    const header = screen.getByTestId('clip-column-header')
    // #740 added a FIFTH track: row actions (the delete button), deliberately
    // unlabelled in the header. Naming that track is what put the word "Notes"
    // over a delete button — a header names data columns, not row actions.
    expect(trackClasses(header)).toEqual(['w-28', 'flex-1', 'w-44', 'w-16', 'w-8'])
    expect(trackClasses(rows[0])).toEqual(trackClasses(header))
  })

  it('keeps the delete button OUT of the column the header calls "Notes" (#740)', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    // The reported defect: on a clip with no note — 12 of 13 in the live
    // fixture — this cell was nothing but a trash can, under the word "Notes".
    //
    // ⚠️ Ask it of the BUTTON, not of the cell. Querying the notes cell and
    // looking inside it passes the moment a second element carries the same
    // marker — `querySelector` returns the first match and the real notes cell
    // is innocent. Mutation-proven: that version survived putting the delete
    // button back under a `data-col="notes"` track.
    const del = within(rows[0]).getByLabelText(/^Delete clip/)
    expect(del.closest('[data-col="notes"]')).toBeNull()
    expect(del.closest('[role="option"]')).toBe(rows[0])
  })

  it('gives every note its own control, not a count (#740)', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    const row = rows.find(r => within(r).queryByText('Coded moment'))!
    const badges = [...row.querySelectorAll('[aria-label^="Note "]')]
    // A `role="img"` count told you three notes existed and offered no way to
    // reach any one of them; the sibling surfaces render one button per note.
    //
    // ⚠️ Assert the ARITY against the fixture, not `length > 0`. Mutation-proven:
    // rendering only the first note passed a `toBeGreaterThan(0)` version — the
    // exact half-fixed state (a control that exists, for one note of three).
    expect(badges).toHaveLength(3)
    // #747: the note's OWN number, so this is the fixture's 1/3/7 rather than
    // 1/2/3. Reverting to `i + 1` renders positions and fails here — which is
    // what makes this an assertion about the label's source, not its presence.
    expect(badges.map(b => b.textContent?.trim())).toEqual(['1', '3', '7'])
    expect(badges.map(b => b.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^Note 1 on clip /),
      expect.stringMatching(/^Note 3 on clip /),
      expect.stringMatching(/^Note 7 on clip /),
    ])
    for (const b of badges) {
      expect(b.tagName).toBe('BUTTON')
      expect(b.getAttribute('aria-label')).toMatch(/^Note \d+ on clip /)
    }
  })

  it('shares the header row’s gap and padding, so the tracks line up', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    const header = screen.getByTestId('clip-column-header')
    for (const cls of ['gap-3', 'px-3.5']) {
      expect(header.className).toContain(cls)
      expect(rows[0].className).toContain(cls)
    }
  })

  /**
   * #739's rendered half. The cross-surface guard (`lib/coding-column-order.test.ts`)
   * scans SOURCE order across all four coding surfaces, because only this one
   * has a harness; this confirms that on a real render the two halves agree and
   * the markers survive into the DOM.
   *
   * ⚠️ **What it does NOT prove, established by mutation rather than assumed:**
   * adding `order-first` to the notes track leaves this test GREEN. `order-*`
   * and `flex-row-reverse` change VISUAL order without touching DOM order, and
   * jsdom computes no layout (the #717/#718 rule), so no unit test in this repo
   * can see that class of divergence. Visual order is a layout claim and needs a
   * rendered measurement — it was driven live at the #739 fix.
   */
  it('renders Codes before Notes in the DOM, header and row alike (#739)', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    const header = screen.getByTestId('clip-column-header')
    const order = (el: Element) =>
      [...el.querySelectorAll('[data-col]')].map(n => n.getAttribute('data-col'))
    expect(order(header)).toEqual(['codes', 'notes'])
    expect(order(rows[0])).toEqual(order(header))
  })

  it('keeps the search box OUT of the column header — that was the whole bug', async () => {
    renderWorkbench()
    await screen.findAllByRole('option')
    const header = screen.getByTestId('clip-column-header')
    expect(within(header).queryByLabelText('Search clips')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Search clips')).toBeInTheDocument()
  })
})

describe('#665 — `c` creates a code and APPLIES it', () => {
  const openDialog = async (rowIndex = 0, extra?: () => void) => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[rowIndex])
    extra?.()
    fireEvent.keyDown(window, { key: 'c' })
    return screen.findByPlaceholderText('Code name')
  }

  it('opens the dialog, then applies the new code to the selected clip', async () => {
    const input = await openDialog(0)
    fireEvent.change(input, { target: { value: 'Newly made' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(createCode).toHaveBeenCalledWith(1, expect.objectContaining({
      name: 'Newly made',
    })))
    // The half that was missing: it lands on the clip.
    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(11, 77))
  })

  it('a multi-clip selection applies through ONE bulk call (D23), and undo reverses it', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.click(rows[1], { shiftKey: true })
    fireEvent.keyDown(window, { key: 'c' })

    const input = await screen.findByPlaceholderText('Code name')
    fireEvent.change(input, { target: { value: 'Newly made' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(bulkCode).toHaveBeenCalledWith([11, 12], 77, 'apply'))
    expect(applyCode).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(bulkCode).toHaveBeenCalledWith([11, 12], 77, 'remove'))
  })

  // The dialog can outlive the selection that opened it — the code belongs to
  // what the researcher was looking at when they pressed the key.
  it('applies to the clips CAPTURED at open time, not the live selection', async () => {
    const input = await openDialog(0)
    fireEvent.click((await screen.findAllByRole('option'))[3]) // select a different clip
    fireEvent.change(input, { target: { value: 'Newly made' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(applyCode).toHaveBeenCalledWith(11, 77))
    expect(applyCode).not.toHaveBeenCalledWith(14, 77)
  })

  it('does nothing with no clip selected — the hook gates it, and there is nothing to apply to', async () => {
    renderWorkbench()
    await screen.findAllByRole('option')
    fireEvent.keyDown(window, { key: 'c' })
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByPlaceholderText('Code name')).not.toBeInTheDocument()
  })
})

describe('#656 — several codes on one clip in one lane', () => {
  const CAT = { category_id: 10, category_name: 'Behavior' }
  const withCodes = (...ids: number[]) => clip(30, 0, 10, 'Multi', {
    applied_codes: ids,
    applied_code_details: ids.map(id => ({
      code_id: id, user_id: 1, attribution: null, is_universal: false,
    })),
  })

  it('one code = a SOLID fill and the inline label', async () => {
    listCodes.mockResolvedValue({
      codes: [makeCode(7, 1, 'Engagement', { color: '#8b5cf6', ...CAT })], total: 1,
    })
    listSegments.mockResolvedValue([withCodes(7)])
    renderWorkbench()
    await screen.findAllByRole('option')
    const bar = await screen.findByTestId('clip-bar')
    expect(bar).toHaveStyle({ backgroundColor: '#8b5cf6' })
    expect(bar.style.backgroundImage).toBe('')
    expect(bar).toHaveTextContent('Multi')
  })

  it('two codes band by HEIGHT — both colours present, stacked top to bottom', async () => {
    listCodes.mockResolvedValue({
      codes: [
        makeCode(7, 1, 'Engagement', { color: '#8b5cf6', ...CAT }),
        makeCode(8, 2, 'Disruption', { color: '#ef4444', ...CAT }),
      ],
      total: 2,
    })
    listSegments.mockResolvedValue([withCodes(7, 8)])
    renderWorkbench()
    await screen.findAllByRole('option')
    const bar = await screen.findByTestId('clip-bar')

    const bands = within(bar).getAllByTestId('clip-band')
    expect(bands.map(b => b.dataset.bandColor)).toEqual(['#8b5cf6', '#ef4444'])
    // Stacked by HEIGHT and each spanning the full WIDTH — a width split would
    // claim the codes divide the clip in TIME, the one thing they do not do.
    expect(bands[0]).toHaveStyle({ top: '0%', height: '50%' })
    expect(bands[1]).toHaveStyle({ top: '50%', height: '50%' })
    bands.forEach(b => expect(b.className).toContain('left-0 right-0'))
    // No solid fill competing with the bands, and the inline label steps aside
    // because there is no single background to contrast it against.
    expect(bar.style.backgroundColor).toBe('')
    expect(bar).not.toHaveTextContent('Multi')
    // The full set is still readable on hover.
    expect(bar.getAttribute('title')).toContain('Engagement, Disruption')
  })

  it('caps at 3 bands and says how many it dropped', async () => {
    listCodes.mockResolvedValue({
      codes: [1, 2, 3, 4, 5].map((n, i) =>
        makeCode(10 + n, n, `Code ${n}`, { color: `#00000${i}`, ...CAT })),
      total: 5,
    })
    listSegments.mockResolvedValue([withCodes(11, 12, 13, 14, 15)])
    renderWorkbench()
    await screen.findAllByRole('option')
    const bar = await screen.findByTestId('clip-bar')

    expect(within(bar).getAllByTestId('clip-band')).toHaveLength(3)
    expect(bar).toHaveTextContent('+2')
    // The tooltip stays complete — the cap is a drawing limit, not a data one.
    expect(bar.getAttribute('title')).toContain('Code 5')
  })
})

describe('#657/#658/#659 — finding the drag band, and having words for the timeline', () => {
  // The default fixture is the DISCRIMINATING one: clip 11 spans 0–130s and is
  // uncoded, so at the initial zoom it sits exactly where the hint would go.
  it('withholds the hint when a clip already occupies the space', async () => {
    renderWorkbench()
    await screen.findAllByRole('option')
    expect(screen.queryByText('Drag to mark a clip')).not.toBeInTheDocument()
  })

  it('shows the hint in clear Uncoded lane space, and keeps showing it after the first clip', async () => {
    // A clip exists — which is the whole point: the old prose hint lived in the
    // clip list's ZERO-clip empty state and vanished the moment one was marked.
    listSegments.mockResolvedValue([clip(13, 760, 902.4, 'Later')])
    renderWorkbench()
    await screen.findAllByRole('option')
    expect(await screen.findByText('Drag to mark a clip')).toBeInTheDocument()
  })

  it('says nothing while frozen — the lane only seeks, so the hint would be a lie (D22)', async () => {
    getObservation.mockResolvedValue({
      ...OBSERVATION, segmentation_frozen_at: '2026-07-20T00:00:00+00:00',
    })
    listSegments.mockResolvedValue([clip(13, 760, 902.4, 'Later')])
    renderWorkbench()
    await screen.findAllByRole('option')
    expect(screen.queryByText('Drag to mark a clip')).not.toBeInTheDocument()
  })

  // #659, found by the live drive: the lane header was `sticky left-0`, which
  // is INERT here — sticky resolves against the nearest scrollport, and that is
  // the lanes box (overflow-x: hidden), not the horizontal scroller outside it.
  // Measured at viewport x = −2200 after a 2200px pan, i.e. the lane's NAME
  // disappeared exactly when panning made it most necessary.
  it('a lane header stays put when the timeline is panned', async () => {
    // Two lanes, so headers render at all (a lone Uncoded lane is headerless).
    listSegments.mockResolvedValue([
      clip(11, 0, 130, 'Uncoded one'),
      clip(14, 1000, 1100, 'Coded one', {
        applied_codes: [7],
        applied_code_details: [{ code_id: 7, user_id: 1, attribution: null, is_universal: false }],
      }),
    ])
    renderWorkbench()
    await screen.findAllByRole('option')

    const header = screen.getByTitle('Lane: Uncoded — 1 clip')
    expect(header.className).not.toContain('sticky')
    expect(header).toHaveStyle({ left: '0px' })

    // jsdom has no layout, so drive the scroll the component actually reads.
    const scroller = header.closest('.overflow-x-auto')!
    Object.defineProperty(scroller, 'scrollLeft', { value: 2200, configurable: true })
    fireEvent.scroll(scroller)

    await waitFor(() => expect(header).toHaveStyle({ left: '2200px' }))
  })

  // #658 lives in the header on purpose: the layer below is aria-hidden, so
  // vocabulary parked in a lane would be mouse-only.
  it('names lanes and tracks from a control a keyboard and a screen reader can reach', async () => {
    renderWorkbench()
    const info = await screen.findByRole('button', {
      name: 'About the timeline: lanes, tracks and colours',
    })
    expect(info.closest('[aria-hidden="true"]')).toBeNull()

    fireEvent.click(info)
    const panel = await screen.findByText(/one per code category/)
    expect(panel).toBeInTheDocument()
    expect(screen.getByText(/rows stacked/)).toBeInTheDocument()
  })
})

describe('the ?clip= deep-link (D26)', () => {
  // Reads the live location so the param-clearing contract both test NAMES
  // claimed can actually be asserted — before slab 5c neither did (the repo's
  // own "a test whose name claims a contract must exercise it" rule).
  function LocationProbe() {
    const loc = useLocation()
    return <div data-testid="loc-search">{loc.search}</div>
  }

  function renderWithClipParam(query: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/obs/5?${query}`]}>
          <VirtuosoMockContext.Provider value={{ viewportHeight: 1000, itemHeight: 48 }}>
            <Routes>
              <Route path="/obs/:observationId" element={<><ObservationWorkbench /><LocationProbe /></>} />
            </Routes>
          </VirtuosoMockContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('selects + scrolls to the clip, seeks PAUSED, and clears the param (replace)', async () => {
    renderWithClipParam('clip=13')
    const listbox = await screen.findByRole('listbox', { name: 'Clips' })
    await waitFor(() => {
      expect(listbox).toHaveAttribute('aria-activedescendant', 'clip-13')
    })
    const row = document.getElementById('clip-13')
    expect(row).toHaveAttribute('aria-selected', 'true')
    // The seek is PAUSED — arriving from search must never start the tape.
    expect(screen.queryByText(/now playing/)).not.toBeInTheDocument()
    // The param really clears (the effect's setSearchParams({}, {replace})).
    await waitFor(() => expect(screen.getByTestId('loc-search')).toHaveTextContent(''))
  })

  it('an unknown clip id is a silent no-op (the param still clears)', async () => {
    renderWithClipParam('clip=9999')
    await screen.findByRole('listbox', { name: 'Clips' })
    const options = await screen.findAllByRole('option')
    for (const o of options) expect(o).toHaveAttribute('aria-selected', 'false')
    await waitFor(() => expect(screen.getByTestId('loc-search')).toHaveTextContent(''))
  })

  it('consumes &t= and still clears BOTH params', async () => {
    // The seek TARGET rule is unit-tested in clip-timeline.test.ts
    // (deepLinkSeekTarget) — a media element the jsdom harness deliberately
    // lacks would be needed to observe the seek itself.
    renderWithClipParam('clip=13&t=800')
    await screen.findByRole('listbox', { name: 'Clips' })
    const row = document.getElementById('clip-13')
    await waitFor(() => expect(row).toHaveAttribute('aria-selected', 'true'))
    await waitFor(() => expect(screen.getByTestId('loc-search')).toHaveTextContent(''))
  })
})

// ── Slab 5b: sub-clip time-range quotes (D30) + the #619 delete gate ────────
//
// The backend already pins shape/containment/frozen/dup behaviour
// (test_excerpts_time_range.py, 8 classes) — these cover only what is the
// CLIENT's to decide: the attach rule, which shape a toggle reads, and the gate.
describe('sub-clip quotes (slab 5b)', () => {
  it('`s` while a mark is armed quotes the armed range inside the selected clip', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0]) // clip 11, 0–130

    fireEvent.keyDown(window, { key: 'i' })   // arm at the playhead (0)
    fireEvent.keyDown(window, { key: 's' })   // commit the range as a quote

    // The SINGLE create, never bulkCreate: bulk counts a refusal into
    // skipped_count inside a 200, so the reason would never reach the user.
    await waitFor(() =>
      expect(createExcerpt).toHaveBeenCalledWith(1, {
        segment_id: 11, start_time: 0, end_time: 0,
      }),
    )
    expect(bulkCreateExcerpts).not.toHaveBeenCalled()
  })

  it('`s` with nothing armed still toggles the WHOLE-clip quote (idle behaviour unchanged)', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.keyDown(window, { key: 's' })
    // Falls through extraKeys to the hook's own selection-gated `s`.
    await waitFor(() =>
      expect(bulkCreateExcerpts).toHaveBeenCalledWith(1, [{ segment_id: 11 }]),
    )
    expect(createExcerpt).not.toHaveBeenCalled()
  })

  it('attaches to the SELECTED clip, and a zero-width range is a legal point quote', async () => {
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[1]) // clip 12 — a point event at 494.3
    // Selecting a clip seeks the playhead to its start, so I-then-S here marks
    // a zero-width range at 494.3. That is a POINT quote: legal by D7, and the
    // reason the time CHECK is `end_time >= start_time` rather than `>`.
    fireEvent.keyDown(window, { key: 'i' })
    fireEvent.keyDown(window, { key: 's' })
    await waitFor(() =>
      expect(createExcerpt).toHaveBeenCalledWith(1, {
        segment_id: 12, start_time: 494.3, end_time: 494.3,
      }),
    )
  })

  it('falls through to the UNIQUE containing clip when nothing is selected, and CLAIMS the key', async () => {
    renderWorkbench()
    await screen.findAllByRole('option')
    // Playhead 0, no selection → only clip 11 (0–130) contains the range.
    fireEvent.keyDown(window, { key: 'i' })

    // Dispatched by hand so the RETURN VALUE of the extraKeys handler is
    // observable. It has to be pinned here, with nothing selected: when a clip
    // IS selected, a handler that wrongly returned false would fall through to
    // the hook's own `s`, and useHistory's re-entrancy guard would silently
    // swallow the resulting second action — making the bug invisible.
    const ev = new KeyboardEvent('keydown', { key: 's', cancelable: true, bubbles: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)

    await waitFor(() =>
      expect(createExcerpt).toHaveBeenCalledWith(1, {
        segment_id: 11, start_time: 0, end_time: 0,
      }),
    )
  })

  it('creates nothing when no clip contains the marked range', async () => {
    // Every clip starts after the playhead, so the armed range at 0 has no home.
    listSegments.mockResolvedValue([clip(21, 60, 90, 'Later')])
    renderWorkbench()
    await screen.findAllByRole('option')
    fireEvent.keyDown(window, { key: 'i' })
    fireEvent.keyDown(window, { key: 's' })
    // The refusal is named in a toast; what must be pinned is that nothing is
    // silently written to the wrong clip.
    await waitFor(() => expect(listSegments).toHaveBeenCalled())
    expect(createExcerpt).not.toHaveBeenCalled()
    expect(bulkCreateExcerpts).not.toHaveBeenCalled()
  })

  it('unquote deletes ONLY the whole-shape excerpt, never a sub-clip quote', async () => {
    // The arm §8j.0.2 flagged: a bare `start_offset === null` matches BOTH
    // shapes, so the unquote would destroy the researcher's sub-clip range.
    listExcerpts.mockResolvedValue({
      excerpts: [
        excerpt(801, 11, { start_time: 10, end_time: 20 }), // sub-clip quote
        excerpt(802, 11),                                   // the whole-clip quote
      ],
      total: 2,
    })
    renderWorkbench()
    const rows = await screen.findAllByRole('option')
    fireEvent.click(rows[0])
    fireEvent.keyDown(window, { key: 's' }) // clip 11 IS whole-quoted → unquote

    await waitFor(() => expect(deleteExcerpt).toHaveBeenCalled())
    expect(deleteExcerpt).toHaveBeenCalledWith(1, 802)
    expect(deleteExcerpt).not.toHaveBeenCalledWith(1, 801)
  })

  it('shows a clip quoted only by a sub-range as quoted, in the row NAME', async () => {
    listExcerpts.mockResolvedValue({
      excerpts: [excerpt(801, 11, { start_time: 10, end_time: 20 })],
      total: 1,
    })
    renderWorkbench()
    const row = await screen.findByRole('option', { name: /Arrival & settling/ })
    // "— quoted" joins the composite label: the role="img" indicator beside it
    // is only reachable by touring into the row.
    await waitFor(() => expect(row).toHaveAttribute('aria-label', expect.stringContaining('— quoted')))
  })

  describe('#619 — a quoted clip is annotated', () => {
    it('confirms before deleting a quoted-but-uncoded clip, and the copy names the quote', async () => {
      listExcerpts.mockResolvedValue({
        excerpts: [excerpt(801, 11, { start_time: 10, end_time: 20 })],
        total: 1,
      })
      renderWorkbench()
      await screen.findAllByRole('option')
      const del = await screen.findByRole('button', { name: /Delete clip 0:00\.0/ })
      fireEvent.click(del)

      expect(await screen.findByText('Delete this clip?')).toBeInTheDocument()
      // The clause list, not the old nested template — which rendered the
      // literal "Its . This can't be undone." for a quote-only clip.
      expect(screen.getByText(/its quote is deleted/i)).toBeInTheDocument()
      expect(deleteClip).not.toHaveBeenCalled()
    })

    it('still deletes an unannotated, unquoted clip straight through (undoable)', async () => {
      renderWorkbench()
      await screen.findAllByRole('option')
      const del = await screen.findByRole('button', { name: /Delete clip 0:00\.0/ })
      fireEvent.click(del)
      await waitFor(() => expect(deleteClip).toHaveBeenCalledWith(1, 5, 11))
      expect(screen.queryByText('Delete this clip?')).not.toBeInTheDocument()
    })
  })

  describe('the "Quote a portion…" dialog (the keyboard/precision path)', () => {
    it('opens prefilled to the clip range and refuses a range outside it', async () => {
      renderWorkbench()
      const rows = await screen.findAllByRole('option')
      fireEvent.click(rows[0]) // clip 11, 0–130

      fireEvent.click(screen.getByRole('button', { name: 'Quote a portion of the selected clip' }))
      const start = await screen.findByRole('textbox', { name: 'Quote start time' })
      const end = screen.getByRole('textbox', { name: 'Quote end time' })
      expect(start).toHaveValue('0:00.0')
      expect(end).toHaveValue('2:10.0')

      // Push the end past the clip's own end — the dialog names it and blocks.
      fireEvent.change(end, { target: { value: '3:00.0' } })
      fireEvent.blur(end)
      expect(await screen.findByRole('alert')).toHaveTextContent(/outside the clip/i)
      expect(screen.getByRole('button', { name: 'Quote range' })).toBeDisabled()
    })

    it('creates the quote on the clip the dialog NAMED', async () => {
      renderWorkbench()
      const rows = await screen.findAllByRole('option')
      fireEvent.click(rows[0])
      fireEvent.click(screen.getByRole('button', { name: 'Quote a portion of the selected clip' }))

      const start = await screen.findByRole('textbox', { name: 'Quote start time' })
      fireEvent.change(start, { target: { value: '0:10.0' } })
      fireEvent.blur(start)
      const end = screen.getByRole('textbox', { name: 'Quote end time' })
      fireEvent.change(end, { target: { value: '0:20.0' } })
      fireEvent.blur(end)

      fireEvent.click(screen.getByRole('button', { name: 'Quote range' }))
      await waitFor(() =>
        expect(createExcerpt).toHaveBeenCalledWith(1, {
          segment_id: 11, start_time: 10, end_time: 20,
        }),
      )
    })
  })
})

// ── 6a: the coverage gauge, the density strip, and `u` ──────────────────────
//
// The gauge is CLIENT-computed on `effectiveHidden` (D33), so blind mode moves
// the NUMBER, not just the chips. The fixtures below are deliberately built so
// `codedAny !== codedVisible` — a colleague-only-coded clip — because a fixture
// where the two coincide would pass with the lens wired to either variable
// (the coinciding-identifiers lesson from 5c's `&t=`).
describe('coverage gauge + density strip + `u` (6a — D33/D34/D35/D36)', () => {
  const BOB = { id: 2, username: 'Bob', display_color: null, archived: false }
  const codedByMe = (id: number, start: number, end: number) => clip(id, start, end, 'Mine', {
    applied_codes: [7],
    applied_code_details: [{ code_id: 7, user_id: 1, attribution: null, is_universal: false }],
  })
  const codedByBob = (id: number, start: number, end: number) => clip(id, start, end, 'Bob only', {
    applied_codes: [7],
    applied_code_details: [{ code_id: 7, user_id: 2, attribution: null, is_universal: false }],
  })

  // 0–50 mine · 40–60 Bob's · 100–120 uncoded, over a 200 s recording.
  // Blind: union [0,50] → 25%. Revealed: union [0,60] → 30% (the overlap does
  // NOT double-count). Both numbers are wrong if the gauge reads chipHidden or
  // skips the union.
  const MIXED = [codedByMe(31, 0, 50), codedByBob(32, 40, 60), clip(33, 100, 120, 'Uncoded')]

  const twoCoders = () => listCoders.mockResolvedValue([
    { id: 1, username: 'Alice', display_color: null, archived: false }, BOB,
  ])

  // A 200 s recording — every percentage below is computed against THIS, not
  // the shared fixture's 3260 s (which is what the first draft of these tests
  // silently measured against).
  const DURATION = 200
  beforeEach(() => {
    getObservation.mockResolvedValue({ ...OBSERVATION, media_duration_seconds: DURATION })
  })

  it('OPEN mode: % of timeline covered, unioned, with the gap count', async () => {
    listSegments.mockResolvedValue([codedByMe(31, 0, 50), codedByMe(32, 100, 120)])
    renderWorkbench()
    const gauge = await screen.findByRole('progressbar')
    // 70 of 200 s = 35%; gaps [50,100] and [120,200].
    expect(gauge).toHaveAttribute('aria-valuetext', expect.stringContaining('35% of the recording'))
    expect(gauge).toHaveAttribute('aria-valuetext', expect.stringContaining('2 gaps remaining'))
    expect(gauge).toHaveTextContent('35% covered')
    expect(gauge).toHaveTextContent('2 gaps')
  })

  it('overlapping coded clips do NOT double-count', async () => {
    listSegments.mockResolvedValue([codedByMe(31, 0, 50), codedByMe(32, 40, 60)])
    renderWorkbench()
    // Union [0,60] = 60/200 = 30%. Summing the ranges would read 55%.
    const gauge = await screen.findByRole('progressbar')
    expect(gauge).toHaveTextContent('30% covered')
  })

  it('a universal-only coded clip covers NOTHING (invariant J-A)', async () => {
    const universalOnly = clip(34, 0, 100, 'Unclear only', {
      applied_codes: [9],
      applied_code_details: [{ code_id: 9, user_id: 1, attribution: null, is_universal: true }],
    })
    listSegments.mockResolvedValue([universalOnly, codedByMe(31, 100, 150)])
    renderWorkbench()
    const gauge = await screen.findByRole('progressbar')
    expect(gauge).toHaveTextContent('25% covered') // 50 of 200, not 150
  })

  it('BLIND → REVEAL raises the open %: the gauge counts only coding visible to you', async () => {
    twoCoders()
    listSegments.mockResolvedValue(MIXED)
    const { unmount } = renderWorkbench()
    expect(await screen.findByText('Colleagues hidden')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveTextContent('25% covered'),
    )
    unmount()
    cleanup()

    localStorage.setItem('mm-blind-revealed-1-1', '1') // Alice reveals
    twoCoders()
    listSegments.mockResolvedValue(MIXED)
    renderWorkbench()
    expect(await screen.findByText('Colleagues shown')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveTextContent('30% covered'),
    )
  })

  it('BLIND → REVEAL raises the FROZEN N-of-M too', async () => {
    twoCoders()
    getObservation.mockResolvedValue({ ...OBSERVATION, segmentation_frozen_at: '2026-07-18T00:00:00+00:00' })
    listSegments.mockResolvedValue(MIXED)
    const { unmount } = renderWorkbench()
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveTextContent('1 of 3 coded'),
    )
    unmount()
    cleanup()

    localStorage.setItem('mm-blind-revealed-1-1', '1')
    twoCoders()
    getObservation.mockResolvedValue({ ...OBSERVATION, segmentation_frozen_at: '2026-07-18T00:00:00+00:00' })
    listSegments.mockResolvedValue(MIXED)
    renderWorkbench()
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveTextContent('2 of 3 coded'),
    )
  })

  it('the freeze FLIPS the gauge from % covered to N-of-M (§8d)', async () => {
    getObservation.mockResolvedValue({ ...OBSERVATION, segmentation_frozen_at: '2026-07-18T00:00:00+00:00' })
    listSegments.mockResolvedValue(MIXED)
    renderWorkbench()
    const gauge = await screen.findByRole('progressbar')
    // M was fixed by the freeze, before any coding — so N-of-M is not circular.
    await waitFor(() => expect(gauge).toHaveTextContent('2 of 3 coded'))
    expect(gauge).not.toHaveTextContent('covered')
  })

  it('while blind the gauge NAMES its scope (#517) — never a silently different number', async () => {
    twoCoders()
    listSegments.mockResolvedValue(MIXED)
    renderWorkbench()
    const gauge = await screen.findByRole('progressbar')
    await waitFor(() => expect(gauge).toHaveAttribute(
      'title',
      expect.stringContaining('this count reflects only coding visible to you'),
    ))
    expect(gauge.getAttribute('title')).toContain("The observations list and Overview show all coders' coverage")
  })

  it('NULL duration falls back to the marked extent, and SAYS so (D34)', async () => {
    getObservation.mockResolvedValue({ ...OBSERVATION, media_duration_seconds: null })
    listSegments.mockResolvedValue([codedByMe(31, 0, 50), clip(33, 100, 200, 'Uncoded')])
    renderWorkbench()
    const gauge = await screen.findByRole('progressbar')
    // Extent = max clip end (200), NOT the 60 s ruler display floor — with the
    // floor in the denominator a short timeline would over-report coverage.
    await waitFor(() => expect(gauge).toHaveTextContent('25% of marked extent'))
    expect(gauge).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('marked extent — recording length unknown'),
    )
  })

  it('the 60 s ruler floor is NOT the denominator (a sub-minute timeline reads honestly)', async () => {
    getObservation.mockResolvedValue({ ...OBSERVATION, media_duration_seconds: null })
    listSegments.mockResolvedValue([codedByMe(31, 0, 15), clip(33, 15, 30, 'Uncoded')])
    renderWorkbench()
    // Extent 30 → 15/30 = 50%. Against the ruler's 60 s floor it would read 25%.
    const gauge = await screen.findByRole('progressbar')
    await waitFor(() => expect(gauge).toHaveTextContent('50% of marked extent'))
  })

  it('no clips and no duration: the count only — never a fake 0%', async () => {
    getObservation.mockResolvedValue({ ...OBSERVATION, media_duration_seconds: null })
    listSegments.mockResolvedValue([])
    renderWorkbench()
    expect(await screen.findByText(/0 clips/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('an ARCHIVED coder\'s work counts in the gauge even though its chip is hidden (#451)', async () => {
    // The law the two variables exist for: gauges run on `effectiveHidden`,
    // chips on `chipHidden`. They coincide until an ARCHIVED coder has coded —
    // so this is the ONLY fixture shape that can catch the gauge reading the
    // chip lens, and without it the swap passes every other test in this file.
    const ARCHIVED = { id: 3, username: 'Carla', display_color: null, archived: true }
    twoCoders()
    coderCoverage.mockResolvedValue({
      coders: [{ user_id: 3, username: 'Carla', display_color: null, archived: true, coding_count: 1 }],
      count: 1,
    })
    const archivedCoded = clip(35, 100, 150, 'Carla only', {
      applied_codes: [7],
      applied_code_details: [{ code_id: 7, user_id: ARCHIVED.id, attribution: null, is_universal: false }],
    })
    localStorage.setItem('mm-blind-revealed-1-1', '1') // not blind — isolate the archived arm
    listSegments.mockResolvedValue([codedByMe(31, 0, 50), archivedCoded])
    renderWorkbench()

    // ORDER IS LOAD-BEARING. Wait for the CHIP to disappear first: that is what
    // proves the coder-coverage query resolved and Carla reached
    // `archivedCoderIds`. Asserting the gauge first passes vacuously — before
    // the query lands, chipHidden === effectiveHidden, so a gauge wired to
    // EITHER variable reads 50% and `waitFor` settles on that first render.
    const rows = await screen.findAllByRole('option')
    await waitFor(() =>
      expect(within(rows[1]).queryByText(/coded by/)).not.toBeInTheDocument(),
    )
    // 50 (mine) + 50 (Carla's) of 200 = 50%. On the chip lens it reads 25%.
    expect(screen.getByRole('progressbar')).toHaveTextContent('50% covered')
  })

  it('the density strip marks each visible-coded clip, aria-hidden (D36)', async () => {
    twoCoders()
    listSegments.mockResolvedValue(MIXED)
    renderWorkbench()
    const strip = await screen.findByTestId('coverage-density-strip')
    expect(strip).toHaveAttribute('aria-hidden', 'true')
    // Blind: only MY clip is marked — the strip runs on the same lens as the
    // gauge, so it can't leak a colleague's coding as a visible mark.
    await waitFor(() => expect(strip.children).toHaveLength(1))
  })

  describe('`u` — jump to what the gauge says is missing (D35)', () => {
    // The workbench's OWN live region — the blind toggle mounts a second
    // role="status" node when the project is multi-coder.
    const announce = () => screen.getByTestId('clip-announce').textContent

    it('OPEN: walks gap to gap, then WRAPS', async () => {
      listSegments.mockResolvedValue([codedByMe(31, 0, 50), codedByMe(32, 100, 120)])
      renderWorkbench()
      await screen.findByRole('progressbar')
      // Gaps: [50,100] and [120,200].
      fireEvent.keyDown(window, { key: 'u' })
      await waitFor(() => expect(announce()).toBe('Gap 0:50.0–1:40.0'))
      // The seek moved the app clock, so the NEXT press finds the NEXT gap.
      fireEvent.keyDown(window, { key: 'u' })
      await waitFor(() => expect(announce()).toBe('Gap 2:00.0–3:20.0'))
      // Nothing ahead → wrap to the first.
      fireEvent.keyDown(window, { key: 'u' })
      await waitFor(() => expect(announce()).toBe('Gap 0:50.0–1:40.0'))
    })

    it('OPEN: says so when the timeline is fully covered', async () => {
      listSegments.mockResolvedValue([codedByMe(31, 0, 200)])
      renderWorkbench()
      await screen.findByRole('progressbar')
      fireEvent.keyDown(window, { key: 'u' })
      await waitFor(() => expect(announce()).toBe('Timeline fully covered'))
    })

    it('OPEN: with no extent at all, names the way out instead of seeking nowhere', async () => {
      getObservation.mockResolvedValue({ ...OBSERVATION, media_duration_seconds: null })
      listSegments.mockResolvedValue([])
      renderWorkbench()
      await screen.findByText(/0 clips/)
      fireEvent.keyDown(window, { key: 'u' })
      await waitFor(() => expect(announce()).toContain('No recording length known'))
    })

    it('FROZEN: selects the next clip that is not coded-visible, and wraps', async () => {
      getObservation.mockResolvedValue({ ...OBSERVATION, segmentation_frozen_at: '2026-07-18T00:00:00+00:00' })
      listSegments.mockResolvedValue([codedByMe(31, 0, 50), clip(33, 100, 120, 'Uncoded')])
      renderWorkbench()
      await screen.findAllByRole('option')
      fireEvent.keyDown(window, { key: 'u' })
      await waitFor(() => expect(announce()).toBe('Uncoded clip at 1:40.0'))
      const rows = screen.getAllByRole('option')
      expect(rows[1]).toHaveAttribute('aria-selected', 'true')
    })

    it('FROZEN: says so when every clip is coded', async () => {
      getObservation.mockResolvedValue({ ...OBSERVATION, segmentation_frozen_at: '2026-07-18T00:00:00+00:00' })
      listSegments.mockResolvedValue([codedByMe(31, 0, 50)])
      renderWorkbench()
      await screen.findAllByRole('option')
      fireEvent.keyDown(window, { key: 'u' })
      await waitFor(() => expect(announce()).toBe('Every clip is coded'))
    })

    it('FROZEN + blind: a colleague-only-coded clip is uncoded FOR ME, so `u` goes there', async () => {
      twoCoders()
      getObservation.mockResolvedValue({ ...OBSERVATION, segmentation_frozen_at: '2026-07-18T00:00:00+00:00' })
      listSegments.mockResolvedValue([codedByMe(31, 0, 50), codedByBob(32, 100, 120)])
      renderWorkbench()
      await screen.findByText('Colleagues hidden')
      fireEvent.keyDown(window, { key: 'u' })
      await waitFor(() => expect(announce()).toBe('Uncoded clip at 1:40.0'))
    })
  })
})
