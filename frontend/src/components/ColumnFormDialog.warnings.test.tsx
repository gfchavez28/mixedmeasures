/**
 * #1368 — the formula preview shows the server's warning SENTENCES.
 *
 * It rendered "(1 warning)" and nothing else, so every warning the validator
 * writes — an ordered comparison on text, arithmetic on a category, a quoted
 * answer the column does not have — told the researcher something was wrong
 * and never what. The sentences are inside `#formula-status`, which describes
 * the formula box, so they are announced and reachable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ColumnFormDialog } from './ColumnFormDialog'
import { datasetsApi } from '@/lib/api'

// #1615 — the preview reads the blind scope; not blind here.
vi.mock('@/hooks/useBlindScope', () => ({ useBlindScope: () => ({ coderScope: undefined, scopeReady: true }) }))
vi.mock('@/lib/api', () => ({
  datasetsApi: { previewComputedColumn: vi.fn() },
}))

afterEach(cleanup)

const WARNING = '"Agre" is not an answer in column \'Q1\' (its answers are "Agree"), so this comparison never matches.'

describe('the formula preview', () => {
  it('shows each warning sentence, inside the status that describes the formula box', async () => {
    vi.mocked(datasetsApi.previewComputedColumn).mockResolvedValue({
      valid: true, error: null, warnings: [WARNING], preview_rows: [], r_expression: null,
    } as never)
    render(
      <ColumnFormDialog
        open onOpenChange={() => {}} onSubmit={() => {}} isSubmitting={false}
        submitError={null} title="Computed" mode="computed" projectId={1} datasetId={2}
      />,
    )
    fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '[Q1] == "Agre"' } })
    await waitFor(() => expect(screen.getByText(WARNING)).toBeTruthy(), { timeout: 2000 })
    const status = document.getElementById('formula-status')!
    expect(status.contains(screen.getByText(WARNING))).toBe(true)
    expect(screen.getByLabelText('Formula').getAttribute('aria-describedby')).toBe('formula-status')
  })

  it('shows no warning list when there is none (control)', async () => {
    vi.mocked(datasetsApi.previewComputedColumn).mockResolvedValue({
      valid: true, error: null, warnings: [], preview_rows: [], r_expression: null,
    } as never)
    render(
      <ColumnFormDialog
        open onOpenChange={() => {}} onSubmit={() => {}} isSubmitting={false}
        submitError={null} title="Computed" mode="computed" projectId={1} datasetId={2}
      />,
    )
    fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '[Q1] == 4' } })
    await waitFor(() => expect(screen.getByText('Valid')).toBeTruthy(), { timeout: 2000 })
    expect(screen.queryByTestId('formula-warnings')).toBeNull()
  })
})
