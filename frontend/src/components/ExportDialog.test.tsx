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
import {
  ExportDialog, EXPORT_BLIND_SENTENCE, EXPORT_REVEALED_SENTENCE, EXPORT_WAITING_SENTENCE,
} from './ExportDialog'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

// #1530 (1.5.9): the dialog reads the blind state. The defaults are a single-coder install,
// settled — every file exactly as before, which is what the older tests below describe.
const h = vi.hoisted(() => ({
  blind: { blind: false, withholding: false, settled: true },
  multiHumanCoder: false,
  user: { id: 2, username: 'Alice' } as { id: number; username: string } | null,
  toggleReveal: (() => {}) as (surface?: string) => void,
}))
const SINGLE_CODER = { blind: false, withholding: false, settled: true }
vi.mock('@/hooks/useBlindMode', () => ({
  useBlindMode: () => ({ ...h.blind, blindLens: new Set<number>(), toggleReveal: h.toggleReveal }),
}))
vi.mock('@/hooks/useCoders', () => ({ useCoders: () => ({ multiHumanCoder: h.multiHumanCoder }) }))
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ user: h.user }) }))

// #1528 D87: the Frequencies CSV is written in the browser from the summary table's read.
const exportCodeFrequenciesCsv = vi.fn((..._a: unknown[]) => Promise.resolve())
vi.mock('@/lib/code-frequencies-export', () => ({
  exportCodeFrequenciesCsv: (...a: unknown[]) => exportCodeFrequenciesCsv(...a),
}))

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
  h.blind = { ...SINGLE_CODER }
  h.multiHumanCoder = false
  h.user = { id: 2, username: 'Alice' }
  h.toggleReveal = () => {}
})

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ExportDialog open onOpenChange={vi.fn()} projectId={1} projectName="Ferns" />
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

describe('ExportDialog — a project-wide co-occurrence file holds every kind (#1527 D86)', () => {
  it('asks for every source, so survey answers are in it', async () => {
    const { exportApi } = await import('@/lib/api')
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Export Selected/ }))
    await waitFor(() => expect(datasetsExcel).toHaveBeenCalled())
    releaseDatasetsExcel()
    await waitFor(() => expect(exportApi.codeCooccurrence).toHaveBeenCalled(), { timeout: 4000 })
    expect(exportApi.codeCooccurrence).toHaveBeenCalledWith(1, { source: 'all' })
  })
})

describe('ExportDialog — the project-wide Frequencies CSV is the summary table over everything (#1528 D87)', () => {
  it('asks for every code and every source of every kind, interviewer turns out, no scope', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Export Selected/ }))
    await waitFor(() => expect(datasetsExcel).toHaveBeenCalled())
    releaseDatasetsExcel()
    await waitFor(() => expect(exportCodeFrequenciesCsv).toHaveBeenCalled(), { timeout: 4000 })
    // No code list and no source list: absent = every one (the server's `is not None`
    // reading). The old server file, asked with no parameters, held no survey answer.
    expect(exportCodeFrequenciesCsv).toHaveBeenCalledWith(1, {
      request: { exclude_facilitator: true },
      categoryMode: false, scope: null, projectName: 'Ferns',
    })
  })

  it('names the file after the project even when the name arrives after the first render', async () => {
    // Found by driving: the layout's project loads after it first renders, and the export
    // handler kept the first render's `undefined` — the file lost the project's name.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // ONE `onOpenChange` across renders, as the layout's state setter is: a fresh function per
    // render would rebuild the handler anyway and hide the stale name (the first draft did).
    const onOpenChange = vi.fn()
    const ui = (name: string | undefined) => (
      <QueryClientProvider client={client}>
        <ExportDialog open onOpenChange={onOpenChange} projectId={1} projectName={name} />
      </QueryClientProvider>
    )
    const { rerender } = render(ui(undefined))
    rerender(ui('Ferns'))
    fireEvent.click(screen.getByRole('button', { name: /Export Selected/ }))
    await waitFor(() => expect(datasetsExcel).toHaveBeenCalled())
    releaseDatasetsExcel()
    await waitFor(() => expect(exportCodeFrequenciesCsv).toHaveBeenCalled(), { timeout: 4000 })
    expect(exportCodeFrequenciesCsv.mock.calls[0][1]).toMatchObject({ projectName: 'Ferns' })
  })
})

