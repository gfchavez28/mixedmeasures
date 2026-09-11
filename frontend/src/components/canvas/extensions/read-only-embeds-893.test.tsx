/**
 * #893 — a read-only Tiptap surface must not offer to mutate what it shows.
 *
 * The Canvas Compare diff builds its editors with `editable: false`, which gates
 * ProseMirror's DOM editing and input handling but NOT a programmatic
 * `deleteNode()` — so every embed rendered four working mutation controls
 * (measured live on `?canvas=4&canvas2=5`: two `Remove from canvas` buttons and
 * two `Add tag` buttons, `disabled: false`, no `aria-disabled`).
 *
 * 🔴 **Three things this file exists to keep true, each learned the hard way:**
 *
 * 1. **The tag is CONTENT, not a control.** `MaterialsTagInline` is ONE button
 *    that is both the *Add tag* affordance and the only thing that DISPLAYS an
 *    existing tag. Hiding the cluster wholesale — which `ImageEmbedView` already
 *    did — deletes an authored `confirms`/`contradicts` annotation from the
 *    surface whose whole job is showing what differs between two canvases.
 *    That is #790's rule: a DISPLAY fact and a TOGGLE state must not share one
 *    variable.
 * 2. **The context menu is a SECOND door per embed**, and the filed entry did
 *    not count it. Gating the hover cluster alone leaves the same `deleteNode()`
 *    one right-click away — confirmed live before the fix.
 * 3. **It is a POPULATION, not five sites.** The scan at the bottom fails when a
 *    new embed view appears without a row here, because a naming rule shipped
 *    partially is the #771 → #785 failure mode (four partial ships of one rule).
 *
 * ⚠️ **The context-menu components are mocked to render INLINE.** Radix mounts
 * `ContextMenuContent` only while the menu is open, so `queryByText('Remove from
 * Theme')` would be null in BOTH arms against the real component — a test that
 * passes for the wrong reason and would never fail if the gate were removed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import '@testing-library/jest-dom/vitest'

import { sourceFiles, srcRel } from '@/test-support/source-tree'

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, ...rest }: { children?: React.ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
}))

vi.mock('@/layouts/ProjectLayout', () => ({
  useProjectLayout: () => ({ projectId: 1 }),
}))

vi.mock('../InlineChartRenderer', () => ({
  default: () => <div data-testid="chart" />,
}))

vi.mock('@/lib/api', () => ({
  materialsApi: { listAllMaterials: vi.fn().mockResolvedValue([]) },
  metricsApi: { analysisColumns: vi.fn().mockResolvedValue({ datasets: [], domains: [], demographics: [] }) },
}))

// Rendered inline — see the ⚠️ note above. `ContextMenuItem` becomes a real
// button so its presence/absence is observable in both arms.
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onSelect }: { children?: React.ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  ContextMenuSeparator: () => <hr />,
}))

import type { NodeViewProps } from '@tiptap/core'
import ChartEmbedView from './ChartEmbedView'
import MemoEmbedView from './MemoEmbedView'
import CalloutStatView from './CalloutStatView'
import ExcerptEmbedView from './ExcerptEmbedView'
import ImageEmbedView from './ImageEmbedView'

/** Every embed node view, with the attrs it needs to render at all. */
const VIEWS: {
  name: string
  file: string
  Component: (props: NodeViewProps) => React.ReactElement | null
  attrs: Record<string, unknown>
  /** CalloutStatView deliberately has no context menu. */
  hasContextMenu: boolean
}[] = [
  {
    name: 'chart',
    file: 'ChartEmbedView.tsx',
    Component: ChartEmbedView as never,
    attrs: { materialId: 5, config: '{}', title: 'Score gain by school' },
    hasContextMenu: true,
  },
  {
    name: 'memo',
    file: 'MemoEmbedView.tsx',
    Component: MemoEmbedView as never,
    attrs: { numericId: 3, title: 'Field note', preview: 'A short memo.' },
    hasContextMenu: true,
  },
  {
    name: 'callout',
    file: 'CalloutStatView.tsx',
    Component: CalloutStatView as never,
    attrs: { value: '42%', label: 'agreed' },
    hasContextMenu: false,
  },
  {
    name: 'excerpt',
    file: 'ExcerptEmbedView.tsx',
    Component: ExcerptEmbedView as never,
    attrs: { displayText: 'They said it plainly.', sourceContext: 'Interview 3', conversationId: 2 },
    hasContextMenu: true,
  },
  {
    name: 'image',
    file: 'ImageEmbedView.tsx',
    Component: ImageEmbedView as never,
    attrs: { imageId: 7, alt: 'A chart', width: 100 },
    hasContextMenu: true,
  },
]

