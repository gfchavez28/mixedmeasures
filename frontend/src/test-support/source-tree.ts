/**
 * THE source-tree walk for every fail-closed source scan in this suite (#729).
 *
 * ## Why one walker, when the 2026-08-09 review said not to unify them
 *
 * That review refused to unify the walkers' FILTERS — `accessible-names` scans
 * `.tsx` only because JSX parses only there, and standardising its siblings' `.tsx?`
 * onto it would silently narrow two of them. This module keeps that verdict: the
 * extension set, the roots and the recursion are PARAMETERS with no default, so
 * every caller states its filter and the migration copied each one verbatim
 * (a differential over all nineteen walkers, run before any of them moved).
 *
 * What it unifies is the part that kept failing to propagate from one guard to
 * the next, because it lived in each author's memory:
 *
 *   - the POPULATION floor (#730) — a scan asserting an empty offender list
 *     passes just as happily over an empty file list, and `readdirSync` never
 *     throws on a valid-but-narrower root. Nineteen walkers existed on
 *     2026-09-04; two had no floor at all. Here the floor is a REQUIRED
 *     argument and the walk itself throws below it, so a consumer cannot forget
 *     it and cannot assert over a list that was never proven.
 *   - the tree's IDENTITY — a count cannot tell `src/` from some other tree of
 *     `.ts` files, so the walk proves `main.tsx` sits at its root.
 *   - the REFLEXIVITY exclusion — this directory is test infrastructure and is
 *     excluded from every walk that excludes tests, by construction rather than
 *     by an allowlist entry, so its docblocks can never be reported as offenders
 *     (the #728 lesson: a guard whose remedy is "add an exemption" teaches its
 *     own weakening).
 *   - the failure FRAME — what was walked, how many, against what floor, and the
 *     remedy — with "lower the floor" named as the wrong move.
 *
 * `frontend/src/test-support/source-tree.test.ts` fails the suite if any other
 * file under `src/` walks the tree itself, which is what makes the floor
 * unavoidable for guard N+1 (the same single-source enforcement
 * `strip-comments.test.ts` applies to comment stripping, #838).
 *
 * ⚠️ This module deliberately does NOT import `stripComments`. Consumers strip;
 * the walker only walks. Keeping the two apart means this file never pulls the
 * TypeScript compiler into anything, and `strip-comments.test.ts`'s "no
 * application module imports it" guard needs no exemption for this directory.
 *
 * ⚠️ Whole-tree scans that strip every file cost seconds under full-suite
 * contention (#841/#867). Pass `{ timeout: SOURCE_SCAN_TIMEOUT_MS }` to such a
 * test, or hoist the scan to module scope where no per-test budget applies.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** `frontend/src`, resolved from this file so no caller re-derives it from its own location. */
export const SRC_DIR = join(__dirname, '..')

/**
 * The budget a whole-tree, comment-stripping scan declares. Measured 1.8 s cold
 * and up to 4 s under full-suite contention (#841), past vitest's 5 s default;
 * `token-contrast.test.ts` flaked for months as the one scanner without one (#867).
 */
export const SOURCE_SCAN_TIMEOUT_MS = 60_000

/** The directory this module lives in, excluded from every non-test walk by construction. */
const TEST_SUPPORT_DIR = 'test-support'

/** Names never worth descending into, whatever the caller asked for. */
const NEVER_WALKED = new Set(['node_modules', '__snapshots__'])

const TEST_FILE = /\.(test|spec)\.tsx?$/

export type SourceExt = 'ts' | 'tsx' | 'both'

export interface SourceTreeOptions {
  /**
   * Which files to admit. REQUIRED, never defaulted: `accessible-names` needs
   * `.tsx` only (it matches JSX elements), `ci-label` needs both (its pattern
   * lives in either), and a default would let one silently take the other's.
   */
  ext: SourceExt
  /**
   * The population floor (#730). REQUIRED: the walk throws when it finds fewer
   * files than this, so an assertion over the result can never pass vacuously.
   * Set it well below today's count — it detects a NARROWER root, not growth.
   */
  floor: number
  /**
   * Directories to walk, relative to `src/`. Default: all of `src/`. Several
   * roots are walked in order and concatenated.
   */
  root?: string | string[]
  /** Admit `*.test.*` / `*.spec.*` files and this directory. Default `false`. */
  includeTests?: boolean
  /** Descend into subdirectories. Default `true`. */
  recursive?: boolean
  /**
   * Files that MUST appear in the result, relative to `src/`. A count alone
   * cannot distinguish this tree from another that also holds `.ts` files.
   */
  sentinels?: string[]
}

function admits(name: string, ext: SourceExt): boolean {
  if (ext === 'tsx') return name.endsWith('.tsx')
  if (ext === 'ts') return name.endsWith('.ts')
  return /\.tsx?$/.test(name)
}

function walk(dir: string, opts: Required<Pick<SourceTreeOptions, 'ext' | 'includeTests' | 'recursive'>>, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith('.') || NEVER_WALKED.has(entry)) continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      if (!opts.recursive) continue
      if (entry === TEST_SUPPORT_DIR && !opts.includeTests && dir === SRC_DIR) continue
      walk(abs, opts, out)
      continue
    }
    if (!admits(entry, opts.ext)) continue
    if (!opts.includeTests && TEST_FILE.test(entry)) continue
    out.push(abs)
  }
}

/** A path under `src/`, relative to it, with forward slashes. */
export function srcRel(abs: string): string {
  return relative(SRC_DIR, abs).split('\\').join('/')
}

/**
 * Every source file the options describe, as ABSOLUTE paths, sorted — proven
 * non-vacuous before it is returned.
 *
 * Throws (rather than returning a short list) so that a consumer computing its
 * population at module scope, where no `expect` is running, fails just as loudly
 * as one computing it inside a test.
 */
export function sourceFiles(options: SourceTreeOptions): string[] {
  const { ext, floor, includeTests = false, recursive = true, sentinels = [] } = options
  const roots = ([] as string[]).concat(options.root ?? '')

  // Tree identity: this is the app's `src/`, not some other directory of `.ts` files.
  if (!existsSync(join(SRC_DIR, 'main.tsx'))) {
    throw new Error(
      `sourceFiles(): ${SRC_DIR} does not hold main.tsx, so this is not the app's src/ tree — `
        + 'the test-support module has moved and every scan built on it is looking at the wrong place.',
    )
  }

  const out: string[] = []
  for (const root of roots) walk(join(SRC_DIR, root), { ext, includeTests, recursive }, out)

  const where = roots.map(r => (r ? `src/${r}` : 'src/')).join(' + ')
  if (out.length < floor) {
    throw new Error(
      `sourceFiles() walked ${out.length} file(s) under ${where} (ext=${ext}, recursive=${recursive}, `
        + `includeTests=${includeTests}) — below the floor of ${floor}. The scan is reading a narrower `
        + 'tree than it claims, so every "no offenders" assertion built on this list would pass '
        + 'vacuously (#730). Fix the root or the filter; do NOT lower the floor.',
    )
  }

  const rels = new Set(out.map(srcRel))
  const missing = sentinels.filter(s => !rels.has(s))
  if (missing.length) {
    throw new Error(
      `sourceFiles() cannot see ${missing.join(', ')} under ${where} (ext=${ext}). A file COUNT `
        + `(${out.length}, over the floor of ${floor}) cannot tell this tree from another that also `
        + 'holds source files; these are the files the scan exists to police, so their absence means '
        + 'the root or the filter is wrong even though the count looked fine.',
    )
  }
  return out
}
