/**
 * Every mount of `MagnitudeStrip` is KEYED on its target (#870 c).
 *
 * The strip initialises its cursor and its focus effect once. Mounted without a
 * `key`, a target swap on a live mount (click code A in the panel, then code B)
 * kept the old cursor and left focus on the button that was clicked — and the
 * next digit then went to the window chord layer. A `key` on
 * `(segmentId, codeId)` makes the swap a remount.
 *
 * A POPULATION scan, because the strip is mounted on more than one workbench
 * now (#868 b added the document one; #868 c/d the observation and text-coding
 * ones) and the next mount must inherit the rule without anyone remembering it.
 * Self-checks: the mount count is asserted non-empty, and the file list is
 * derived, not typed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { sourceFiles } from '@/test-support/source-tree'

function mounts(): { file: string; tag: string }[] {
  const out: { file: string; tag: string }[] = []
  // The pages directory, one level, `.tsx` only — a mount is JSX. The walk and
  // its floor live in `sourceFiles()` (#729/#730).
  for (const abs of sourceFiles({ root: 'pages', ext: 'tsx', floor: 10, recursive: false })) {
    const name = basename(abs)
    const src = stripComments(readFileSync(abs, 'utf-8'), name)
    const re = /<MagnitudeStrip\b[\s\S]*?\/>/g
    for (const m of src.matchAll(re)) out.push({ file: name, tag: m[0] })
  }
  return out
}

describe('MagnitudeStrip mounts (#870 c)', () => {
  it('finds the mounts it exists to check — all four coding surfaces', () => {
    const files = new Set(mounts().map(m => m.file))
    expect([...files].sort()).toEqual([
      'CodingWorkbench.tsx', 'DocumentCodingWorkbench.tsx', 'ObservationWorkbench.tsx', 'TextCodingView.tsx',
    ])
  })

  it('every mount carries a key built from the target unit AND the code', () => {
    for (const { file, tag } of mounts()) {
      expect(tag, `${file}: the strip must be keyed on its target`).toMatch(/\bkey=\{/)
      // The unit is a segment on three surfaces and a dataset cell on the
      // fourth; either name satisfies the rule, a bare code key does not.
      expect(tag, `${file}: the key must name the unit`).toMatch(/segmentId|clipId|valueId/)
      expect(tag, `${file}: the key must name the code`).toMatch(/code\.id/)
    }
  })
})
