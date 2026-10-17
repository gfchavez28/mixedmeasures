/**
 * #1203 — *Import codebook* refuses a wrong file at selection, in the page's own
 * channel (a toast, as its server refusals are), and the codebook buttons stay
 * focusable while they work.
 *
 * Before: no check at all — a `.mmbackup` or `.mmproject` answered a 500 and a CSV
 * toasted "Expecting value: line 1 column 1 (char 0)"; no busy state on the import,
 * and the export went natively `disabled` (#965 — Chrome blurs it).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useCodebookState } from '@/hooks/useCodebookState'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import CodebookToolbar from './CodebookToolbar'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const MiB = 1024 * 1024

function file(name: string, size = 10) {
  const f = new File(['x'], name)
  Object.defineProperty(f, 'size', { value: size })
  return f
}

function Harness(props: {
  onImport: (f: File) => void; onExport: () => void; importing?: boolean; exporting?: boolean
}) {
  const cb = useCodebookState()
  const noop = () => {}
  return (
    <CodebookToolbar
      cb={cb} searchMatchCount={0} diagnostics={{} as never} totalCodes={1} totalCategories={0}
      treeData={undefined} isEmpty={false} hidePanelOpen={false} onToggleHidePanel={noop}
      hiddenCount={0} hiddenTooltip="" projectId={1} onCreateCode={noop} onCreateCategory={noop}
      onManageCodeSets={noop} onTreeExport={noop} onOverviewExport={noop} dataSegMax={20}
      onImportCodebook={props.onImport} onExportCodebook={props.onExport}
      isImportingCodebook={props.importing} isExportingCodebook={props.exporting}
    />
  )
}

function renderToolbar(opts: { importing?: boolean; exporting?: boolean } = {}) {
  const onImport = vi.fn()
  const onExport = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/projects/1/analysis/codebook']}>
          <Harness onImport={onImport} onExport={onExport} {...opts} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  const pick = (f: File) => fireEvent.change(input, { target: { files: [f] } })
  return { onImport, onExport, input, pick }
}

describe('#1203 — Import codebook refuses a wrong file before it is uploaded', () => {
  it('a CSV: refused in a toast held 10 s, nothing imported', () => {
    const { onImport, pick } = renderToolbar()
    pick(file('survey.csv'))
    expect(toast.error).toHaveBeenCalledWith(
      '“survey.csv” is not a codebook file. Import codebook takes a Mixed Measures codebook '
      + '(.mmcodebook) or a REFI-QDA codebook (.qdc).',
      { duration: 10_000 },
    )
    expect(onImport).not.toHaveBeenCalled()
  })

  it('a whole project is named as one (it answered a 500)', () => {
    const { onImport, pick } = renderToolbar()
    pick(file('Northgate.mmproject'))
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/is a whole project, not a codebook/), { duration: 10_000 })
    expect(onImport).not.toHaveBeenCalled()
  })

  it('a codebook over 10 MB is refused with the limit', () => {
    const { onImport, pick } = renderToolbar()
    pick(file('big.mmcodebook', 10 * MiB + 1))
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/over the 10 MB limit for a codebook/), { duration: 10_000 })
    expect(onImport).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: a REFI-QDA codebook in capitals is imported, nothing said', () => {
    const { onImport, pick } = renderToolbar()
    const qdc = file('x.QDC')
    pick(qdc)
    expect(onImport).toHaveBeenCalledWith(qdc)
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('#1203 — the codebook buttons stay focusable while they work (#965)', () => {
  it('Import codebook: aria-disabled + aria-busy, NOT disabled, and the picker stays shut', () => {
    const { input } = renderToolbar({ importing: true })
    const button = screen.getByRole('button', { name: 'Import codebook' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).not.toBeDisabled()
    const opens = vi.spyOn(input, 'click')
    fireEvent.click(button)
    expect(opens).not.toHaveBeenCalled()
  })

  it('Import codebook at rest opens the picker (the positive control)', () => {
    const { input } = renderToolbar()
    const button = screen.getByRole('button', { name: 'Import codebook' })
    expect(button).not.toHaveAttribute('aria-disabled')
    const opens = vi.spyOn(input, 'click')
    fireEvent.click(button)
    expect(opens).toHaveBeenCalledTimes(1)
  })

  it('Export codebook: aria-disabled + aria-busy, NOT disabled, and a press exports nothing more', () => {
    const { onExport } = renderToolbar({ exporting: true })
    const button = screen.getByRole('button', { name: 'Export codebook as Mixed Measures format' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onExport).not.toHaveBeenCalled()
  })

  it('Export codebook at rest exports (the positive control)', () => {
    const { onExport } = renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: 'Export codebook as Mixed Measures format' }))
    expect(onExport).toHaveBeenCalledWith('native')
  })
})
