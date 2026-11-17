/**
 * #1640 — on *By Code*, a coded answer the project counts as no response ("N/A", …) stays in the
 * list and SAYS so.
 *
 * The header ("2 texts") and the code list's badge read `get_code_frequencies`' usage count, which
 * keeps such an answer on purpose (#1526 D80), so the list keeps it too — it is a coding, and this
 * list is where a researcher finds it to remove it. The Descriptives table's shares leave it out;
 * the mark is what says why the two counts differ. The server decides it
 * (`counted_as_no_response`, `is_empty_text` over the project's own list); the client only renders.
 *
 * Fixture: one survey answer flagged, one not, on the same list — the unflagged one is the
 * positive control that the mark is not drawn on every row.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { Code, CodeTextsResponse } from '@/lib/api'
import type { ListStatus } from '@/lib/list-status'

const api = vi.hoisted(() => ({ segmentsWithContext: vi.fn(), textsWithContext: vi.fn() }))
vi.mock('@/lib/api', () => ({
  codeAnalysisApi: { segmentsWithContext: api.segmentsWithContext, textsWithContext: api.textsWithContext },
  codingApi: { removeCode: vi.fn(), applyCode: vi.fn() },
  textCodingApi: { removeCode: vi.fn(), applyCode: vi.fn() },
  codesApi: { create: vi.fn() },
}))
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 1, username: 'Ada' }, refreshAuth: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import ContentByCode from './ContentByCode'

const FOCUS = 10
const CODES = [
  { id: FOCUS, name: 'Focus', color: '#3b82f6', is_active: true, is_universal: false },
] as unknown as Code[]

const text = (id: number, value_text: string, counted_as_no_response: boolean) => ({
  dataset_value_id: id, value_text, word_count: 1, row_identifier: `R${id}`,
  dataset_name: 'Survey', column_name: 'Q1', applied_code_ids: [FOCUS],
  applied_code_details: [{ code_id: FOCUS, user_id: 1 }], counted_as_no_response,
})

const TEXTS: CodeTextsResponse = {
  code_id: FOCUS, code_name: 'Focus', code_color: null, category_name: null, total_texts: 2, has_more: false,
  datasets: [{
    dataset_id: 3, dataset_name: 'Survey', text_count: 2,
    texts: [text(101, 'a real answer', false), text(102, 'N/A', true)],
  }],
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ContentByCode
          viewerId={1}
          projectId={1} codes={CODES} allCodes={CODES} codesStatus={'ready' as ListStatus} frequencies={[]}
          selectedContentCodeId={FOCUS} onCodeSelect={() => {}} filterParams={{ source: 'text' }}
          source="text" hasConversations={false} hasCommentColumns hasDocuments={false}
          hasObservations={false} chipsFollowCoderIds={false} onCodeChange={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The card holding one answer — the row the mark must sit in. */
const cardOf = (answer: string) => {
  const card = screen.getByText(answer).closest('.rounded-md')
  expect(card).not.toBeNull()
  return card as HTMLElement
}

afterEach(() => { cleanup(); vi.clearAllMocks() })
beforeEach(() => { api.textsWithContext.mockResolvedValue(TEXTS) })

describe('By Code: a coded no-response answer stays listed and says so (#1640)', () => {
  it('lists both answers and marks only the one the project counts as no response', async () => {
    renderTab()
    expect(await screen.findByText('N/A')).toBeInTheDocument()
    expect(within(cardOf('N/A')).getByText('Counted as no response')).toBeInTheDocument()
    // Positive control: the substantive answer is listed and carries no mark.
    expect(within(cardOf('a real answer')).queryByText('Counted as no response')).not.toBeInTheDocument()
    expect(screen.getAllByText('Counted as no response')).toHaveLength(1)
  })
})
