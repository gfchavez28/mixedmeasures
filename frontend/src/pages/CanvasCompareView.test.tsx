/**
 * #848 / #849 — Canvas Compare must not attribute one theme's prose to another,
 * and must not state a diff it has not finished computing.
 *
 * **#848, reproduced live on the reported gesture (2026-08-27) before any fix.**
 * Snapshot a canvas, add a theme, then *Canvas snapshots → Compare snapshot with
 * current*. The added, empty theme rendered the FIRST theme's full prose under
 * its own heading, with the italic "No content" printed below it. An observer
 * installed before the app booted caught the two render states that cause it:
 *
 *   t=1233ms  4 cards  rightOnly = ALL FOUR current themes  ("New theme" = ro-3, EMPTY — correct)
 *   t=1352ms  7 cards  rightOnly = ["New theme"]            ("New theme" = ro-0, borrowed prose)
 *
 * `ro-0` was "Assessment Outcomes" in the first state and "New theme" in the
 * second. Same key, same position ⇒ React REUSES the instance; `name` is a prop
 * and updates, while `useEditor` binds `content` once at creation and never
 * re-reads it. The heading moves, the prose does not.
 *
 * 🔴 **Two claims in the filed entry are REFUTED and must not be re-derived.**
 * (1) It is NOT a swap from the non-diff branch to the diff branch: `diff` is
 * non-null from the very first render, because `matchThemes([], right)` is a
 * perfectly valid result meaning "everything is new". The collision is WITHIN
 * the `ro-*` list. (2) A hard reload does NOT render correctly — measured twice.
 * It is a race on which query resolves first, and the canvas wins on both paths,
 * so the defect is reachable from a plain page load too.
 *
 * ⚠️ **Why the mock replicates bind-once.** `useEditor`'s real semantics ARE the
 * defect's other half, so a mock that re-reads `content` on every render would
 * make this suite pass against the broken component. The fake below stores the
 * content it was constructed with and only rebuilds when its `deps` change —
 * exactly what Tiptap does.
 *
 * ⚠️ **The resolution gate MASKS the key defect**, which is why the key test
 * drives a change AFTER both queries have settled. A test that only exercised
 * the initial load would pass with index keys restored, and would be pinning the
 * gate while claiming to pin the keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

// ── Tiptap stand-in with the real bind-once semantics ───────────────────────
/** Every editor construction, in order — the observable side of key stability. */
const editorBuilds: string[] = []

