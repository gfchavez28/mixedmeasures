/**
 * #652 slab 4 — the Timeline material on the canvas.
 *
 * ⚠️ **Fixture discipline, and it is not decoration.** The Timeline's failure
 * modes all hide behind convenient data, so every fixture below is deliberately
 * inconvenient:
 *
 *   · `code_ids` is saved in an order that DIFFERS from the codebook's
 *     `display_order`, because a config that happens to agree cannot tell
 *     "filters the project list" from "maps the config array" (F3);
 *   · two observations, one with a `null` duration, so the unknown-extent
 *     label is exercised and the two blocks cannot be confused;
 *   · two coders with marks on the SAME clip and code, so pooling differs
 *     visibly from summing;
 *   · one point mark (`start === end`), which counts toward Marks but not
 *     airtime or bouts — a fixture without one cannot tell them apart;
 *   · one INACTIVE code inside `code_ids`, which the view drops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import QualTimelineEmbed from './QualTimelineEmbed'
import { extractQualComputeParams } from './inline-chart-params'

vi.mock('@/lib/api', () => ({
  codesApi: { list: vi.fn() },
  categoriesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

const blindState = { blind: false }
const rosterState = { multiCoder: true }

vi.mock('@/hooks/useBlindMode', () => ({
  useBlindMode: () => ({ blind: blindState.blind, blindHiddenSet: new Set<number>(), toggleReveal: vi.fn() }),
}))
vi.mock('@/hooks/useCoders', () => ({
  useCoders: () => ({
    coders: [
      { id: 1, username: 'ana', display_color: '#3b82f6' },
      { id: 2, username: 'bram', display_color: '#ef4444' },
    ],
    coderMap: new Map([
      [1, { id: 1, username: 'ana', display_color: '#3b82f6' }],
      [2, { id: 2, username: 'bram', display_color: '#ef4444' }],
    ]),
    multiCoder: rosterState.multiCoder,
  }),
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'ana' } }),
}))

import { codesApi, categoriesApi, observationsApi } from '@/lib/api'

// Codebook order: Rapport (70) → Silence (71) → Retired (72, inactive).
const PROJECT_CODES = [
  { id: 70, name: 'Rapport', color: '#3b82f6', is_active: true, category_id: 9, category_color: '#111111' },
  { id: 71, name: 'Silence', color: '#ef4444', is_active: true, category_id: null, category_color: null },
  { id: 72, name: 'Retired', color: '#999999', is_active: false, category_id: null, category_color: null },
]

const PROJECT_OBSERVATIONS = [
  { id: 1, name: 'Playground morning', media_duration_seconds: 600, segmentation_frozen_at: null },
  { id: 2, name: 'Playground afternoon', media_duration_seconds: null, segmentation_frozen_at: null },
]

const detail = (code_id: number, user_id: number | null) =>
  ({ code_id, user_id, attribution: null, is_universal: false })

const CLIPS_BY_OBSERVATION: Record<number, unknown[]> = {
  1: [
    {
      id: 11, sequence_order: 1, start_time: 0, end_time: 60, text: 'a',
      applied_codes: [70], attached_notes: [], created_at: '',
      // BOTH coders marked this one — pooling must count the interval once.
      applied_code_details: [detail(70, 1), detail(70, 2)],
    },
    {
      id: 12, sequence_order: 2, start_time: 120, end_time: 120, text: 'point',
      applied_codes: [71], attached_notes: [], created_at: '',
      applied_code_details: [detail(71, 2)],
    },
  ],
  2: [
    {
      id: 21, sequence_order: 1, start_time: 0, end_time: 30, text: 'b',
      applied_codes: [70], attached_notes: [], created_at: '',
      applied_code_details: [detail(70, 1)],
    },
  ],
}

/** `code_ids` deliberately REVERSED against the codebook's display order. */
function timelineConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tab: 'descriptives',
    chart_type: 'timeline',
    source: 'all',
    code_mode: 'codes',
    code_ids: [72, 71, 70],
    conversation_ids: [],
    text_column_ids: [],
    document_ids: [],
    observation_ids: [1, 2],
    exclude_facilitator: true,
    participant_ids: [],
    coder_ids: [],
    layer_scope: 'human',
    ...over,
  }
}

function renderEmbed(config: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <QualTimelineEmbed projectId={3} params={extractQualComputeParams(config)} />
    </QueryClientProvider>,
  )
}

afterEach(cleanup)

