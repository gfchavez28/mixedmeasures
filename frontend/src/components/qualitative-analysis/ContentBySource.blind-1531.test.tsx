/**
 * #1531 D102 (1.5.9) — the analysis page's *By Source* view shows a blind coder her own codes.
 *
 * Measured before (the review kit, 2026-11-05c, build session B): blind Alice's *By Source* view
 * drew *Bob theme* on T1 and T3, each with a "Remove code Bob theme" button. D102 decided "the
 * analysis page's passage lists show a blind coder her own codes only"; the *By Code* lists needed
 * a server flag (bare ids), but every payload here names each application's coder, so the
 * workbenches' lens narrows it in the client. All four readers, both chip branches, the focus
 * dimming (a colleague's code must not light a passage up), and the notice — each with its
 * unscoped twin, so a reader that always or never narrows fails one of them.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const api = vi.hoisted(() => ({
  listSegments: vi.fn(),
  getDetail: vi.fn(),
  listObservationSegments: vi.fn(),
  listTexts: vi.fn(),
}))
vi.mock('@/lib/api', () => ({
  segmentsApi: { list: api.listSegments },
  documentsApi: { getDetail: api.getDetail },
  observationsApi: { listSegments: api.listObservationSegments },
  textCodingApi: { list: api.listTexts },
  TEXT_PAGE_SIZE: 200,
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 2, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

import ContentBySource from './ContentBySource'
import type { Code } from '@/lib/api'
import type { ListLoad, ListStatus } from '@/lib/list-status'
import { onlyCoders, type CoderLens } from '@/lib/coder-color'

const ALICE = 2
const BOB = 3
const READY: ListLoad = { status: 'ready', error: null, retry: () => {}, retrying: false }
const CODES = [
  { id: 10, name: 'Alice theme', color: '#16a34a', is_active: true, is_universal: false },
  { id: 11, name: 'Bob theme', color: '#dc2626', is_active: true, is_universal: false },
] as unknown as Code[]
/** T one: both coders' codes; T three: only Bob's. */
const details = (pairs: [number, number][]) =>
  pairs.map(([code_id, user_id]) => ({ code_id, user_id, attribution: null, is_universal: false, magnitude: null, magnitude_conflict: null }))
const T_ONE = [[10, ALICE], [11, BOB]] as [number, number][]
const T_THREE = [[11, BOB]] as [number, number][]

