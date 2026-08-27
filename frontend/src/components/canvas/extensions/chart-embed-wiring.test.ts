import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { join } from 'node:path'

/**
 * The chart embed's integrity warnings are WIRED (#795).
 *
 * 🔴 **This file exists because "built" and "reached" are different claims, and
 * #795 is what the gap costs.** `InlineChartRenderer` declared `isStale?: boolean`
 * and rendered a "Data stale" indicator from it. Its only production consumer
 * passed four props and no spread, so the indicator could not render — and
 * `git log -S"isStale"` on that consumer is EMPTY: not a regression, never
 * connected, from the canvas rebuild that introduced it. The prop was OPTIONAL,
 * so nothing type-errored, nothing linted, and the component's own unit tests
 * passed it directly and proved only that the markup works.
 *
 * ⚠️ **A test that renders the component with the prop cannot catch this.** The
 * defect lives in the caller. So this scans the CALLER, and the sibling warning
 * that always worked (`missingRefs`) is the positive control — without it the
 * file would pass just as well against a component that renders neither.
 */

const SRC = join(__dirname, '..', '..', '..')

const read = (rel: string) => {
  const abs = join(SRC, rel)
  return stripComments(readFileSync(abs, 'utf8'), abs)
}

const EMBED = 'components/canvas/extensions/ChartEmbedView.tsx'
const RENDERER = 'components/canvas/InlineChartRenderer.tsx'

describe('the chart embed renders both integrity warnings', () => {
  const embed = read(EMBED)

  it('read real files (a scan that resolves to nothing passes by finding nothing)', () => {
    expect(embed.length).toBeGreaterThan(2_000)
    expect(read(RENDERER).length).toBeGreaterThan(10_000)
  })

  it('derives the stale-input warning and renders it', () => {
    expect(embed, 'the predicate must be called').toMatch(/staleComputedInputs\(/)
    expect(embed, 'and its result must reach the DOM').toMatch(/staleInputs\.length > 0/)
    expect(embed, 'and it must say which variable').toMatch(/describeStaleInputs\(/)
  })

  it('keeps the sibling warning that always fired', () => {
    // The positive control. `missingRefs` is the one integrity signal on this
    // surface that has ever rendered; if this scan can pass while that is gone,
    // it is not reading what it thinks it is.
    expect(embed).toMatch(/missingRefs && missingRefs\.length > 0/)
    expect(embed).toMatch(/describeMissingRefs\(/)
  })

  it('🔴 the never-passed props have NOT come back', () => {
    // The shape, not just the instance: an OPTIONAL prop that a caller must
    // remember is how this defect shipped and survived for the life of the
    // feature. The signal is derived where it is rendered now, so no caller can
    // forget it. `onRefresh` went with it — it was dead in the same way.
    const renderer = read(RENDERER)
    expect(renderer, 'isStale must not return as a prop').not.toMatch(/isStale\??:/)
    expect(renderer, 'onRefresh must not return as a prop').not.toMatch(/onRefresh\??:/)
  })

  it('warns only where a dataset column can actually go stale', () => {
    // A qualitative embed reads codes and sources, not dataset columns, so it
    // has nothing that can be stale — and firing a project-wide columns query
    // for it would be a request per embed for an answer that is always empty.
    expect(embed).toMatch(/isQualitativeMaterialConfig\(/)
    expect(embed).toMatch(/enabled:[^\n]*wantsColumns/)
  })
})
