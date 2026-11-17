/**
 * #1531 D102 (1.5.9) — while blind, a passage's chips are the viewer's own.
 *
 * The analysis page's passage lists narrowed WHICH passages appear by `coder_ids` but drew every
 * coder's codes on each (measured on the review kit: blind Alice's T1 came back `[3, 5]`, 5 being
 * a code only Bob applied there). The list carries bare code ids, so no client lens can narrow
 * them; the request asks (`chips_follow_coder_ids`), and only while blind mode WITHHOLDS — a
 * coder FILTER keeps whole-unit chips. Both lists (passages and survey answers), both ways, and
 * the flag in both keys, so a reveal refetches (#454).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Code } from '@/lib/api'
import type { ListStatus } from '@/lib/list-status'

const api = vi.hoisted(() => ({
  segmentsWithContext: vi.fn((..._a: unknown[]) => new Promise(() => {})),
  textsWithContext: vi.fn((..._a: unknown[]) => new Promise(() => {})),
}))
vi.mock('@/lib/api', () => ({
  codeAnalysisApi: { segmentsWithContext: api.segmentsWithContext, textsWithContext: api.textsWithContext },
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 2, username: 'Alice' }, refreshAuth: vi.fn() }),
}))

import ContentByCode from './ContentByCode'

const CODES = [
  { id: 10, name: 'Shared theme', color: '#3b82f6', is_active: true, is_universal: false },
] as unknown as Code[]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderTab(chipsFollowCoderIds: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (flag: boolean) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ContentByCode
          viewerId={1}
          projectId={1} codes={CODES} codesStatus={'ready' as ListStatus} frequencies={[]}
          selectedContentCodeId={10} onCodeSelect={() => {}}
          filterParams={{ source: 'all', coder_ids: '2' }}
          source="all" hasConversations hasCommentColumns hasDocuments={false} hasObservations={false}
          chipsFollowCoderIds={flag}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const r = render(ui(chipsFollowCoderIds))
  return { flip: (flag: boolean) => r.rerender(ui(flag)) }
}

const lastParams = (fn: typeof api.segmentsWithContext) =>
  fn.mock.calls[fn.mock.calls.length - 1][2] as Record<string, unknown>

describe('ContentByCode — the chips follow the scope only while blind (#1531 D102)', () => {
  it('while withholding, both lists ask for the scope’s chips', async () => {
    renderTab(true)
    await waitFor(() => expect(api.segmentsWithContext).toHaveBeenCalled())
    await waitFor(() => expect(api.textsWithContext).toHaveBeenCalled())
    expect(lastParams(api.segmentsWithContext)).toMatchObject({ coder_ids: '2', chips_follow_coder_ids: true })
    expect(lastParams(api.textsWithContext)).toMatchObject({ coder_ids: '2', chips_follow_coder_ids: true })
  })

  it('otherwise (a coder filter, a reveal) neither list sends the flag — the request is as before', async () => {
    renderTab(false)
    await waitFor(() => expect(api.segmentsWithContext).toHaveBeenCalled())
    await waitFor(() => expect(api.textsWithContext).toHaveBeenCalled())
    expect(lastParams(api.segmentsWithContext)).not.toHaveProperty('chips_follow_coder_ids')
    expect(lastParams(api.textsWithContext)).not.toHaveProperty('chips_follow_coder_ids')
    expect(lastParams(api.segmentsWithContext)).toMatchObject({ coder_ids: '2' })
  })

  it('a reveal is a NEW key for both lists — the chips are asked again (#454)', async () => {
    const { flip } = renderTab(true)
    await waitFor(() => expect(api.segmentsWithContext).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.textsWithContext).toHaveBeenCalledTimes(1))
    flip(false)
    await waitFor(() => expect(api.segmentsWithContext).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.textsWithContext).toHaveBeenCalledTimes(2))
  })
})
