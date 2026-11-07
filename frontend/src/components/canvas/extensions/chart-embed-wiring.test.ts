import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { join } from 'node:path'
import { SOURCE_SCAN_TIMEOUT_MS, sourceFiles, srcRel } from '@/test-support/source-tree'

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

  it('#1323 D12: carries the fingerprint generation in all THREE places the HTML round-trip needs', () => {
    const node = read('components/canvas/extensions/chart-embed.ts')
    expect(node, 'addAttributes').toMatch(/figureEpoch:\s*\{ default: null \}/)
    expect(node, 'parseHTML').toMatch(/figureEpoch:\s*dom\.getAttribute\('data-figure-epoch'\)/)
    expect(node, 'renderHTML').toMatch(/'data-figure-epoch': HTMLAttributes\.figureEpoch/)
  })

  it('#1323 D12: the one insertion door places every chart embed under the current generation', () => {
    const editor = read('components/canvas/ThemeEditor.tsx')
    expect(editor).toMatch(
      /insertWithPendingSlash\('chart-embed', \{ \.\.\.attrs, figureEpoch: CURRENT_FIGURE_EPOCH \}\)/)
    // A POPULATION check over every source file: nothing but ThemeEditor creates a
    // chart-embed node. A second door that did not stamp the generation would make
    // its new embeds say their figures changed "in an update" the moment they render.
    // Only a file that names the node at all is comment-stripped (the whole-tree
    // strip is what costs seconds under full-suite load, #841/#867).
    const creates = /type:\s*['"]chart-embed['"]|nodes\[\s*['"]chart-embed['"]\s*\]|insertWithPendingSlash\(\s*['"]chart-embed['"]/
    const files = sourceFiles({
      ext: 'both',
      floor: 500,
      sentinels: ['components/canvas/ThemeEditor.tsx', 'pages/CanvasView.tsx'],
    })
    const doors = files
      .filter(abs => readFileSync(abs, 'utf8').includes('chart-embed'))
      .filter(abs => creates.test(stripComments(readFileSync(abs, 'utf8'), abs)))
      .map(srcRel)
    expect(doors).toEqual(['components/canvas/ThemeEditor.tsx'])
    expect(read('pages/CanvasView.tsx'), 'the call sites go through insertChart').toMatch(/\.insertChart\(\{/)
  }, SOURCE_SCAN_TIMEOUT_MS)

  it('warns only where a dataset column can actually go stale', () => {
    // A qualitative embed reads codes and sources, not dataset columns, so it
    // has nothing that can be stale — and firing a project-wide columns query
    // for it would be a request per embed for an answer that is always empty.
    expect(embed).toMatch(/isQualitativeMaterialConfig\(/)
    expect(embed).toMatch(/enabled:[^\n]*wantsColumns/)
  })
})