beforeEach(() => {
  blindState.blind = false
  rosterState.multiCoder = true
  vi.mocked(codesApi.list).mockReset()
  vi.mocked(categoriesApi.list).mockReset()
  vi.mocked(observationsApi.list).mockReset()
  vi.mocked(observationsApi.listSegments).mockReset()
  vi.mocked(codesApi.list).mockResolvedValue({ codes: PROJECT_CODES, total: 3 } as never)
  vi.mocked(categoriesApi.list).mockResolvedValue({
    categories: [{ id: 9, name: 'Interaction' }], total: 1,
  } as never)
  vi.mocked(observationsApi.list).mockResolvedValue(PROJECT_OBSERVATIONS as never)
  vi.mocked(observationsApi.listSegments).mockImplementation(
    (_pid: number, oid: number) => Promise.resolve((CLIPS_BY_OBSERVATION[oid] ?? []) as never),
  )
})

/** The per-observation `<section aria-label="Timed analytics for {name}">`. */
const block = (name: string) => screen.getByRole('region', { name: `Timed analytics for ${name}` })

describe('which observations a saved timeline charts', () => {
  it('charts the observations the config names', async () => {
    renderEmbed(timelineConfig({ observation_ids: [2] }))

    expect(await screen.findByText('Playground afternoon')).toBeInTheDocument()
    expect(screen.queryByText('Playground morning')).not.toBeInTheDocument()
  })

  it('charts ALL observations when the config names none', async () => {
    // ⚠️ The fourth empty-list semantic in this feature, and the first that
    // lives in the VIEW: `contentObservations` returns the whole project list
    // when the selection is empty and the tab is not Content. Resolving from
    // the config alone would render nothing where the view rendered everything.
    renderEmbed(timelineConfig({ observation_ids: [], conversation_ids: [4] }))

    expect(await screen.findByText('Playground morning')).toBeInTheDocument()
    expect(screen.getByText('Playground afternoon')).toBeInTheDocument()
  })

  it('says so when the referenced observations are gone, and says something else when there are none', async () => {
    renderEmbed(timelineConfig({ observation_ids: [999] }))
    expect(await screen.findByText(/no longer in this project/i)).toBeInTheDocument()

    cleanup()
    vi.mocked(observationsApi.list).mockResolvedValue([] as never)
    renderEmbed(timelineConfig({ observation_ids: [] }))
    expect(await screen.findByText(/no observations to chart/i)).toBeInTheDocument()
  })
})

describe('which codes get a lane, and in what order', () => {
  it('follows the codebook order, NOT the order the config stored', async () => {
    // The config saved [72, 71, 70]; the codebook is Rapport → Silence. If the
    // embed mapped the config array the rows would come back reversed.
    renderEmbed(timelineConfig())

    const rows = within(await screen.findByRole('table', { name: /Playground morning/i }))
      .getAllByRole('rowheader')
      .map(el => el.textContent?.trim())

    expect(rows.slice(0, 2)).toEqual(['Rapport', 'Silence'])
  })

  it('drops a code that has been deactivated since the material was saved', async () => {
    renderEmbed(timelineConfig())

    await screen.findByText('Playground morning')
    expect(screen.queryByText('Retired')).not.toBeInTheDocument()
  })
})

describe('the numbers agree with the analysis view', () => {
  it('pools two coders marking the same clip instead of summing them', async () => {
    renderEmbed(timelineConfig({ observation_ids: [1] }))

    const table = await screen.findByRole('table', { name: /Playground morning/i })
    const rapport = within(table).getByRole('row', { name: /^Rapport/ })
    const cells = within(rapport).getAllByRole('cell').map(c => c.textContent?.trim())

    // Two marks (one per coder) but ONE 60s interval of airtime, over a 600s
    // recording ⇒ 10%. Summing would read 120s / 20%.
    expect(cells[0]).toBe('2')
    expect(cells[1]).toBe('1:00.0')
    expect(cells[2]).toBe('10%')
  })

  it('counts a point mark toward frequency but gives it no airtime', async () => {
    renderEmbed(timelineConfig({ observation_ids: [1] }))

    const table = await screen.findByRole('table', { name: /Playground morning/i })
    const silence = within(table).getByRole('row', { name: /^Silence/ })
    const cells = within(silence).getAllByRole('cell').map(c => c.textContent?.trim())

    expect(cells[0]).toBe('1')       // marks
    expect(cells[1]).toBe('0:00.0')  // airtime
    expect(cells[4]).toBe('—')       // mean bout — a point event has none
    expect(within(block('Playground morning')).getByText(/1 instant mark/)).toBeInTheDocument()
  })

  it('labels the fallback denominator when the recording length is unknown', async () => {
    // #622's rule: never present a fallback denominator as fact.
    renderEmbed(timelineConfig({ observation_ids: [2] }))

    await screen.findByText('Playground afternoon')
    // The extent chip labels its fallback inline ("0:30.0 marked") ...
    expect(within(block('Playground afternoon')).getByText(/^0:30\.0 marked$/)).toBeInTheDocument()
    // ... and the disclosure paragraph repeats it where the numbers are.
    expect(within(block('Playground afternoon')).getByText(/Recording length unknown/)).toBeInTheDocument()
  })
})