beforeEach(() => {
  api.listSegments.mockResolvedValue({
    coded_count: 2,
    segments: [
      { id: 1, text: 'T one', speaker_name: 'Ana', is_facilitator: false, applied_codes: [10, 11], applied_code_details: details(T_ONE) },
      { id: 3, text: 'T three', speaker_name: 'Ana', is_facilitator: false, applied_codes: [11], applied_code_details: details(T_THREE) },
    ],
  })
  api.getDetail.mockResolvedValue({
    id: 8, name: 'Handbook', coded_segment_count: 2,
    segments: [
      { id: 21, text: 'T one', sequence_order: 0, heading_level: null, codes: T_ONE.map(([id, user_id]) => ({ id, user_id, name: '', color: null, is_universal: false })) },
      { id: 23, text: 'T three', sequence_order: 1, heading_level: null, codes: T_THREE.map(([id, user_id]) => ({ id, user_id, name: '', color: null, is_universal: false })) },
    ],
  })
  api.listObservationSegments.mockResolvedValue([
    { id: 31, text: 'T one', start_time: 0, end_time: 5, applied_codes: [10, 11], applied_code_details: details(T_ONE) },
    { id: 33, text: 'T three', start_time: 5, end_time: 9, applied_codes: [11], applied_code_details: details(T_THREE) },
  ])
  api.listTexts.mockResolvedValue({
    total_texts: 2, has_more: false,
    texts: [
      { dataset_value_id: 41, dataset_row_id: 1, row_identifier: 'R1', value_text: 'T one', applied_code_ids: [10, 11], applied_code_details: details(T_ONE) },
      { dataset_value_id: 43, dataset_row_id: 2, row_identifier: 'R2', value_text: 'T three', applied_code_ids: [11], applied_code_details: details(T_THREE) },
    ],
  })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function renderReader(source: string, lens: CoderLens | null, over: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ContentBySource
          projectId={1} codes={CODES} codesStatus={'ready' as ListStatus} sourcesLoad={READY}
          conversations={[{ id: 5, name: 'Interview 1' }] as never}
          textColumns={[{ column_id: 7, column_name: 'Why', column_text: 'Why?', dataset_id: 2, dataset_name: 'Survey', coded_count: 2 }] as never}
          documents={[{ id: 8, name: 'Handbook' }] as never}
          observations={[{ id: 9, name: 'Playground' }] as never}
          selectedSourceId={source} onSourceSelect={() => {}} source="all"
          coderLens={lens} blind={lens != null}
          {...over}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The blind lens before the roster answers (an allow-list) and after (a hide set) — both shapes. */
const LENSES: [string, CoderLens][] = [['an allow-list of self', onlyCoders([ALICE])], ['the roster hide set', new Set([BOB])]]
const READERS = [['a conversation', 'c:5'], ['a document', 'd:8'], ['an observation', 'o:9'], ['a text column', 'cc:7']] as const

describe('ContentBySource while blind (#1531 D102)', () => {
  for (const [what, source] of READERS) {
    for (const [lensName, lens] of LENSES) {
      it(`${what}: no colleague's code is drawn (${lensName}), her own is`, async () => {
        renderReader(source, lens)
        expect(await screen.findAllByText('Alice theme')).toHaveLength(1)
        expect(screen.queryByText('Bob theme')).toBeNull()
      })
    }

    it(`${what}: nothing withheld, every coder's codes are drawn (the unscoped twin)`, async () => {
      renderReader(source, null)
      expect(await screen.findAllByText('Bob theme')).toHaveLength(2)
    })
  }

  it('the editable chips (the analysis page passes onCodeChange) narrow too — no "Remove code Bob theme"', async () => {
    renderReader('c:5', onlyCoders([ALICE]), { onCodeChange: () => {} })
    expect(await screen.findByText('Alice theme')).toBeInTheDocument()
    expect(screen.queryByText('Bob theme')).toBeNull()
    expect(screen.queryByRole('button', { name: /Bob theme/ })).toBeNull()
  })

  it('…and with nothing withheld the editable chips draw both (the twin)', async () => {
    renderReader('c:5', null, { onCodeChange: () => {} })
    expect(await screen.findAllByText('Bob theme')).toHaveLength(2)
  })

  it('a colleague’s code does not light a passage up: focused on it, the passage only he coded is dimmed', async () => {
    renderReader('c:5', onlyCoders([ALICE]), { focusedCodeId: 11 })
    const row = (await screen.findByText('T three')).closest('[style]') as HTMLElement
    expect(row.style.opacity).toBe('0.35')
  })

  it('…and with nothing withheld that passage carries the focused code and is not dimmed (the twin)', async () => {
    renderReader('c:5', null, { focusedCodeId: 11 })
    const text = await screen.findByText('T three')
    expect((text.closest('[style]') as HTMLElement | null)?.style.opacity ?? '').not.toBe('0.35')
  })

  it('says so once, with the logged reveal; says nothing when not blind', async () => {
    const reveals: (string | undefined)[] = []
    renderReader('c:5', onlyCoders([ALICE]), { onReveal: (s?: string) => { reveals.push(s) } })
    expect(await screen.findByText(/each passage shows only your own codes/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Colleagues hidden' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }))
    expect(reveals).toEqual(['analysis'])
    cleanup()
    renderReader('c:5', null)
    expect(await screen.findAllByText('Bob theme')).toHaveLength(2)
    expect(screen.queryByText(/each passage shows only your own codes/)).toBeNull()
  })
})
