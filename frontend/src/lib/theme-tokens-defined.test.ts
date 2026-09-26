/**
 * Every `mm-*` colour utility names a token `index.css` actually defines (#1001).
 *
 * 🔴 **An undefined theme utility is SILENT.** Tailwind v4 generates a colour
 * utility only when `--color-<name>` exists; for any other name it emits NOTHING
 * — no warning, no build error, and lint's palette ban (#481) looks only at the
 * raw palettes. The element then renders with whatever it inherits, which often
 * LOOKS right: every border falls back to `* { @apply border-border }`, so a
 * `border-mm-border` is indistinguishable from a correct one.
 *
 * It is not always harmless. Queue row 49 shipped `bg-mm-amber-bg` /
 * `border-mm-amber-border` / `text-mm-amber-text` on the coding import's
 * "nothing matched" alert and the machine-coder lock notice — three names that
 * sound like tokens, none defined — so both warnings rendered as ordinary text
 * on an ordinary card (measured in Chrome: no rule for any of the three).
 *
 * **What an undefined name falls back to depends on the UTILITY, and only the
 * border case is benign:** a BORDER takes `border-border`; a BACKGROUND takes
 * nothing (transparent — the Data view's toolbar separators, canvas dots and an
 * image-embed resize handle were invisible); a TEXT colour is inherited (an import
 * error and an over-the-limit refusal rendered in body colour, not red); a RING or
 * OUTLINE takes `currentColor` (focus rings in the text colour instead of the
 * house green, and a `/30` selection ring at full strength). The analysis views'
 * ACTIVE-TAB underline fell back to the same grey as the hover underline.
 *
 * 🔴 **THE POPULATION IS ZERO and must stay zero.** At the guard's birth it was 70
 * file×utility pairs in 45 files, carried as a shrink-only debt list; #1001 paid it
 * all the same day, each to the token a SIBLING already used for the same job (see
 * the internal design notes for the mapping). There is no allowlist:
 * a new undefined utility needs a defined token, never an exemption.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from './strip-comments'
import {
  SOURCE_SCAN_TIMEOUT_MS, SRC_DIR, sourceFiles, srcRel,
} from '@/test-support/source-tree'

const CSS = readFileSync(join(SRC_DIR, 'index.css'), 'utf8')
const COLOR_TOKENS = new Set([...CSS.matchAll(/--color-(mm-[a-z0-9-]+)\s*:/g)].map(m => m[1]))
const SHADOW_TOKENS = new Set([...CSS.matchAll(/--shadow-(mm-[a-z0-9-]+)\s*:/g)].map(m => m[1]))

/**
 * A utility whose value is an `mm-*` theme name, with any variant chain and
 * opacity modifier. `shadow-` resolves against `--shadow-*`, everything else
 * against `--color-*` — `shadow-mm-card` is a real shadow, not a missing colour.
 */
const UTILITY = /(?<![\w-])(?:[a-z0-9-]+:)*(bg|text|border(?:-[trblxy])?|ring|ring-offset|fill|stroke|from|to|via|outline|divide|placeholder|accent|caret|decoration|shadow)-(mm-[a-z0-9-]+?)(?:\/\d+)?(?![\w-])/g

function undefinedUtilities(src: string): string[] {
  const out = new Set<string>()
  for (const m of src.matchAll(UTILITY)) {
    const [, util, token] = m
    const defined = util === 'shadow' ? SHADOW_TOKENS.has(token) : COLOR_TOKENS.has(token)
    if (!defined) out.add(`${util}-${token}`)
  }
  return [...out]
}


describe('mm-* theme utilities resolve to a defined token (#1001)', () => {
  it('reads the token set it judges against', () => {
    // A broken read of index.css would make EVERY utility "undefined" (loud) —
    // or, with a wrong regex, none of them. Pin known tokens both ways.
    expect(COLOR_TOKENS.size).toBeGreaterThan(20)
    for (const t of ['mm-surface', 'mm-text-muted', 'mm-border-subtle']) {
      expect(COLOR_TOKENS.has(t), t).toBe(true)
    }
    expect(SHADOW_TOKENS.has('mm-card')).toBe(true)
  })

  it('the predicate flags a missing name and passes a real one (falsifier)', () => {
    expect(undefinedUtilities('className="bg-mm-amber-bg dark:hover:text-mm-amber-text/80"'))
      .toEqual(['bg-mm-amber-bg', 'text-mm-amber-text'])
    expect(undefinedUtilities('className="bg-mm-surface text-mm-text-muted/70 shadow-mm-card"'))
      .toEqual([])
    // A defined prefix must not excuse a longer undefined name, nor the reverse.
    expect(undefinedUtilities('border-mm-border-subtle')).toEqual([])
    expect(undefinedUtilities('border-mm-border')).toEqual(['border-mm-border'])
  })

  it('🔴 no mm-* utility anywhere in src names an undefined token', () => {
    const found = new Set<string>()
    let scanned = 0
    let resolved = 0
    for (const abs of sourceFiles({ ext: 'both', floor: 300 })) {
      const src = stripComments(readFileSync(abs, 'utf8'), abs)
      scanned += 1
      resolved += [...src.matchAll(UTILITY)].length
      for (const u of undefinedUtilities(src)) found.add(`${srcRel(abs)} ${u}`)
    }
    // Population self-check: the scan reached real class strings.
    expect(scanned).toBeGreaterThan(300)
    expect(resolved).toBeGreaterThan(1000)

    expect(
      [...found].sort(),
      'An mm-* utility names no token in index.css, so Tailwind emits NOTHING for it. '
      + 'Use a defined token (the `--color-mm-*` list in index.css, or the shadcn '
      + 'tokens such as `border-border` / `ring-ring`) — never define a token to fit a name.',
    ).toEqual([])
  }, SOURCE_SCAN_TIMEOUT_MS)
})
