import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { stripComments } from './strip-comments'

/**
 * The guard for the one text transform every source scan in this codebase runs
 * before it looks at anything.
 *
 * 🔴 **Why the corpus tests below are not decoration.** Two implementations of
 * this function shipped believing they were correct, and BOTH were wrong in ways
 * no synthetic fixture caught — the regex went blind on a route string, the
 * character walk went phantom on a regex literal and a JSX apostrophe. Neither
 * defect is imaginable from first principles; both are obvious the moment you
 * score the implementation against the real 650-file tree. **The fixtures below
 * document the shapes; the corpus tests are what would actually catch the next
 * one.**
 */

const SRC = join(__dirname, '..')
const SELF = ['lib/strip-comments.ts', 'lib/strip-comments.test.ts']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else if (/\.tsx?$/.test(abs)) out.push(abs)
  }
  return out
}

function corpus(): { rel: string; abs: string; text: string }[] {
  const files = walk(SRC).map(abs => ({
    abs,
    rel: abs.slice(SRC.length + 1),
    text: readFileSync(abs, 'utf8'),
  }))
  // POPULATION self-check (#729/#730): every assertion here is "for each file",
  // which passes vacuously over an empty list. A wrong root is the way that
  // happens, and it is silent.
  expect(files.length, `walked ${files.length} files under ${SRC} — wrong root?`).toBeGreaterThan(150)
  return files
}

/**
 * Token spans, computed from the parser's TOKEN tree rather than from its
 * comment trivia — deliberately a different API surface from the one
 * `strip-comments.ts` uses, so a mistake in that module's mask cannot hide
 * behind the same mistake here.
 */
function tokens(text: string, fileName: string): { pos: number; end: number; kind: ts.SyntaxKind }[] {
  const sf = ts.createSourceFile(
    fileName, text, ts.ScriptTarget.Latest, false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const out: { pos: number; end: number; kind: ts.SyntaxKind }[] = []
  const visit = (node: ts.Node) => {
    // ⚠️ JSDoc arrives as CHILD NODES, not as trivia, so a `/** … */` block is a
    // leaf of this walk. Without this line the probe scores every JSDoc comment
    // in the tree as "code that was blanked" — which is exactly what it did on
    // first run, reporting 650 files of phantom blindness. **The second probe
    // error in this session; check the probe before believing it.**
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const kids = node.getChildren(sf)
    if (kids.length === 0) out.push({ pos: node.getStart(sf), end: node.end, kind: node.kind })
    else for (const k of kids) visit(k)
  }
  visit(sf)
  return out
}

/** Token kinds whose TEXT may legitimately still contain `//` or `/*` after stripping. */
const TEXT_BEARING = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
])

