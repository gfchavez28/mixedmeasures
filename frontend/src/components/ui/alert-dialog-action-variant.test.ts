/**
 * #1492 — no `<AlertDialogAction>` is handed `buttonVariants(…)` through its props.
 *
 * 🔴 **The trap is silent and it looks right in review.** `AlertDialogAction`
 * composes `cn(buttonVariants(), className)`, so a variant's classes handed in
 * through `className` are merged OVER the default variant. tailwind-merge resolves
 * the classes both sides set — the outline's `bg-background` wins over
 * `bg-primary` — but the outline, ghost and link variants set NO base text colour,
 * so the default's `text-primary-foreground` survives: white text on a near-white
 * button in light mode, the background colour on itself in dark. The quote dialog's
 * *Remove the quote and save* (#1319, new in 1.5.8) shipped to the rc that way.
 *
 * The wrapper takes a `variant` PROP now (composed in place of the default); this
 * scan refuses the old shape by what it IS — `buttonVariants(` inside an
 * `<AlertDialogAction …>` opening tag — wherever it appears. The population is ZERO
 * and stays zero: there is no allowlist.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { stripComments } from '@/lib/strip-comments'
import { SOURCE_SCAN_TIMEOUT_MS, sourceFiles, srcRel } from '@/test-support/source-tree'

/**
 * Each `<AlertDialogAction …>` opening tag, read to the first `>` OUTSIDE braces —
 * an attribute like `onClick={() => …}` holds a `>` that does not end the tag.
 */
function actionOpeningTags(src: string): string[] {
  const tags: string[] = []
  const open = /<AlertDialogAction(?![\w.])/g
  for (const m of src.matchAll(open)) {
    let depth = 0
    let i = m.index! + m[0].length
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }
    tags.push(src.slice(m.index!, i + 1))
  }
  return tags
}

const handsAVariantThroughProps = (tag: string) => /buttonVariants\s*\(/.test(tag)

describe('#1492 — AlertDialogAction takes its variant as a prop, never as classes', () => {
  it('the reader finds whole tags and the predicate flags only the trap (falsifier)', () => {
    const trap = `<AlertDialogAction
      className={keepable ? buttonVariants({ variant: 'outline' }) : undefined}
      onClick={() => onChoose('remove')}
    >Remove</AlertDialogAction>`
    const fixed = `<AlertDialogAction variant="outline" onClick={() => go()}>Remove</AlertDialogAction>`
    const red = `<AlertDialogAction className="bg-red-600 hover:bg-red-700 text-white">Delete</AlertDialogAction>`
    const [trapTag] = actionOpeningTags(trap)
    // Read past the `=>` inside the braces, to the tag's own `>`.
    expect(trapTag).toContain("onChoose('remove')")
    expect(handsAVariantThroughProps(trapTag)).toBe(true)
    expect(actionOpeningTags(fixed).map(handsAVariantThroughProps)).toEqual([false])
    expect(actionOpeningTags(red).map(handsAVariantThroughProps)).toEqual([false])
    // A longer component name is not this one.
    expect(actionOpeningTags('<AlertDialogActionGroup className={buttonVariants()}>')).toEqual([])
  })

  it('🔴 no AlertDialogAction anywhere in src is handed buttonVariants(…)', () => {
    let tags = 0
    const found: string[] = []
    // 295 `.tsx` files at 2026-10-29; the floor detects a narrower root, not growth.
    for (const abs of sourceFiles({ ext: 'tsx', floor: 250 })) {
      const src = stripComments(readFileSync(abs, 'utf8'), abs)
      for (const tag of actionOpeningTags(src)) {
        tags += 1
        if (handsAVariantThroughProps(tag)) found.push(srcRel(abs))
      }
    }
    // Population self-check: the scan reached the real call sites (26 at 2026-10-29).
    expect(tags).toBeGreaterThan(20)
    expect(
      found,
      'Pass the variant as a prop — `<AlertDialogAction variant="outline">` — never '
      + '`className={buttonVariants(...)}`, which keeps the default variant\'s text colour.',
    ).toEqual([])
  }, SOURCE_SCAN_TIMEOUT_MS)
})