describe('blind mode — the canvas had no lens before this (multi-coder invariant 5)', () => {
  it('names colleagues when NOT blind', async () => {
    renderEmbed(timelineConfig({ observation_ids: [1] }))

    await screen.findByText('Playground morning')
    // The by-coder breakdown is not rendered on the canvas, so identity reaches
    // the DOM through each mark's `title` — which is exactly the channel a
    // text-only assertion would miss.
    const titles = Array.from(document.querySelectorAll('[title]')).map(el => el.getAttribute('title'))
    expect(titles.some(t => t?.includes('bram'))).toBe(true)
  })

  it('hides colleague marks AND colleague names while blind', async () => {
    blindState.blind = true
    renderEmbed(timelineConfig({ observation_ids: [1] }))

    await screen.findByText('Playground morning')

    // ⚠️ Assert on `title` as well as on visible text: that is the channel a
    // text-only assertion misses. What closes it is the INCLUDE narrowing —
    // `marksForCode` drops the colleague's detail, so no mark carrying their
    // id survives to be titled. (A second guard blanking the coderMap was
    // tried, proved unkillable by mutation, and removed.)
    const titles = Array.from(document.querySelectorAll('[title]')).map(el => el.getAttribute('title'))
    expect(titles.some(t => t?.includes('bram'))).toBe(false)
    expect(screen.queryByText(/bram/)).not.toBeInTheDocument()

    // And the scope is LABELLED (#517) — a silently-narrowed figure is worse
    // than none, because the researcher would quote it as the whole picture.
    expect(screen.getByText(/only your own coding/i)).toBeInTheDocument()
  })

  it('drops the colleague-only mark from the numbers while blind', async () => {
    blindState.blind = true
    renderEmbed(timelineConfig({ observation_ids: [1] }))

    const table = await screen.findByRole('table', { name: /Playground morning/i })
    // Rapport was marked by both coders ⇒ 1 visible mark for self alone.
    const rapport = within(table).getByRole('row', { name: /^Rapport/ })
    expect(within(rapport).getAllByRole('cell')[0]).toHaveTextContent('1')
    // Silence was marked ONLY by the colleague ⇒ nothing visible.
    const silence = within(table).getByRole('row', { name: /^Silence/ })
    expect(within(silence).getAllByRole('cell')[0]).toHaveTextContent('0')
  })
})

describe('the canvas is a document, not an analysis surface', () => {
  it('offers no By-code x coder toggle, even on a multi-coder install', async () => {
    // The analysis view offers it; an embed must not. It is an interactive
    // control inside written prose, and its position is per-observation local
    // state that no config records (#685), so it would forget itself on every
    // remount. The pooling DISCLOSURE still has to survive — see below.
    renderEmbed(timelineConfig({ observation_ids: [1] }))

    await screen.findByText('Playground morning')
    // `SegmentedControl` renders role="tablist" with the given aria-label.
    expect(screen.queryByRole('tablist', { name: /Table breakdown/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /By code/i })).not.toBeInTheDocument()
  })

  it('KEEPS the multi-coder pooling disclosure', async () => {
    // Suppressing the toggle by passing `multiCoder: false` would have taken
    // this #503-class honesty line with it, which is why they are separate props.
    renderEmbed(timelineConfig({ observation_ids: [1] }))

    await screen.findByText('Playground morning')
    expect(within(block('Playground morning')).getByText(/pools all visible coders/i)).toBeInTheDocument()
  })
})

describe('the consensus layer', () => {
  it('refuses to draw, and does not fetch anything', async () => {
    // A reachable saved state: the toolbar disables the Timeline button under
    // consensus but never changes `chart_type`, and "Add to Materials" is gated
    // on nothing (#684). Drawing here would put human-layer numbers under a
    // consensus material — the silent-wrong-layer case DEC-6c-7 refuses.
    renderEmbed(timelineConfig({ layer_scope: 'consensus' }))

    expect(await screen.findByText(/saved with the Consensus layer/i)).toBeInTheDocument()
    expect(observationsApi.list).not.toHaveBeenCalled()
    expect(observationsApi.listSegments).not.toHaveBeenCalled()
  })
})
