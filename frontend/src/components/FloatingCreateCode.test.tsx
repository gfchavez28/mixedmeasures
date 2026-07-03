/**
 * #526 — in-vivo coding: create-code prefills from the current text selection.
 * selectionPrefill() is captured at open time by the three workbenches and
 * passed as initialName; the input select-alls so typing replaces it.
 */
import { it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/api', () => ({
  codesApi: { create: vi.fn() },
  categoriesApi: { create: vi.fn() },
}))

import FloatingCreateCode from './FloatingCreateCode'
import { selectionPrefill } from '@/lib/floating-utils'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mockSelection(text: string) {
  vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => text } as Selection)
}

it('selectionPrefill collapses whitespace and trims', () => {
  mockSelection('  the summer\n training   really helped ')
  expect(selectionPrefill()).toBe('the summer training really helped')
})

it('selectionPrefill returns undefined for empty/whitespace selections', () => {
  mockSelection('   \n ')
  expect(selectionPrefill()).toBeUndefined()
})

it('selectionPrefill caps long selections with an ellipsis', () => {
  mockSelection('x'.repeat(100))
  const out = selectionPrefill(60)!
  expect(out.length).toBeLessThanOrEqual(61)
  expect(out.endsWith('…')).toBe(true)
})

it('prefills the name input from initialName', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <FloatingCreateCode
        position={{ x: 10, y: 10 }}
        projectId={1}
        categories={[]}
        onCreated={() => {}}
        onClose={() => {}}
        initialName="inquiry devolved into group work"
      />
    </QueryClientProvider>,
  )
  expect(screen.getByPlaceholderText('Code name')).toHaveValue('inquiry devolved into group work')
})
