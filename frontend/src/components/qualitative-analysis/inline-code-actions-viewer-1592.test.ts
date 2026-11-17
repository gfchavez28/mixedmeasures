/**
 * #1592 — every mount of `InlineCodeActions` says whose chips may offer *Remove code*, and HOW
 * it knows, and the choice is DECIDED here, both ways.
 *
 * The `viewer` prop is REQUIRED, so the compiler already makes a new mount choose. What it cannot
 * see is whether the mount gave the chips a CODER to compare: a per-application mount passes
 * `appliedCodeDetails` (one chip per (code, coder)); a distinct-code mount (By Source, By Code,
 * the Quote Board) passes `viewer.applications`. A mount that passes neither offers no remove at
 * all — the viewer's own coding included — and nothing on screen would say why. So the table
 * below holds each file's mounts and their kind; a new mount, a moved one or a changed choice
 * fails until someone decides. Self-checks: the population is derived from the tree (never
 * typed), the table and the tree are compared both ways, and the predicate is exercised on
 * planted tags.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { sourceFiles, srcRel, SOURCE_SCAN_TIMEOUT_MS } from '@/test-support/source-tree'

type Kind = 'per-application' | 'distinct'

/** file → the kind of each mount, in source order. */
const DECIDED: Record<string, Kind[]> = {
  // The three workbenches and the Reconciliation grid's own cell: one chip per application.
  'components/SegmentRow.tsx': ['per-application'],
  'pages/DocumentCodingWorkbench.tsx': ['per-application'],
  'pages/ObservationWorkbench.tsx': ['per-application'],
  'components/qualitative-analysis/ReconciliationGrid.tsx': ['per-application'],
  // Distinct codes, each payload naming who applied each code (`applications`): By Source's
  // four readers, By Code's four lists, the Quote Board's card.
  'components/qualitative-analysis/ContentBySource.tsx': ['distinct', 'distinct', 'distinct', 'distinct'],
  'components/qualitative-analysis/ContentByCode.tsx': ['distinct', 'distinct', 'distinct', 'distinct'],
  'components/qualitative-analysis/QuoteCard.tsx': ['distinct'],
}

const TAG = /<InlineCodeActions\b[\s\S]*?\/>/g

/** What one mount tag decided, or null when its chips have no coder to compare. */
function mountKind(tag: string): Kind | null {
  if (!/\bviewer=\{\{\s*coderId:/.test(tag)) return null
  if (/\bviewer=\{\{[^}]*\bapplications:/.test(tag)) return 'distinct'
  if (/\bappliedCodeDetails=\{/.test(tag)) return 'per-application'
  return null
}

let found: { file: string; tag: string }[] | null = null
function mounts(): { file: string; tag: string }[] {
  if (found) return found
  const out: { file: string; tag: string }[] = []
  // The whole app tree, `.tsx` only (a mount is JSX); 297 such files on 2026-11-08.
  for (const abs of sourceFiles({ ext: 'tsx', floor: 250 })) {
    const raw = readFileSync(abs, 'utf-8')
    if (!raw.includes('<InlineCodeActions')) continue
    for (const m of stripComments(raw, abs).matchAll(TAG)) out.push({ file: srcRel(abs), tag: m[0] })
  }
  found = out
  return out
}

describe('InlineCodeActions mounts decide whose chips may be removed (#1592)', () => {
  it('the mounts in the tree are exactly the decided table, file by file and in number', () => {
    const byFile: Record<string, number> = {}
    for (const { file } of mounts()) byFile[file] = (byFile[file] ?? 0) + 1
    const decided = Object.fromEntries(Object.entries(DECIDED).map(([f, k]) => [f, k.length]))
    expect(byFile).toEqual(decided)
  }, SOURCE_SCAN_TIMEOUT_MS)

  it('each mount gives its chips a coder to compare, in the decided way', () => {
    const seen: Record<string, Kind[]> = {}
    for (const { file, tag } of mounts()) {
      const kind = mountKind(tag)
      expect(kind, `${file}: a mount whose chips name no coder (no remove would ever show):\n${tag}`).not.toBeNull()
      ;(seen[file] ??= []).push(kind!)
    }
    expect(seen).toEqual(DECIDED)
  }, SOURCE_SCAN_TIMEOUT_MS)

  it('the predicate reads each form, and reads nothing from a mount that names no coder (falsifier)', () => {
    expect(mountKind('<InlineCodeActions viewer={{ coderId: me, applications: s.applied_code_details }} />')).toBe('distinct')
    expect(mountKind('<InlineCodeActions appliedCodeDetails={d} viewer={{ coderId: me }} />')).toBe('per-application')
    // A viewer with neither: the chips cannot be told apart — the shape this scan exists to fail.
    expect(mountKind('<InlineCodeActions viewer={{ coderId: me }} />')).toBeNull()
    expect(mountKind('<InlineCodeActions projectId={1} />')).toBeNull()
  })
})