function mount(
  view: (typeof VIEWS)[number],
  opts: { editable: boolean; tag?: string | null },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // ONE cast to the real prop type: `NodeViewProps` carries a dozen fields
  // ProseMirror supplies at runtime, and spelling them out would be fabricating
  // a ProseMirror internal — the same reasoning as ChartEmbedView.test.tsx.
  const props = {
    node: { attrs: { ...view.attrs, materialTag: opts.tag ?? null, tagNote: null } },
    updateAttributes: vi.fn(),
    deleteNode: vi.fn(),
    selected: false,
    editor: { isEditable: opts.editable },
  } as unknown as NodeViewProps

  const { Component } = view
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Component {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('#893 — every embed view drops its mutation controls when the editor is read-only', () => {
  describe.each(VIEWS)('$name embed', (view) => {
    it('offers delete while the editor is editable', () => {
      mount(view, { editable: true })
      expect(screen.getByLabelText('Remove from canvas')).toBeInTheDocument()
      if (view.hasContextMenu) {
        expect(screen.getByText(/remove from theme/i)).toBeInTheDocument()
      }
    })

    it('renders NO delete control — neither door — when it is not', () => {
      mount(view, { editable: false })
      expect(screen.queryByLabelText('Remove from canvas')).toBeNull()
      // The second door. Without the inline mock above this would pass vacuously.
      expect(screen.queryByText(/remove from theme/i)).toBeNull()
    })

    it('drops the Add-tag affordance when read-only', () => {
      mount(view, { editable: false })
      expect(screen.queryByLabelText('Add tag')).toBeNull()
    })

    it('KEEPS an existing tag visible when read-only — it is content, not a control', () => {
      mount(view, { editable: false, tag: 'contradicts' })
      // Visible as text...
      expect(screen.getByText('contradicts')).toBeInTheDocument()
      // ...and not as something that offers to change it.
      expect(screen.queryByRole('button', { name: /tag/i })).toBeNull()
    })

    it('still offers the tag picker while editable', () => {
      mount(view, { editable: true, tag: 'confirms' })
      expect(screen.getByRole('button', { name: /Tag: confirms/i })).toBeInTheDocument()
    })
  })

  it('covers every embed view in the directory (population, not a list)', () => {
    // Walked through `sourceFiles()` — it carries the #730 population floor and
    // proves the tree is the app's `src/`, which a hand-rolled `readdirSync`
    // does not (#729; `source-tree.test.ts` fails the suite for one).
    const found = sourceFiles({
      ext: 'tsx',
      root: 'components/canvas/extensions',
      recursive: false,
      floor: 5,
      sentinels: ['components/canvas/extensions/ChartEmbedView.tsx'],
    })
      .map(srcRel)
      .map(p => p.split('/').pop() as string)
      .filter(f => /(Embed|Stat)View\.tsx$/.test(f))
      .sort()
    expect(found).toEqual(VIEWS.map(v => v.file).sort())
  })

  it('the fallback is EDITABLE, so a surface that supplies no editor is unaffected', () => {
    // `editor?.isEditable ?? true` — the writable canvas is the normal case and
    // must never lose its controls because a prop was missing.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const props = {
      node: { attrs: { ...VIEWS[2].attrs, materialTag: null, tagNote: null } },
      updateAttributes: vi.fn(),
      deleteNode: vi.fn(),
      selected: false,
    } as unknown as NodeViewProps
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}><CalloutStatView {...props} /></QueryClientProvider>
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Remove from canvas')).toBeInTheDocument()
  })
})