vi.mock('@tiptap/react', async () => {
  // `await import` rather than `require`: the factory is hoisted above the
  // imports, so it cannot close over a top-level binding, and `require` is
  // banned by lint.
  const React = await import('react')
  return {
    useEditor: (options: { content?: unknown }, deps?: unknown[]) => {
      // `useMemo` keyed on deps reproduces `useEditor`: the content is captured
      // when the editor is built and is not re-read until deps change. With no
      // deps (`undefined`), it is captured once for the instance's whole life.
      // This is a STAND-IN for `useEditor`, and non-reactive deps are exactly the
      // semantics it exists to reproduce: content captured at construction and
      // re-read only when the caller's own deps move. Making it reactive would
      // defeat the test. ⚠️ The directive goes on the line above the DEPS
      // ARGUMENT — that is where the rule reports, not the `useMemo` call — and
      // any prose between the two orphans it, which
      // `--report-unused-disable-directives` then reports in its own right.
      return React.useMemo(
        () => {
          editorBuilds.push(extractText(options.content) || '(empty)')
          return { __content: options.content ?? null }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        deps ?? [],
      )
    },
    EditorContent: ({ editor }: { editor: { __content: unknown } | null }) => {
      const text = extractText(editor?.__content)
      return React.createElement('div', { className: 'ProseMirror' }, text)
    },
  }
})

function extractText(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return ''
  const node = doc as { text?: string; content?: unknown[] }
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(extractText).join('')
}

vi.mock('@/lib/api', () => ({
  canvasApi: { get: vi.fn(), getSnapshot: vi.fn() },
}))

vi.mock('@/layouts/ProjectLayout', () => ({ useProjectLayout: () => ({ projectId: 2 }) }))

vi.mock('@/components/canvas/extensions', () => ({
  ExcerptEmbed: {}, ChartEmbed: {}, MemoEmbed: {}, CalloutStat: {}, ImageEmbed: {},
}))

import { canvasApi } from '@/lib/api'
import CanvasCompareView from './CanvasCompareView'

const prose = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

function theme(id: number, name: string, text: string | null, doc_order: number) {
  return {
    id, name, section_type: 'theme' as const, description: null, color: null,
    doc_order, viz_x: null, viz_y: null,
    content: text === null ? null : prose(text),
    searchable_text: null, referenced_source_ids: null, parent_theme_id: null,
    relationships_out: [],
  }
}

// The live fixture: three themes snapshotted, a fourth added afterwards.
const ASSESSMENT = theme(4, 'Assessment Outcomes', 'Post-test scores differed significantly.', 100)
const BARRIERS = theme(5, 'Implementation Barriers', 'Low-gain focus groups converge.', 200)
const TRAINING = theme(6, 'The Training Gap', 'The guide specifies 24 hours.', 300)
const ADDED = theme(15, 'New theme', null, 400)

const SNAPSHOT = {
  id: 1, name: 'Before', created_at: '2026-08-27T00:00:00+00:00', theme_count: 3,
  snapshot_data: {
    format_version: 1,
    themes: [ASSESSMENT, BARRIERS, TRAINING].map(t => ({
      ...t, content: t.content ? JSON.stringify(t.content) : null, referenced_source_ids: null,
    })),
    relationships: [],
    pending_items: [],
  },
}

function renderCompare(search: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/compare${search}`]}>
        <CanvasCompareView />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return qc
}

/** The last element — `.at()` is not in this tsconfig's lib target. */
function last<T>(xs: T[]): T | undefined { return xs[xs.length - 1] }

/** Each rendered card as `heading → prose`. */
function cards() {
  return Array.from(document.querySelectorAll('div.mb-6.pl-3')).map(c => ({
    heading: c.querySelector('h3')?.textContent ?? '',
    prose: c.querySelector('.ProseMirror')?.textContent ?? '',
  }))
}

/** What each theme's OWN prose is — asserted explicitly, never derived. */
const OWN_PROSE: Record<string, string> = {
  'Assessment Outcomes': 'Post-test scores differed significantly.',
  'Implementation Barriers': 'Low-gain focus groups converge.',
  'The Training Gap': 'The guide specifies 24 hours.',
  'New theme': '',
}

beforeEach(() => { vi.clearAllMocks(); editorBuilds.length = 0 })

describe('#848 — prose belongs to the theme whose heading it sits under', () => {
  // ⚠️ Both tests drive a change AFTER the queries settle. The #849 resolution
  // gate hides the initial transition, so a load-time-only test pins the GATE
  // while claiming to pin these — it passes with index keys restored.
  //
  // ⚠️ And each test has to differ on the EXACT axis its fix generalises. The
  // first draft of this file shifted only the `matched` list and changed no
  // theme's content, so reverting `ro-*` to an index key and deleting the
  // editor's content deps BOTH survived — the fixture was rich and degenerate.

  it('keys the MATCHED list on identity, not position', async () => {
    vi.mocked(canvasApi.getSnapshot).mockResolvedValue(SNAPSHOT as never)
    vi.mocked(canvasApi.get).mockResolvedValue({
      id: 2, name: 'C', themes: [ASSESSMENT, BARRIERS, TRAINING, ADDED],
    } as never)

    const qc = renderCompare('?canvas=2&snapshot=1')
    await waitFor(() => expect(cards()).toHaveLength(7))
    expect(cards()[6]).toEqual({ heading: 'New theme', prose: '' })

    // Drop the FIRST theme: `matched` goes 3 → 2, so under index keys `m-r-0`
    // was "Assessment Outcomes" and becomes "Implementation Barriers".
    vi.mocked(canvasApi.get).mockResolvedValue({
      id: 2, name: 'C', themes: [BARRIERS, TRAINING, ADDED],
    } as never)
    await act(async () => { await qc.refetchQueries({ queryKey: ['canvas', 2, 2] }) })

    await waitFor(() => expect(last(cards())?.heading).toBe('New theme'))
    for (const card of cards()) {
      expect(card.prose, `"${card.heading}" is showing another theme's prose`)
        .toBe(OWN_PROSE[card.heading])
    }
  })

  it('keys the ADDED-ONLY list on identity, not position', async () => {
    // The `ro-*` list is the one the live defect collided, so it needs its own
    // membership shift — the matched-list test above cannot reach it.
    const ADDED_A = theme(15, 'First addition', 'Prose belonging to the first addition.', 400)
    const ADDED_B = theme(16, 'Second addition', 'Prose belonging to the second addition.', 500)
    vi.mocked(canvasApi.getSnapshot).mockResolvedValue(SNAPSHOT as never)
    vi.mocked(canvasApi.get).mockResolvedValue({
      id: 2, name: 'C', themes: [ASSESSMENT, BARRIERS, TRAINING, ADDED_A, ADDED_B],
    } as never)

    const qc = renderCompare('?canvas=2&snapshot=1')
    await waitFor(() => expect(cards()).toHaveLength(8))

    // Remove the FIRST addition: `rightOnly` goes [A, B] → [B], so under index
    // keys `ro-0` was A and becomes B.
    vi.mocked(canvasApi.get).mockResolvedValue({
      id: 2, name: 'C', themes: [ASSESSMENT, BARRIERS, TRAINING, ADDED_B],
    } as never)
    await act(async () => { await qc.refetchQueries({ queryKey: ['canvas', 2, 2] }) })

    await waitFor(() => expect(last(cards())?.heading).toBe('Second addition'))
    expect(
      last(cards())?.prose,
      'the surviving addition is showing the removed one’s prose',
    ).toBe('Prose belonging to the second addition.')
  })

  // ⚠️ NO REBUILD-COUNT TEST HERE, and the absence is deliberate.
  //
  // 🔴 **MEASURED: the stable keys are NOT what fixes this defect.** With
  // `recreateOnContentChange` in place, reverting EVERY key to an index —
  // `ro-*`, `m-r-*`, `m-l-*` — leaves all six tests in this file green, because
  // the editor rebuilds on a content change whatever its instance identity.
  // The keys are idiomatic React and defence-in-depth for any future per-card
  // instance state; they are not load-bearing today, and nothing here pretends
  // otherwise. **The editor's content deps are the fix** (mutant B, caught).
  //
  // An attempt to make the keys observable by counting editor constructions was
  // written and DELETED: an untouched card rebuilt anyway under the fixed code,
  // so the test failed while the component was correct. Shipping it would have
  // pinned a property the component does not have. The accepted cost is that a
  // refetch may rebuild read-only editors it did not need to — rare on this
  // screen, and strictly better than showing the wrong prose.

  it('follows a theme whose PROSE changed under an unchanged id', async () => {
    // The class stable keys alone leave open: same key, same instance, new
    // content. `useEditor` binds content once, so without the editor's content
    // deps this renders the old prose under the right heading indefinitely.
    vi.mocked(canvasApi.getSnapshot).mockResolvedValue(SNAPSHOT as never)
    vi.mocked(canvasApi.get).mockResolvedValue({
      id: 2, name: 'C', themes: [ASSESSMENT, BARRIERS, TRAINING],
    } as never)

    const qc = renderCompare('?canvas=2&snapshot=1')
    await waitFor(() => expect(cards()).toHaveLength(6))

    const REVISED = theme(5, 'Implementation Barriers', 'Rewritten after a second reading.', 200)
    vi.mocked(canvasApi.get).mockResolvedValue({
      id: 2, name: 'C', themes: [ASSESSMENT, REVISED, TRAINING],
    } as never)
    await act(async () => { await qc.refetchQueries({ queryKey: ['canvas', 2, 2] }) })

    await waitFor(() => {
      const card = cards().slice(3).find(c => c.heading === 'Implementation Barriers')
      expect(card?.prose, 'the editor is still showing the pre-edit prose').toBe(
        'Rewritten after a second reading.',
      )
    })
  })
})