describe('stripComments — the shapes that broke the two previous implementations', () => {
  it('keeps code after a string containing a comment opener (the #830a blindness)', () => {
    // ⚠️ THE TRAILING COMMENT IS THE WHOLE FIXTURE. Without a `*/` somewhere
    // below it, the regex implementation has nothing to close its false comment
    // on and passes this case — which is why the version of this check written
    // on 2026-08-26 could not actually discriminate the bug it was written for.
    // In `TopRail.tsx` the terminator was 95 lines down.
    const src = [
      "const m = matchPath('/projects/:projectId/*', location.pathname)",
      'const keep = <span className="hidden sm:inline">Label</span>',
      '/** an ordinary comment, whose terminator closes the false one */',
      'const alsoKeep = 1',
    ].join('\n')
    const out = stripComments(src)
    expect(out.split('\n')[1]).toContain('hidden sm:inline')
    expect(out.split('\n')[3]).toContain('const alsoKeep = 1')
    expect(out).not.toContain('ordinary comment')
  })

  it('keeps code after a regex literal that contains a comment opener', () => {
    // The exact shape the replaced strippers were written in: `\//g` ends in
    // `//`, so the line-comment arm blanked the rest of their own source line.
    const src = [
      "const re = /\\/\\*[\\s\\S]*?\\*\\//g",
      'const after = 1',
    ].join('\n')
    const out = stripComments(src)
    expect(out.split('\n')[0]).toContain('g')
    expect(out.split('\n')[0]).toHaveLength(src.split('\n')[0].length)
    expect(out.split('\n')[0].trimEnd()).toEqual(src.split('\n')[0].trimEnd())
    expect(out.split('\n')[1]).toContain('const after = 1')
  })

  it('strips a comment that FOLLOWS a regex literal containing a quote', () => {
    // `lib/api/download.ts`: the `"` inside the regex opened a bogus string and
    // 2,314 chars of JSDoc survived behind it.
    const src = [
      'const name = cd.match(/filename="?([^"]+)"?/)?.[1]',
      '/** doc that must not survive */',
      'const after = 2',
    ].join('\n')
    const out = stripComments(src)
    expect(out).not.toContain('must not survive')
    expect(out).toContain('const after = 2')
    expect(out.split('\n')[0]).toContain('filename=')
  })

  it('strips a comment that FOLLOWS an apostrophe in JSX text', () => {
    // `pages/DatasetImport.tsx`: "you'll" opened a string that ran until the
    // next apostrophe, hundreds of lines below.
    const src = [
      'const el = <p>unlinked — you&apos;ll see it</p>'.replace('&apos;', "'"),
      '{/* Dataset Details */}',
      'const after = 3',
    ].join('\n')
    const out = stripComments(src)
    expect(out).not.toContain('Dataset Details')
    expect(out).toContain('const after = 3')
  })

  it('strips real comments and preserves every position', () => {
    const src = ['/* a\n   b */ const x = 1', '// gone', 'const y = 2', '/* trailing at EOF */'].join('\n')
    const out = stripComments(src)
    expect(out).not.toContain('gone')
    expect(out).not.toContain('trailing at EOF')
    expect(out).toContain('const x = 1')
    expect(out).toContain('const y = 2')
    expect(out).toHaveLength(src.length)
    expect(out.split('\n')).toHaveLength(src.split('\n').length)
  })

  it('leaves a comment-looking sequence inside a string alone', () => {
    const src = "const u = 'https://example.com/a' // real\nconst v = 2"
    const out = stripComments(src)
    expect(out).toContain("'https://example.com/a'")
    expect(out).not.toContain('real')
  })
})

describe('stripComments — scored against the whole source tree', () => {
  /**
   * BLINDNESS, the failure that passes. Every token the parser recognises must
   * survive stripping byte for byte; a stripper that eats code fails here with
   * the file and offset, rather than by a scan somewhere else quietly reporting
   * clean.
   */
  // ⚠️ Explicit timeouts: these two parse all 650 files twice over (the module
  // under test, then this file's independent token walk) and run ~8 s together,
  // past vitest's 5 s default.
  it('never blanks a single character of real code, in any file', { timeout: 60_000 }, () => {
    const offenders: string[] = []
    for (const { rel, abs, text } of corpus()) {
      const out = stripComments(text, abs)
      if (out.length !== text.length) { offenders.push(`${rel}: length changed`); continue }
      for (const t of tokens(text, abs)) {
        if (out.slice(t.pos, t.end) !== text.slice(t.pos, t.end)) {
          offenders.push(`${rel}:${text.slice(0, t.pos).split('\n').length} — token blanked: ${JSON.stringify(text.slice(t.pos, Math.min(t.end, t.pos + 40)))}`)
          break
        }
      }
    }
    expect(offenders.slice(0, 10), 'code was blanked as if it were a comment').toEqual([])
  })

  /**
   * PHANTOMS, the loud failure — a comment that survived, which a scan then
   * reads as if it were code (#772: a prose mention of `role="grid"` reported as
   * a violation that did not exist).
   */
  it('leaves no comment behind, in any file', { timeout: 60_000 }, () => {
    const offenders: string[] = []
    for (const { rel, abs, text } of corpus()) {
      const out = stripComments(text, abs)
      const safe = tokens(text, abs).filter(t => TEXT_BEARING.has(t.kind))
      const inSafeToken = (i: number) => safe.some(t => i >= t.pos && i < t.end)
      for (const m of out.matchAll(/\/\/|\/\*/g)) {
        if (!inSafeToken(m.index)) {
          offenders.push(`${rel}:${out.slice(0, m.index).split('\n').length} — comment survived stripping`)
          break
        }
      }
    }
    expect(offenders.slice(0, 10), 'a comment survived and will be read as code').toEqual([])
  })
})

