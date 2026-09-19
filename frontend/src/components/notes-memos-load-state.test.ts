/**
 * #963 Tier 2 — the notes and memos panels are ONE shape, and this scan is a
 * POPULATION assertion over all five of them.
 *
 * They were filed across two lists: `AllNotesPanel` and `MemosPanelContent` in
 * Tier 2, `MemoPanel` / `NotesPanel` / `TextNotesPanel` under Tier 1's low-harm
 * adds. That split is an artefact of where the sweep happened to look — every
 * one of them renders "no notes / no memos" from `data?.x ?? []`, so fixing the
 * two that were filed together is exactly how #771 shipped partially four times.
 *
 * ⚠️ **Stated residual: a scan cannot see what a branch RENDERS.** It proves a
 * `ListLoad` is derived from the panel's own query and that the empty claim sits
 * behind a readiness test on THAT load — not that a notice appears, and not that
 * the words are right. `AllNotesPanel.test.tsx` renders the three states, which
 * is the evidence; this file is what stops the other four drifting back.
 *
 * ⚠️ `MemosPanelContent`, `NotesPanel` and `TextNotesPanel` have no render
 * harness in this suite. Where a surface CAN be rendered, render it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'

interface Panel {
  file: string
  /** Real source that must survive stripping — the #814 self-check per file. */
  sentinel: string
  /** The `ListLoad` the claim rests on. */
  load: string
  /** The exact readiness expression guarding the claim. Named per panel rather
   *  than pattern-guessed: the first draft of this scan built `notesLoadKnown`
   *  from the load's name and failed against two correct files, which is a scan
   *  reporting its own regex as a defect. */
  ready: string
  /** The words only an answered list may say. */
  claim: string
}

const PANELS: Panel[] = [
  {
    file: 'components/AllNotesPanel.tsx',
    sentinel: "const totalCount = useMemo(",
    load: 'notesLoad',
    ready: 'notesKnown',
    claim: 'No notes yet',
  },
  {
    file: 'components/MemosPanelContent.tsx',
    sentinel: "queryKey: ['memos', projectId, showArchived]",
    load: 'memosLoad',
    ready: 'memosKnown',
    claim: 'No memos yet',
  },
  {
    file: 'components/MemoPanel.tsx',
    sentinel: "queryKey: ['memos', projectId, filterMode",
    load: 'memosLoad',
    ready: "memosLoad.status !== 'ready'",
    claim: 'No memos yet. Add one above.',
  },
  {
    file: 'components/NotesPanel.tsx',
    sentinel: "queryKey: ['notes', conversationId]",
    load: 'notesLoad',
    ready: "notesLoad.status !== 'ready'",
    claim: 'No notes yet. Add one above.',
  },
  {
    file: 'components/TextNotesPanel.tsx',
    sentinel: "queryKey: ['text-notes', projectId, columnIdsStr]",
    load: 'notesLoad',
    ready: "notesLoad.status !== 'ready'",
    claim: 'No notes yet',
  },
]

const sources = new Map(
  PANELS.map(p => [
    p.file,
    stripComments(readFileSync(join(SRC_DIR, p.file), 'utf8'), p.file.split('/').pop()),
  ]),
)

describe('#963 — every notes/memos panel waits for its own list', () => {
  it('scans the whole population, not the two that were filed together', () => {
    expect(PANELS).toHaveLength(5)
  })

  for (const p of PANELS) {
    describe(p.file, () => {
      const src = () => sources.get(p.file)!

      it('can still see the code it is scanning', () => {
        // Per file: a stripper that blanked one would otherwise hide behind the
        // other four's assertions.
        expect(src()).toContain(p.sentinel)
        expect(src().length).toBeGreaterThan(2_000)
      })

      it('derives a ListLoad from a query object, not from a destructured array', () => {
        expect(src()).toMatch(new RegExp(`const\\s+${p.load}\\s*=\\s*useListLoad\\(`))
        // `const { data: xs = [] }` is a FRESH array on every render, and it is
        // also the shape that cannot be asked whether it is an answer.
        expect(src()).not.toMatch(/const\s*\{\s*data:\s*\w+\s*=\s*\[\]\s*\}/)
      })

      it('says its empty claim only behind a readiness test on that load', () => {
        const at = src().indexOf(p.claim)
        expect(at).toBeGreaterThan(-1)
        const before = src().slice(Math.max(0, at - 3_000), at)
        expect(before).toContain(p.ready)
      })

      it('renders the shared notice rather than hand-writing another "Loading…"', () => {
        // §2: one wording and one slow-load delay, or they drift apart.
        expect(src()).toContain('<LoadState')
      })
    })
  }

  it('the readiness predicate is falsifiable', () => {
    const fake = "{somethingElse.length === 0 ? <p>No notes yet</p> : null}"
    for (const p of PANELS) expect(fake).not.toContain(p.ready)
  })

  it('no panel keeps a bare spinner as its loading state', () => {
    // Two of the five had `<LoaderCircle className="h-5 w-5 animate-spin" />`
    // alone in the list region: no role, no text, nothing for a reader.
    for (const p of PANELS) {
      expect(sources.get(p.file)!).not.toMatch(/<LoaderCircle className="h-5 w-5 animate-spin[^"]*" \/>/)
    }
  })
})
