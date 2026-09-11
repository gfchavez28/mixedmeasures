/**
 * #911(b) — a dialog either HAS a description or SAYS it has none.
 *
 * Radix's `Dialog.Content` sets `aria-describedby` to a generated id whether or
 * not a `DialogDescription` is ever rendered, because the id comes from context
 * and `Content` has no runtime signal about its own children. So a dialog with
 * no description points at an element that does not exist — invalid ARIA, and
 * measured in Chrome as `MISSING_TARGET` on the *Add Variable* dialog (#911).
 *
 * Two legitimate endings, and BOTH are accepted here:
 *   - render a `DialogDescription`, which takes the id Radix already points at;
 *   - pass `aria-describedby={undefined}`, Radix's documented way to say there
 *     is none. React drops the attribute, so nothing dangles.
 *
 * 🔴 **This is a POPULATION assertion because the per-file form let it ship
 * partially.** #911(a) fixed and pinned ONE dialog by name; re-scanned per
 * INSTANCE on 2026-09-09 there were **nine** dangling, in seven files — and two
 * of the nine were invisible to a file-level grep, because `CanvasView` renders
 * three dialogs and one of them already had a description. The filed entry said
 * "six more". That per-file pin is deleted rather than kept beside this: a guard
 * that this one strictly subsumes is redundancy that will drift.
 *
 * ⚠️ **THE FIX CANNOT LIVE IN THE SHARED `DialogContent` WRAPPER, which is the
 * first thing to reach for in this codebase.** The wrapper cannot know whether
 * its children include a `DialogDescription` without walking them, and a blanket
 * `aria-describedby={undefined}` default would BREAK every dialog that has a
 * real description by severing the id Radix wired for it. The decision is per
 * dialog because only the author knows whether there is something to say.
 *
 * ⚠️ **Known limit, checked rather than assumed:** a `DialogDescription` rendered
 * CONDITIONALLY would read as "described" here and still dangle when the
 * condition is false. Measured 2026-09-09 across all 42 description sites: none
 * is conditional. If one ever is, this scan is the wrong instrument for it and
 * the answer is a jsdom render of that dialog in both states (#890's channel).
 *
 * ⚠️ jsdom resolves no Radix runtime here — this is a source scan, so it pins
 * the SHAPE. What the tree actually reports was measured live for #911(a).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { sourceFiles } from '@/test-support/source-tree'

const KINDS = [
  { content: 'DialogContent', description: 'DialogDescription' },
  { content: 'AlertDialogContent', description: 'AlertDialogDescription' },
] as const

/**
 * The end of a JSX opening tag, skipping any `>` that sits inside a `{…}`
 * expression.
 *
 * 🔴 Not optional cleverness: `CodePanel.tsx` really renders
 * `<DialogContent onClick={(e: React.MouseEvent) => e.stopPropagation()}>`, and
 * a naive scan for the first `>` truncates that tag at the ARROW — so any
 * attribute after it becomes invisible and the tag reads as having no
 * `aria-describedby`. That is #772's phantom class: a finding pointing at a real
 * line that is not real. `openTagEnd` is exercised on that exact shape below.
 */
function openTagEnd(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return i
  }
  return -1
}

interface DialogSite {
  file: string
  line: number
  described: boolean
  optedOut: boolean
}

function dialogSites(): DialogSite[] {
  const sites: DialogSite[] = []
  // The walk, its tree-identity check and its floor live in `sourceFiles()`
  // (#729/#730) — never a private `readdirSync` under `src/`.
  for (const abs of sourceFiles({ ext: 'tsx', floor: 100 })) {
    const src = stripComments(readFileSync(abs, 'utf8'), abs)
    for (const { content, description } of KINDS) {
      const open = new RegExp(`<${content}(\\s|>|$)`, 'g')
      let m: RegExpExecArray | null
      while ((m = open.exec(src))) {
        const tagEnd = openTagEnd(src, m.index)
        if (tagEnd === -1) continue
        const openTag = src.slice(m.index, tagEnd + 1)
        const closeIdx = src.indexOf(`</${content}>`, tagEnd)
        const body = closeIdx === -1 ? '' : src.slice(tagEnd, closeIdx)
        sites.push({
          file: abs.slice(abs.indexOf('/src/') + 1),
          line: src.slice(0, m.index).split('\n').length,
          described: body.includes(`<${description}`),
          optedOut: /aria-describedby/.test(openTag),
        })
      }
    }
  }
  return sites
}

describe('#911(b) — no dialog dangles an aria-describedby', () => {
  const sites = dialogSites()

  it('every dialog either renders a description or declares it has none', () => {
    const dangling = sites
      .filter(s => !s.described && !s.optedOut)
      .map(s => `${s.file}:${s.line}`)
    expect(
      dangling,
      'Radix points `aria-describedby` at a generated id whether or not a '
        + 'description is rendered, so a dialog with neither dangles the '
        + 'reference. Render a <DialogDescription>, or pass '
        + '`aria-describedby={undefined}` to say there is none (#911).',
    ).toEqual([])
  })

  it('the scan finds the dialogs it exists to check', () => {
    // A population self-check: `toEqual([])` above passes just as happily when
    // the walk resolves to nothing or the matcher has rotted (#729). 52 sites
    // were counted on 2026-09-09; the floor is deliberately below that so
    // deleting a dialog is not a failure.
    expect(sites.length).toBeGreaterThanOrEqual(40)
  })

  it('both endings are actually in use, so neither branch is dead', () => {
    // If every site took one branch, the other would be untested wording.
    expect(sites.filter(s => s.described).length).toBeGreaterThan(0)
    expect(sites.filter(s => s.optedOut).length).toBeGreaterThan(0)
  })

  it('the opening-tag parser survives an arrow function in the tag', () => {
    // The predicate falsifier, on the real shape from `CodePanel.tsx`. A naive
    // first-`>` scan stops at the arrow and reports the tag as having no
    // `aria-describedby`, inventing a finding on a line that is fine.
    const src = '<DialogContent onClick={(e) => e.stop()} aria-describedby={undefined}>x</DialogContent>'
    const end = openTagEnd(src, 0)
    expect(src.slice(0, end + 1)).toContain('aria-describedby')
    // And it still terminates on an ordinary tag. Derived, not hand-counted:
    // the literal index was written as 27 and is 28, which is the kind of
    // assertion that fails for a reason unrelated to what it claims.
    const plain = '<DialogContent className="a">'
    expect(openTagEnd(plain, 0)).toBe(plain.length - 1)
  })
})
