import * as ts from 'typescript'

/**
 * Blank out TS/TSX comments, preserving every other character's position —
 * asking the TypeScript compiler where the comments are rather than guessing.
 *
 * **Why this is a module, and why it is not a hand-rolled scanner.** #729 names
 * *four answers to comment-stripping* among this codebase's verification-layer
 * debt, and 2026-08-26 showed what that costs: `responsive-chrome.test.ts`'s
 * regex version treated the `/*` inside `matchPath('/projects/:projectId/*', …)`
 * as a comment opener and silently blanked lines 972–1067 of `TopRail.tsx` — the
 * block holding the coder menu. Every scan in that file ran against a source
 * with a hole in it and reported clean.
 *
 * 🔴 **That is the #772 lesson reached from the other side.** There, a naive
 * parser invented PHANTOMS — findings that pointed at real lines and were not
 * real. Here it went BLIND. Blindness is the worse of the two, because a phantom
 * is at least loud: a scan that can no longer see its target passes.
 *
 * 🔴 **THE FIRST FIX FOR THAT WAS A CHARACTER WALK, AND MEASURING IT AGAINST THE
 * COMPILER REFUTED IT (2026-08-26, second pass).** Scored over all 650 files of
 * `src/`, against the comment ranges TypeScript itself reports:
 *
 * | implementation | code blanked (BLIND) | comments surviving (PHANTOM) |
 * |---|---|---|
 * | the regex copy, in 18 files | 4,962 chars in 24 files | 0 |
 * | the string-aware character walk | 503 chars in 20 files | **20,732 chars in 25 files** |
 * | this module | **0** | **0** |
 *
 * The walk traded most of the blindness for a large new phantom surface, from
 * three shapes it could not know about — all three live in this repo today:
 *
 * 1. **A regex literal containing a quote.** `cd.match(/filename="?([^"]+)"?/)`
 *    (`lib/api/download.ts`) opens a bogus string that runs to the next `"`,
 *    so the JSDoc after it survived unstripped.
 * 2. **A regex literal containing `\/`.** `/^\s*\/\/.*$/gm` reads as `//` in the
 *    middle — a line comment opener — and blanks the rest of the line. The
 *    strippers this module replaces were blind to their own source.
 * 3. **An apostrophe in JSX text.** `you'll see a summary` (`DatasetImport.tsx`)
 *    opens a string that runs until the next `'`, hundreds of lines away.
 *
 * Nos. 1 and 2 need division-vs-regex disambiguation and no. 3 needs a JSX
 * element stack: at that point you are writing a lexer, and TypeScript — already
 * a devDependency, already the thing `npm run build` trusts — ships a correct
 * one. **A scan is not a compiler, but it may as well ask one.**
 *
 * ⚠️ **Position-preserving, and consumers depend on it.** Output has the same
 * length, the same line count and the same offsets as the input; comment
 * characters become spaces and their newlines survive. `indexOf`-anchored
 * windows and `slice(0, index).split('\n').length` line numbers stay honest.
 *
 * ⚠️ **Test-only.** It pulls in the TypeScript compiler, which must never reach
 * the application bundle — `strip-comments.test.ts` fails the suite if a
 * non-test module imports this one.
 */

/** Keyed on source text: the tree-walking scanners strip the same 650 files more than once. */
const cache = new Map<string, string>()

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.ts')) return ts.ScriptKind.TS
  // A bare fixture string with no filename: TSX is the superset our scans read.
  return ts.ScriptKind.TSX
}

/**
 * Every comment range TypeScript recognises, as a byte mask over `text`.
 *
 * ⚠️ **TOKEN-level recursion, not `forEachChild`** — a JSX comment `{/* … *\/}`
 * is a `JsxExpression` with NO expression child, so its comment is trivia of the
 * CLOSING BRACE token, which `forEachChild` never visits. The first version of
 * the measurement above used `forEachChild` and reported both implementations
 * blanking ~100,000 chars of "code": it was scoring them for correctly removing
 * every JSX comment in the codebase. **Check the probe before believing it.**
 *
 * ⚠️ `setParentNodes: false` — measured identical masks and 30% faster
 * (2,164 ms → 1,510 ms over the 650-file tree).
 */
function commentMask(text: string, fileName: string): Uint8Array {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKind(fileName))
  const mask = new Uint8Array(text.length)
  const mark = (ranges: ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) for (let i = r.pos; i < r.end; i++) mask[i] = 1
  }
  const visit = (node: ts.Node) => {
    mark(ts.getLeadingCommentRanges(text, node.pos))
    mark(ts.getTrailingCommentRanges(text, node.end))
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  return mask
}

export function stripComments(src: string, fileName = 'scan.tsx'): string {
  const hit = cache.get(src)
  if (hit !== undefined) return hit

  // Fast path: nothing that can open a comment, so nothing to strip. Skips the
  // parse for the minority of files that carry no commentary at all.
  if (!src.includes('//') && !src.includes('/*')) {
    cache.set(src, src)
    return src
  }

  const mask = commentMask(src, fileName)
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    out += mask[i] === 1 && c !== '\n' && c !== '\r' ? ' ' : c
  }
  cache.set(src, out)
  return out
}
