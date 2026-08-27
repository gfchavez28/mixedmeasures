/**
 * The dismiss control during a long export (#837).
 *
 * Measured on a 75,699-record survey, `/export/datasets-excel` is ~181 s of
 * server work, and the footer button was disabled for all of it.
 *
 * ⚠️ **It was NOT "no way out", and the correction is worth keeping:**
 * `DialogContent` renders a corner ✕ that is never disabled, so the dialog
 * could always be dismissed. What was wrong is that two controls performing the
 * identical action disagreed about whether it was allowed. Hence the assertions
 * below check the footer control specifically — by testid, since it now shares
 * the ✕'s accessible name deliberately.
 *
 * The claim is the PAIR, not the enabled-ness alone: it must stay usable AND
 * stop calling itself "Cancel", because closing does not cancel anything. A
 * test asserting only `toBeEnabled()` would pass on a button still labelled
 * "Cancel", which is the more misleading of the two states.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ExportDialog } from './ExportDialog'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

/** Resolves only when the test says so — stands in for the 181 s export. */
let releaseDatasetsExcel: () => void = () => {}
const datasetsExcel = vi.fn(
  () => new Promise<void>(resolve => { releaseDatasetsExcel = () => resolve() }),
)

vi.mock('@/lib/api', () => ({
  exportApi: {
    excelWithOptions: vi.fn(() => Promise.resolve()),
    csv: vi.fn(() => Promise.resolve()),
    codebook: vi.fn(() => Promise.resolve({})),
    datasetsExcel: (...a: unknown[]) => datasetsExcel(...(a as [])),
    codeFrequencies: vi.fn(() => Promise.resolve()),
    codedSegments: vi.fn(() => Promise.resolve()),
    codeCooccurrence: vi.fn(() => Promise.resolve()),
    rData: vi.fn(() => Promise.resolve()),
  },
  metricsApi: { rowMatrix: vi.fn(() => Promise.resolve()) },
  projectPortabilityApi: { export: vi.fn(() => Promise.resolve()) },
  projectsApi: { storage: vi.fn(() => Promise.resolve({ media_bytes: 0 })) },
  extractApiError: (e: unknown) => String(e),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ExportDialog open onOpenChange={vi.fn()} projectId={1} />
    </QueryClientProvider>,
  )
}

describe('ExportDialog — the dismiss control during a long export', () => {
  it('is labelled Cancel and enabled before an export starts', () => {
    renderDialog()
    const dismiss = screen.getByTestId('export-dismiss')
    expect(dismiss).toBeEnabled()
    expect(dismiss).toHaveAccessibleName('Cancel')
  })

  it('stays usable and becomes Close while an export is in flight', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Export Selected/ }))

    // The export is running: the trigger is busy…
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Exporting/ })).toBeDisabled()
    })
    // …and the way out is still there, under a name that does not lie.
    const dismiss = screen.getByTestId('export-dismiss')
    expect(dismiss).toBeEnabled()
    expect(dismiss).toHaveAccessibleName('Close')

    // ⚠️ Release only once the deferred export has actually been CALLED.
    // `handleExport` staggers its requests with `await delay(200)` between each,
    // and datasets-Excel is the fourth — so at the moment "Exporting" appears,
    // `releaseDatasetsExcel` is still the initial no-op and calling it resolves
    // nothing. That is what made the first version of this test hang.
    await waitFor(() => expect(datasetsExcel).toHaveBeenCalled())

    // …and reverts once the run finishes. The generous window is real, not
    // flake insurance: `handleExport` staggers its requests with six
    // `await delay(200)` calls, so the run cannot complete inside waitFor's
    // 1000 ms default however fast the mocks resolve.
    releaseDatasetsExcel()
    await waitFor(
      () => expect(screen.getByTestId('export-dismiss')).toHaveAccessibleName('Cancel'),
      { timeout: 4000 },
    )
  })

  it('tells the researcher the download survives closing', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Export Selected/ }))
    await waitFor(() => {
      expect(screen.getByText(/You can close this; the download still arrives/)).toBeInTheDocument()
    })
    releaseDatasetsExcel()
  })
})
