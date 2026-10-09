/**
 * #409 / #967 — a UI icon is a lucide SVG, never a pictographic CHARACTER.
 *
 * Two defects for one character, and #967 had both: on an install with no emoji
 * font the glyph renders as tofu (Electron shares the system fontconfig), and a
 * bare character inside a control is part of its ACCESSIBLE NAME — Chrome's tree
 * read `button "Jump to uncoded ⏭"`, and an element-less glyph cannot be
 * `aria-hidden`. An SVG beside the words can.
 *
 * ⚠️ **What this reads is TEXT THAT CAN RENDER — JSX text and string literals —
 * found by asking the TypeScript parser, never by stripping comments.** Comments
 * are not nodes, so this codebase's ⚠️ / 🔴 comment markers are invisible to it
 * by construction, and it pays a parse only for the few files whose raw text
 * holds a pictograph at all (the #1040 lesson: a whole-tree strip is seconds).
 *
 * ⚠️ **Arrows (U+2190–U+21FF) are allowed** — `↔` in a title is typographic and
 * sits in every text font; the class is pictographs.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { SOURCE_SCAN_TIMEOUT_MS, sourceFiles, srcRel } from '@/test-support/source-tree'

const PICTOGRAPH = /\p{Extended_Pictographic}/gu

function isAllowed(ch: string): boolean {
  const cp = ch.codePointAt(0)!
  return cp >= 0x2190 && cp <= 0x21ff
}

function hasForbidden(text: string): boolean {
  for (const m of text.matchAll(PICTOGRAPH)) if (!isAllowed(m[0])) return true
  return false
}

/**
 * The PARSE gate: does any forbidden pictograph sit somewhere other than after a
 * comment opener on its own line? Comment markers are hundreds of characters in
 * hundreds of files, and parsing every one of those files cost ~2 s — #1040's
 * class. A character this skips is one preceded on its LINE by `//`, `/*` or a
 * leading `*`; the blind spot is a string or JSX text that itself carries one of
 * those before the glyph on the same line (a URL, say), which the falsifier below
 * keeps honest about what is and is not seen.
 */
function mayRender(text: string): boolean {
  for (const m of text.matchAll(PICTOGRAPH)) {
    if (isAllowed(m[0])) continue
    const lineStart = text.lastIndexOf('\n', m.index) + 1
    const before = text.slice(lineStart, m.index)
    if (/\/\/|\/\*/.test(before) || /^\s*\*/.test(before)) continue
    return true
  }
  return false
}

/** Every JSX text node and string literal in `text` that holds a forbidden pictograph. */
function renderableOffenders(text: string, fileName: string): { line: number; snippet: string }[] {
  const sf = ts.createSourceFile(
    fileName, text, ts.ScriptTarget.Latest, false,
    fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX,
  )
  const out: { line: number; snippet: string }[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ) {
      const value = node.getText(sf)
      if (hasForbidden(value)) {
        out.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          snippet: value.trim().slice(0, 60),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

describe('#409 / #967 — no pictographic character in text the app can render', () => {
  it('no JSX text or string literal holds one (an icon is a lucide SVG, aria-hidden)', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const files = sourceFiles({
      ext: 'both',
      floor: 300,
      sentinels: ['pages/CodingWorkbench.tsx', 'pages/DocumentCodingWorkbench.tsx', 'pages/TextCodingView.tsx'],
    })
    const offenders: string[] = []
    let withPictographs = 0
    for (const abs of files) {
      const text = readFileSync(abs, 'utf8')
      if (!hasForbidden(text)) continue
      withPictographs += 1
      if (!mayRender(text)) continue   // only after a comment opener: nothing to parse
      for (const o of renderableOffenders(text, abs)) offenders.push(`${srcRel(abs)}:${o.line} — ${o.snippet}`)
    }
    // The raw scan must have met this codebase's comment markers, or it is not
    // reading the files it claims to — a scan that sees nothing passes by finding nothing.
    expect(withPictographs).toBeGreaterThan(10)
    expect(
      offenders,
      'Use a lucide-react icon with aria-hidden beside the words instead (#409); '
        + 'a character is part of the control’s accessible name and renders as tofu without an emoji font.',
    ).toEqual([])
  })

  it('the predicate fires on JSX text and strings, and ignores comments and arrows', () => {
    expect(renderableOffenders('const a = <button>Jump to uncoded ⏭</button>', 'a.tsx')).toHaveLength(1)
    expect(renderableOffenders("toast('Saved ✅')", 'a.ts')).toHaveLength(1)
    expect(renderableOffenders('const t = `done ⛔ ${x}`', 'a.ts')).toHaveLength(1)
    expect(renderableOffenders('// ⚠️ a comment marker\n/* 🔴 another */ const x = 1', 'a.ts')).toEqual([])
    expect(renderableOffenders('const a = <span>{/* 🔴 note */}ok</span>', 'a.tsx')).toEqual([])
    expect(renderableOffenders("const title = 'A ↔ B'", 'a.ts')).toEqual([])
  })

  it('the parse gate passes JSX text and strings through, and skips comment-marker lines', () => {
    expect(mayRender('  <button>Jump to uncoded ⏭</button>')).toBe(true)
    expect(mayRender("  toast('Saved ✅')")).toBe(true)
    expect(mayRender('  // 🔴 a marker\n  * ⚠️ another\n  /* ⚠️ x */')).toBe(false)
    expect(mayRender('  const a = 1 // ⚠️ trailing')).toBe(false)
    // The stated blind spot, pinned so it stays a decision rather than a surprise.
    expect(mayRender("  const url = 'https://x.org ⚠️'")).toBe(false)
  })
})
