import { useEffect } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useCodebookState } from '@/hooks/useCodebookState'
import CodebookToolbar from './CodebookToolbar'

/**
 * #1147 — *Segments ▸ Reset filter* clears both bounds in ONE click
 * (`cb.setMinSeg(0); cb.setMaxSeg(null)`). On React Router's own setter the second
 * write started from the render's URL, so `?minSeg=3` survived the reset and the
 * control did nothing. The real toolbar and the real hook, in a router.
 *
 * `?maxSeg=8` alone is the control: there the LAST write is the right one, so it
 * passed either way — which is how the defect hid.
 */

afterEach(cleanup)

const seen = { search: '' }

function Harness() {
  const cb = useCodebookState()
  const { search } = useLocation()
  useEffect(() => { seen.search = search }, [search])
  const noop = () => {}
  return (
    <CodebookToolbar
      cb={cb} searchMatchCount={0} diagnostics={{} as never} totalCodes={1} totalCategories={0}
      treeData={undefined} isEmpty={false} hidePanelOpen={false} onToggleHidePanel={noop}
      hiddenCount={0} hiddenTooltip="" projectId={1} onCreateCode={noop} onCreateCategory={noop}
      onManageCodeSets={noop} onTreeExport={noop} onOverviewExport={noop} dataSegMax={20}
    />
  )
}

function renderAt(search: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/projects/1/analysis/codebook${search}`]}>
          <Harness />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('Codebook toolbar — Reset filter', () => {
  for (const search of ['?minSeg=3', '?minSeg=3&maxSeg=8', '?maxSeg=8']) {
    it(`clears both bounds from ${search}`, () => {
      renderAt(search)
      fireEvent.click(screen.getByTitle('Filter codes by segment count'))
      fireEvent.click(screen.getByText('Reset filter'))
      const params = new URLSearchParams(seen.search)
      expect([params.get('minSeg'), params.get('maxSeg')]).toEqual([null, null])
    })
  }
})