describe('#849 — the comparison never states something it has not established', () => {
  it('holds the diff until both sides have resolved', async () => {
    let releaseSnapshot: (v: unknown) => void = () => {}
    vi.mocked(canvasApi.get).mockResolvedValue({
      id: 2, name: 'C', themes: [ASSESSMENT, BARRIERS, TRAINING, ADDED],
    } as never)
    vi.mocked(canvasApi.getSnapshot).mockReturnValue(
      new Promise(res => { releaseSnapshot = res }) as never,
    )

    renderCompare('?canvas=2&snapshot=1')

    // 🔴 The canvas resolves first (it does on every path measured). Before the
    // gate this rendered all four current themes as "added" — a confident,
    // wrong diff — and that intermediate state is what collided the keys.
    await waitFor(() => expect(screen.getByText('Loading comparison…')).toBeInTheDocument())
    expect(cards()).toHaveLength(0)

    await act(async () => { releaseSnapshot(SNAPSHOT); await Promise.resolve() })
    await waitFor(() => expect(cards()).toHaveLength(7))
  })

  it('says a rotated-out snapshot is gone instead of reporting an empty one', async () => {
    vi.mocked(canvasApi.get).mockResolvedValue({
      id: 2, name: 'C', themes: [ASSESSMENT, BARRIERS, TRAINING],
    } as never)
    vi.mocked(canvasApi.getSnapshot).mockRejectedValue(new Error('404'))

    renderCompare('?canvas=2&snapshot=999')

    await waitFor(() =>
      expect(screen.getByText('This snapshot is no longer available')).toBeInTheDocument(),
    )
    // The old render: "No themes" on the left beside the full current canvas,
    // which reads as "the snapshot was empty; you added all of this since".
    expect(screen.queryByText('No themes')).not.toBeInTheDocument()
    expect(cards()).toHaveLength(0)
    // It must not be colour-only, and it must offer the way back. TWO controls
    // share that name by design — the header's icon button and the body CTA —
    // so this asserts the CTA exists rather than uniqueness.
    expect(screen.getAllByRole('button', { name: 'Back to canvas' })).toHaveLength(2)
    expect(screen.getByText(/ten most recent snapshots/)).toBeInTheDocument()
  })

  it('names a missing CANVAS differently — the remedies are not the same', async () => {
    vi.mocked(canvasApi.get).mockRejectedValue(new Error('404'))
    vi.mocked(canvasApi.getSnapshot).mockResolvedValue(SNAPSHOT as never)

    renderCompare('?canvas=2&snapshot=1')

    await waitFor(() =>
      expect(screen.getByText('This canvas is no longer available')).toBeInTheDocument(),
    )
  })
})

