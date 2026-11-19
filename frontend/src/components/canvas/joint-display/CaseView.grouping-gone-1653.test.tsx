/**
 * #1653 (D347) — the case view's read answers a gone grouping variable with the compute's code
 * (`GROUPING_GONE`), and the case view says the display's own sentence — no Retry, since a second
 * request could not bring the variable back. It said "That variable is not in this project." under
 * "The cases could not be loaded" with a Retry. Mocks as `CaseView-slice2.test.tsx`.
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { displayCoderScope, readDisplay } from '@/lib/joint-display'
import * as W from '@/lib/joint-display-vocabulary'

const api = vi.hoisted(() => ({ cases: vi.fn() }))
vi.mock('@/lib/api', () => ({ jointDisplayApi: { cases: api.cases } }))

import CaseView from './CaseView'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const DISPLAY = readDisplay({
  group_by_column_id: 7, conversation_ids: null, document_ids: null,
  rows: [{ key: 'r1', construct: 'Planning', code_ids: [3], column_ids: [8] }],
})
const notFound = (detail: unknown) =>
  Object.assign(new Error('x'), { status: 404, response: { status: 404, data: { detail }, headers: {} } })

function renderView() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CaseView open onOpenChange={vi.fn()} projectId={9} display={DISPLAY} rowKey="r1"
        scope={displayCoderScope(false, 1)} noViewer={false} onCommit={vi.fn(() => true)} />
    </QueryClientProvider>,
  )
}

describe('#1653 (D347) — the case view and a gone grouping variable', () => {
  it('says GROUPING_GONE_TEXT, with no Retry', async () => {
    api.cases.mockRejectedValue(notFound({ code: W.SERVER_VOCABULARY.GROUPING_GONE, message: 'That variable is not in this project.' }))
    renderView()
    expect(await screen.findByRole('alert')).toHaveTextContent(W.GROUPING_GONE_TEXT)
    expect(screen.queryByText(W.CASES_FAILED_TEXT)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('control: any other failure keeps the shared notice and its Retry', async () => {
    api.cases.mockRejectedValue(notFound('Code not found in this project'))
    renderView()
    expect(await screen.findByText(W.CASES_FAILED_TEXT)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