describe('one implementation, and it stays out of the bundle', () => {
  /**
   * #729's *four answers to comment-stripping* — this is what keeps it at one.
   * EIGHTEEN files carried their own copy on 2026-08-26 — 13 spelling
 * `function stripComments`, five inlining the same regex into a helper called
 * `code` or `strip`, which is why a search for the NAME undercounts. Every one
   * was blind to `TopRail.tsx`'s coder menu and to `WritingCanvas.tsx`'s
   * `input.accept = 'image/*'`, and two of the thirteen actually read those
   * files.
   *
   * ⚠️ Sources are stripped by the module under test before being searched, so a
   * file may still DISCUSS the pattern in prose. It may not define one.
   */
  it('no other module defines its own comment stripper', () => {
    // ⚠️ No trailing `\b`, deliberately: `strip\w*Comments?\b` missed
    // `stripCommentsLocal` — the exact name someone reaches for when the
    // imported one is already in scope. Found by mutating this guard, not by
    // reading it.
    const DEFINITION = /(?:function|const|let)\s+\w*[sS]tripComment/
    // The classic regex copy, spelled in pieces so this line does not match itself.
    const REGEX_COPY = new RegExp(['\\/\\\\\\/\\\\\\*', '\\[\\\\s\\\\S\\]\\*\\?'].join(''))
    const offenders: string[] = []
    for (const { rel, abs, text } of corpus()) {
      if (SELF.includes(rel)) continue
      const src = stripComments(text, abs)
      if (DEFINITION.test(src) || REGEX_COPY.test(src)) offenders.push(rel)
    }
    expect(
      offenders,
      'Import `stripComments` from `@/lib/strip-comments` instead of writing another one. '
        + 'Every hand-rolled version this codebase has had went blind or phantom on real source; '
        + 'see that module’s header for the measurements.',
    ).toEqual([])
  })

  it('both detectors actually fire', () => {
    // PREDICATE self-check (#729): a scan whose expected result is [] cannot
    // tell "clean" from "broken matcher" — and BOTH arms need one, because they
    // catch different copies. The name arm caught the eight files that spelled
    // `function stripComments`; the regex arm is what caught the five that
    // inlined the same expression into a helper called `code` or `strip`.
    const DEFINITION = /(?:function|const|let)\s+\w*[sS]tripComment/
    const REGEX_COPY = new RegExp(['\\/\\\\\\/\\\\\\*', '\\[\\\\s\\\\S\\]\\*\\?'].join(''))

    expect(DEFINITION.test('function stripComments(src: string) {')).toBe(true)
    expect(DEFINITION.test('const stripComments = (s: string) =>')).toBe(true)
    expect(DEFINITION.test('function stripCommentsLocal(src: string) {')).toBe(true)
    expect(DEFINITION.test('import { stripComments } from "./strip-comments"')).toBe(false)

    expect(REGEX_COPY.test(String.raw`src.replace(/\/\*[\s\S]*?\*\//g, '')`)).toBe(true)
    expect(REGEX_COPY.test(String.raw`const code = (s) => stripComments(s)`)).toBe(false)
  })

  it('no application module imports it — the TypeScript compiler must not reach the bundle', () => {
    // This module pulls in `typescript` (~8 MB). Nothing outside a test may
    // import it, or Vite would bundle a compiler into the desktop app.
    const offenders: string[] = []
    for (const { rel, text } of corpus()) {
      if (SELF.includes(rel) || /\.test\.tsx?$/.test(rel)) continue
      if (/from\s+['"](?:[./]*|@\/lib\/)strip-comments['"]/.test(text)) offenders.push(rel)
    }
    expect(offenders, 'strip-comments is test-only; importing it from app code bundles the compiler').toEqual([])
  })
})