describe('#850 — the diff has to COMMUNICATE, not just render the right content', () => {
  /**
   * The page rendered the right themes and told you almost nothing about what
   * changed, which is the only reason to open it. All four arms below were
   * confirmed against source before the fix; (b) and (d) had no code path at
   * all, so they could not be caught by driving either.
   */
  // `theme()`'s inferred type pins `referenced_source_ids` to null, so the
  // widening is explicit rather than a cast at every call site.
  const withMaterials = (t: ReturnType<typeof theme>, refs: { type: string; id: number }[]) =>
    ({ ...t, referenced_source_ids: refs }) as unknown as ReturnType<typeof theme>

  async function renderMatched(rightThemes: ReturnType<typeof theme>[]) {
    vi.mocked(canvasApi.getSnapshot).mockResolvedValue(SNAPSHOT as never)
    vi.mocked(canvasApi.get).mockResolvedValue({
      id: 2, name: 'C', themes: rightThemes,
    } as never)
    renderCompare('?canvas=2&snapshot=1')
    await waitFor(() => expect(cards().length).toBeGreaterThan(0))
  }

  it('🔴 (d) states the material delta ONCE, on the side it is true of', async () => {
    // Both panes rendered the SAME string from the same call, and the left one
    // captioned it "Snapshot: ". `added` counts present-in-RIGHT, so the
    // snapshot's own pane claimed a gain belonging to the current state.
    const ASSESSMENT_PLUS = withMaterials(ASSESSMENT, [
      { type: 'material', id: 1 },
      { type: 'material', id: 2 },
    ])
    await renderMatched([ASSESSMENT_PLUS, BARRIERS, TRAINING])

    const body = document.body.textContent ?? ''
    expect(body).toContain('2 materials added since the snapshot')
    // The old wording is the assertion that would have caught it.
    expect(body).not.toContain('Snapshot: +2 materials')
    // ...and exactly once, because one delta is one fact about a PAIR.
    expect(body.split('2 materials added since').length - 1).toBe(1)
  })

  /**
   * ⚠️ Scoped to the CARDS, never `document.body`.
   *
   * 🔴 The legend added by (c) contains the words "Text changed", so a
   * body-wide assertion passes whether or not a single card is ever marked —
   * both the positive AND the negative form. The first draft of these two tests
   * did exactly that, and the negative one is what exposed it. Assert in the
   * channel the property actually lives in.
   */
  const markedCards = () =>
    Array.from(document.querySelectorAll('div.mb-6.pl-3'))
      .filter(c => (c.textContent ?? '').includes('Text changed'))
      .map(c => c.querySelector('h3')?.textContent ?? '')

  it('🔴 (b) marks a matched theme whose TEXT changed', async () => {
    // `diff.matched` rendered with `diffClass` undefined on BOTH panes, so only
    // wholly added or removed themes were marked — and "what did I write since?"
    // is the question this page exists for.
    const EDITED = { ...ASSESSMENT, content: prose('Post-test scores were rewritten entirely.') }
    await renderMatched([EDITED, BARRIERS, TRAINING])

    // Both sides of the pair are marked — the reader is looking at one of them.
    expect(markedCards()).toEqual(['Assessment Outcomes', 'Assessment Outcomes'])
  })

  it('🔴 (b) does NOT mark a matched theme whose text is identical', async () => {
    // The discrimination assertion, and it earned its place twice: it caught
    // the marker firing on EVERY row, because a snapshot serialises `content`
    // to a JSON string while the live canvas carries the parsed object.
    await renderMatched([ASSESSMENT, BARRIERS, TRAINING])

    expect(markedCards()).toEqual([])
  })

  it('🔴 (c) pairs every colour with a WORD, and renders a key', async () => {
    // Added/removed were border colour alone with no legend anywhere on the
    // page. The relationship-diff footer had labelled its lists all along.
    await renderMatched([ASSESSMENT, BARRIERS, TRAINING, ADDED])

    const body = document.body.textContent ?? ''
    expect(body).toContain('What the marks mean:')
    expect(body).toContain('Added since')
  })

  it('🔴 (a) names both panes and both read-only editors', async () => {
    await renderMatched([ASSESSMENT, BARRIERS, TRAINING])

    // Two panes, each named by its own heading.
    expect(screen.getByRole('region', { name: /Snapshot: Before/ })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /Current state/ })).toBeInTheDocument()
    // The page had no h1/h2 at all — only theme h3s, rendered twice.
    expect(document.querySelectorAll('h1').length).toBe(2)
  })

  describe('🔴 #865 — the key appears only where the marks can', () => {
    /**
     * `diff` is null unless the comparison is against a SNAPSHOT, so a
     * canvas-vs-canvas view renders plain, unmarked themes — under a key
     * explaining three marks that cannot occur. Same wrong-information shape as
     * (d)'s mislabelled delta, one element up the page.
     */
    const legendText = () => {
      const label = screen.queryByText('What the marks mean:')
      return label?.parentElement?.textContent ?? null
    }

    it('renders NO key in side-by-side mode, where nothing is ever marked', async () => {
      vi.mocked(canvasApi.get).mockResolvedValue({
        id: 2, name: 'Canvas A', themes: [ASSESSMENT, BARRIERS],
      } as never)
      renderCompare('?canvas=2&canvas2=3')
      await waitFor(() => expect(cards().length).toBeGreaterThan(0))

      expect(legendText()).toBeNull()
      // ...and the reason: no card carries a mark either.
      expect(markedCards()).toEqual([])
    })

    it('still renders it in snapshot mode — the positive control', async () => {
      // Without this, "delete the legend" passes the test above.
      await renderMatched([ASSESSMENT, BARRIERS, TRAINING, ADDED])
      expect(legendText()).toContain('What the marks mean:')
    })

    it('🔴 says the SAME words on the key and on the card it explains', async () => {
      // The key said "Only in Current state" while the card it describes was
      // stamped "Added since" — two vocabularies for one mark, matched up by
      // colour. One object owns both now.
      await renderMatched([ASSESSMENT, BARRIERS, TRAINING, ADDED])

      const addedCard = Array.from(document.querySelectorAll('div.mb-6.pl-3'))
        .find(c => c.querySelector('h3')?.textContent === 'New theme')
      const badge = addedCard?.querySelector('span.uppercase')?.textContent?.trim()

      expect(badge).toBe('Added since the snapshot')
      expect(legendText()).toContain(badge)
    })

    it('no badge is a dangling phrase — every mark ends in a noun', async () => {
      // "Added since" and "Text changed since" both stopped mid-sentence.
      await renderMatched([
        { ...ASSESSMENT, content: prose('Rewritten.') }, BARRIERS, TRAINING, ADDED,
      ])
      const badges = Array.from(document.querySelectorAll('div.mb-6.pl-3 span.uppercase'))
        .map(b => (b.textContent ?? '').trim())

      expect(badges.length).toBeGreaterThan(0)
      for (const b of badges) expect(b).not.toMatch(/\bsince$/i)
    })
  })
})