/**
 * #1530 D95–D97 (1.5.9) — blind mode reaches the files.
 *
 * Measured before (one install, 2026-11-05): with colleagues hidden on every screen, *Export
 * Selected* sent no coder scope, and the files held a colleague's coding by name, passage and
 * rating. Each file carrying the human coding layer now asks for the viewer's own coding while
 * blind mode WITHHOLDS; the codebook counts, the datasets workbook and the record matrix do not
 * change (D95). Every scoped assertion has its unscoped twin, so a dialog that always or never
 * sends the scope fails one of them.
 */
describe('ExportDialog — while blind, the files hold your own coding (#1530)', () => {
  const BLIND = { blind: true, withholding: true, settled: true }

  /** Ticks the R export too (off by default), presses Export Selected and waits for the run. */
  async function exportEverything() {
    fireEvent.click(screen.getByRole('checkbox', { name: /R Data Export/ }))
    fireEvent.click(screen.getByRole('button', { name: /Export Selected/ }))
    await waitFor(() => expect(datasetsExcel).toHaveBeenCalled())
    releaseDatasetsExcel()
    const { exportApi } = await import('@/lib/api')
    await waitFor(() => expect(exportApi.rData).toHaveBeenCalled(), { timeout: 4000 })
    return exportApi
  }

  it('asks every coding file for the viewer alone, and says so on the Frequencies line', async () => {
    h.blind = BLIND
    h.multiHumanCoder = true
    renderDialog()
    const exportApi = await exportEverything()
    expect(vi.mocked(exportApi.excelWithOptions).mock.calls[0][2]).toBe('2')
    expect(exportApi.csv).toHaveBeenCalledWith(1, '2')
    expect(exportApi.codedSegments).toHaveBeenCalledWith(1, { coder_ids: '2' })
    expect(exportApi.codeCooccurrence).toHaveBeenCalledWith(1, { source: 'all', coder_ids: '2' })
    expect(exportApi.rData).toHaveBeenCalledWith(1, '2')
    expect(exportCodeFrequenciesCsv).toHaveBeenCalledWith(1, {
      request: { exclude_facilitator: true, coder_ids: [2] },
      categoryMode: false, scope: 'Scope: coders: Alice', projectName: 'Ferns',
    })
    // #1608: the datasets workbook carries the participant table's rating columns.
    expect(datasetsExcel).toHaveBeenCalledWith(1, '2')
    // Every coder by design (#454) — asked exactly as before.
    expect(exportApi.codebook).toHaveBeenCalledWith(1)
  })

  it('…and asks for every coder when nothing withholds (a single coder, or after a reveal)', async () => {
    h.multiHumanCoder = true
    h.blind = { blind: false, withholding: false, settled: true }   // revealed
    renderDialog()
    const exportApi = await exportEverything()
    expect(vi.mocked(exportApi.excelWithOptions).mock.calls[0][2]).toBeUndefined()
    expect(exportApi.csv).toHaveBeenCalledWith(1, undefined)
    expect(exportApi.codedSegments).toHaveBeenCalledWith(1, undefined)
    expect(exportApi.codeCooccurrence).toHaveBeenCalledWith(1, { source: 'all' })
    expect(exportApi.rData).toHaveBeenCalledWith(1, undefined)
    expect(exportCodeFrequenciesCsv.mock.calls[0][1]).toMatchObject({
      request: { exclude_facilitator: true }, scope: null,
    })
  })

  it('says so above the list, with the same logged reveal (surface "export")', async () => {
    h.blind = BLIND
    h.multiHumanCoder = true
    const reveals: (string | undefined)[] = []
    h.toggleReveal = s => { reveals.push(s) }
    renderDialog()
    const box = screen.getByTestId('export-blind-scope')
    expect(box).toHaveTextContent(EXPORT_BLIND_SENTENCE)
    fireEvent.click(screen.getByRole('button', { name: 'Colleagues hidden' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }))
    expect(reveals).toEqual(['export'])
  })

  it('once revealed it says the files hold every coder, and offers to hide again', () => {
    h.multiHumanCoder = true
    h.blind = { blind: false, withholding: false, settled: true }
    renderDialog()
    expect(screen.getByTestId('export-blind-scope')).toHaveTextContent(EXPORT_REVEALED_SENTENCE)
    expect(screen.getByRole('button', { name: 'Colleagues shown' })).toBeInTheDocument()
  })

  it('says nothing on a single-coder project (positive control: the box exists when it should)', () => {
    renderDialog()
    expect(screen.queryByTestId('export-blind-scope')).toBeNull()
  })

  it('waits for the scope: the button is aria-disabled (still focusable), says why, and does nothing', async () => {
    h.blind = { blind: false, withholding: true, settled: false }   // the roster has not answered
    renderDialog()
    const button = screen.getByRole('button', { name: /Export Selected/ })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAccessibleDescription(EXPORT_WAITING_SENTENCE)
    fireEvent.click(button)
    await new Promise(r => setTimeout(r, 300))
    const { exportApi } = await import('@/lib/api')
    expect(exportApi.excelWithOptions).not.toHaveBeenCalled()
    expect(exportCodeFrequenciesCsv).not.toHaveBeenCalled()
  })

  it('withholding with no one to scope to waits too — never falls back to every coder', async () => {
    h.blind = BLIND
    h.user = null
    renderDialog()
    const button = screen.getByRole('button', { name: /Export Selected/ })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)
    await new Promise(r => setTimeout(r, 300))
    const { exportApi } = await import('@/lib/api')
    expect(exportApi.excelWithOptions).not.toHaveBeenCalled()
  })

  it('settled, the same button is plain and starts the export (positive control)', async () => {
    renderDialog()
    const button = screen.getByRole('button', { name: /Export Selected/ })
    expect(button).not.toHaveAttribute('aria-disabled')
    fireEvent.click(button)
    const { exportApi } = await import('@/lib/api')
    await waitFor(() => expect(exportApi.excelWithOptions).toHaveBeenCalled())
    releaseDatasetsExcel()
  })
})

