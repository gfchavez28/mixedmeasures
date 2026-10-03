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
 * ones, #35 variant B the rating sweep) and the next mount must inherit the
 * rule without anyone remembering it. Self-checks: the mount count is asserted
 * non-empty, and the file list is derived, not typed.
 *
 * ⚠️ **A mount may key through `entryKey(...)` instead of a literal template**,
 * and that is a WIDENING made deliberately rather than a hole. The sweep's
 * target is a `(kind, id, code)` triple it must not re-derive at the mount —
 * `lib/rating-commit.ts` owns that identity, and a literal key there would be
 * a second derivation of the thing that module exists to single-source. The
 * contract the widening rests on is pinned separately, in
 * `lib/rating-commit.test.ts`: `entryKey` names the unit AND the code, a
 * segment and a dataset cell sharing an id do not collide, and one target
 * under two codes gives two keys. **Do not widen this further without a
 * contract test of the same shape.**
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
  it('finds the mounts it exists to check — four workbenches and the sweep', () => {
    const files = new Set(mounts().map(m => m.file))
    expect([...files].sort()).toEqual([
      'CodingWorkbench.tsx', 'DocumentCodingWorkbench.tsx', 'ObservationWorkbench.tsx',
      'RatingSweep.tsx', 'TextCodingView.tsx',
    ])
  })

  it('every mount carries a key built from the target unit AND the code', () => {
    for (const { file, tag } of mounts()) {
      expect(tag, `${file}: the strip must be keyed on its target`).toMatch(/\bkey=\{/)
      // A key through the shared derivation satisfies the rule on its own —
      // see the header note and `lib/rating-commit.test.ts`.
      if (/key=\{entryKey\(/.test(tag)) continue
      // Otherwise it must name both halves literally. The unit is a segment on
      // three surfaces and a dataset cell on the fourth; either name satisfies
      // the rule, a bare code key does not.
      expect(tag, `${file}: the key must name the unit`).toMatch(/segmentId|clipId|valueId/)
      expect(tag, `${file}: the key must name the code`).toMatch(/code\.id/)
    }
  })

  /**
   * #1112 — every WORKBENCH mount shows the live code and remounts on a new
   * scale. Each held `ratingTarget = { unit, code }` and read the scale from that
   * copy, so a scale saved while the strip was open never reached it (measured:
   * saved step 0.5, strip still on step 1). The sweep is exempt and says why:
   * its scale rides each queue entry, refreshed when the dialog's save
   * invalidates `['rating-queue', pid]`, and no scale can be edited from that page.
   */
  it('every workbench mount reads the LIVE code and keys on the scale signature (#1112)', () => {
    const workbench = mounts().filter(m => m.file !== 'RatingSweep.tsx')
    expect(workbench.length).toBe(4)
    for (const { file, tag } of workbench) {
      expect(tag, `${file}: the strip must not read the captured copy`).not.toMatch(/ratingTarget\.code\.(magnitude_scale|name)/)
      expect(tag, `${file}: the scale must come from the live code`).toMatch(/scale=\{ratingCode\.magnitude_scale\}/)
      expect(tag, `${file}: a new step must remount the strip`).toMatch(/key=\{`[^`]*\$\{scaleSignature\(ratingCode\.magnitude_scale\)\}`\}/)
      const src = stripComments(readFileSync(
        sourceFiles({ root: 'pages', ext: 'tsx', floor: 10, recursive: false }).find(f => basename(f) === file)!,
        'utf-8'), file)
      expect(src, `${file}: the live code comes from the shared helper`).toMatch(
        /const ratingCode = ratingTarget \? liveRatingCode\(ratingTarget\.code, codeMap\) : null/)
    }
  })

  it('the entryKey escape hatch is NARROW — only that call satisfies it', () => {
    // Falsifier: without this, widening the branch to any helper call would
    // pass silently and the rule would be gone rather than widened.
    const tag = '<MagnitudeStrip key={somethingElse(x)} />'
    expect(/key=\{entryKey\(/.test(tag)).toBe(false)
  })
})