describe('ExportDialog — the Sources sheet option (#1534 D109)', () => {
  // The box was "Summaries" and sent `include_summaries` (`excelWithOptions` builds
  // `include_<key>`), which the route stopped reading when #895 renamed the sheet in v1.5.2 —
  // unticking it left the sheet in every workbook. The route's name is pinned by
  // `lib/api/request-contract.test.ts`; this pins that the dialog's box drives that key.
  async function exportWith(untick: boolean) {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Expand sub-options' }))
    const box = screen.getByRole('checkbox', { name: 'Sources' })
    expect(box).toBeChecked()
    if (untick) fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: /Export Selected/ }))
    const { exportApi } = await import('@/lib/api')
    await waitFor(() => expect(exportApi.excelWithOptions).toHaveBeenCalled())
    releaseDatasetsExcel()
    return vi.mocked(exportApi.excelWithOptions).mock.calls[0][1] as Record<string, unknown>
  }

  it('unticking Sources sends sources: false — and no summaries key', async () => {
    const options = await exportWith(true)
    expect(options.sources).toBe(false)
    expect(options).not.toHaveProperty('summaries')
  })

  it('positive control: left ticked, it sends sources: true', async () => {
    const options = await exportWith(false)
    expect(options.sources).toBe(true)
  })
})
