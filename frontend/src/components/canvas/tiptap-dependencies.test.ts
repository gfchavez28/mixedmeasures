import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SRC_DIR, sourceFiles, srcRel, SOURCE_SCAN_TIMEOUT_MS } from '@/test-support/source-tree'
import { stripComments } from '@/lib/strip-comments'

/**
 * #872 — the manifest guard for the Tiptap set.
 *
 * Three defects were found together at the 2026-09-04 bump, and none of them was
 * visible to any gate the repo already had:
 *
 *  1. **The set had drifted apart.** `extension-mention` and `suggestion` were
 *     pinned EXACT at 3.19.0 while everything else floated to 3.21.0 — from a
 *     commit (`f30c589`) whose message records no reason for the pin. Harmless
 *     while upstream's peer ranges were `^3.x`; at 3.31.3 those peers became
 *     EXACT (`"@tiptap/core": "3.31.3"`), so the same drift is now an install
 *     conflict rather than a silent mismatch.
 *  2. **Three packages were imported by source and declared nowhere** —
 *     `@tiptap/core` (18 imports), `@tiptap/pm`, `@tiptap/extension-link`. They
 *     resolved only because npm hoists `starter-kit`'s dependency graph, which
 *     meant the advisory that started this issue was on a package we consume
 *     DIRECTLY and could not state a floor for in our own manifest.
 *  3. **Three declared packages were imported nowhere** — `extension-heading`
 *     (StarterKit is configured `heading: false`), `extension-text-style`,
 *     `extension-underline`.
 *
 * ⚠️ The suite is weak evidence for a Tiptap bump generally: of the twelve canvas
 * test files only two touch Tiptap and BOTH mock it, so a green run says nothing
 * about whether the editor works. That is what the live drive is for. This file
 * guards only what a manifest can prove — which is exactly the part that rots
 * silently between drives.
 */

const PKG = JSON.parse(readFileSync(join(SRC_DIR, '..', 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}

/** `@tiptap/pm/state` and `@tiptap/react/menus` are subpaths of one package each. */
function packageOf(specifier: string): string {
  return specifier.split('/').slice(0, 2).join('/')
}

const declared = Object.entries(PKG.dependencies).filter(([name]) => name.startsWith('@tiptap/'))

describe('the Tiptap set moves as one unit', () => {
  it('declares every member at the same exact version', () => {
    expect(declared.length).toBeGreaterThanOrEqual(8)

    const ranges = new Set(declared.map(([, range]) => range))
    expect(
      ranges.size === 1,
      `@tiptap/* is declared at ${ranges.size} different versions: `
        + declared.map(([n, r]) => `${n}@${r}`).join(', ')
        + '. Upstream peer dependencies are EXACT from 3.31.3 on, so a partial bump is an '
        + 'install-time conflict — move the whole set together.',
    ).toBe(true)

    // A range would let one member drift ahead of the others on a later install,
    // which is the state this guard exists to prevent.
    const ranged = declared.filter(([, range]) => /^[\^~><=*]|x/.test(range))
    expect(
      ranged.length === 0,
      `these @tiptap/* entries carry a version RANGE, not an exact pin: ${ranged.map(([n, r]) => `${n}@${r}`).join(', ')}. `
        + 'The set is pinned exactly so the next bump is a deliberate, reviewed act (#872, #632).',
    ).toBe(true)
  })
})

describe('fail-closed: imported and declared are the same set', () => {
  const IMPORT = /(?:from|import)\s*\(?\s*['"](@tiptap\/[^'"]+)['"]/g

  const imported = new Map<string, string[]>()

  for (const file of sourceFiles({
    ext: 'both',
    floor: 250,
    includeTests: true,
    // The two files the scan exists to police: a count cannot tell this tree
    // from another that also holds `.ts` files.
    sentinels: ['components/canvas/useCanvasEditor.ts', 'components/canvas/extensions/image-embed.ts'],
  })) {
    const src = stripComments(readFileSync(file, 'utf8'), file)
    for (const [, specifier] of src.matchAll(IMPORT)) {
      const pkg = packageOf(specifier)
      const seen = imported.get(pkg) ?? []
      if (!seen.includes(srcRel(file))) seen.push(srcRel(file))
      imported.set(pkg, seen)
    }
  }

  it('imports nothing it does not declare', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    expect(imported.size).toBeGreaterThan(0)

    const declaredNames = new Set(declared.map(([name]) => name))
    const phantom = [...imported.entries()].filter(([pkg]) => !declaredNames.has(pkg))

    expect(
      phantom.length === 0,
      'these @tiptap packages are imported but not in `dependencies`, so they resolve only '
        + 'by npm hoisting another package\'s graph — a security floor cannot be stated for them, '
        + 'and they vanish the day their host drops them:\n'
        + phantom.map(([pkg, files]) => `  ${pkg} — ${files.join(', ')}`).join('\n'),
    ).toBe(true)
  })

  it('declares nothing it does not import', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const unused = declared.map(([name]) => name).filter(name => !imported.has(name))

    expect(
      unused.length === 0,
      `these @tiptap packages are declared but imported nowhere under src/: ${unused.join(', ')}. `
        + 'An unused pin is still a pin: it has to be moved with every bump, and a stale one is '
        + 'exactly the drift this file guards against.',
    ).toBe(true)
  })
})

describe('a security floor npm audit cannot see', () => {
  /**
   * 🔴 `prosemirror-view` 1.42.3 closed an XSS: *"Run attribute validators on
   * attributes provided via slice context in clipboard content"* (its own
   * CHANGELOG, in the published tarball). We are a paste target — `image-embed`'s
   * `handlePaste` returns false for any non-image payload and falls through to
   * ProseMirror's clipboard parser.
   *
   * ⚠️ **`npm audit` has nothing to fire on.** The GHSA id Tiptap's 3.31.2 release
   * note cites returns 404 from GitHub's advisory API, and an ecosystem query for
   * `prosemirror-view` advisories returns an empty array (both checked
   * 2026-09-04). So the repo's three HARD audit gates are blind to this one and a
   * downgrade below the floor would pass every one of them. That is the whole
   * reason this assertion is hand-written rather than delegated to the auditor.
   */
  const FLOOR = '1.42.3'

  it(`keeps prosemirror-view at or above ${FLOOR}`, () => {
    const lock = JSON.parse(readFileSync(join(SRC_DIR, '..', 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>
    }
    const entry = lock.packages['node_modules/prosemirror-view']

    expect(entry?.version, 'prosemirror-view is absent from the lockfile').toBeTruthy()

    const version = entry.version!
    expect(
      version.localeCompare(FLOOR, undefined, { numeric: true }) >= 0,
      `prosemirror-view is ${version}, below the ${FLOOR} clipboard-XSS floor. npm audit will NOT `
        + 'report this — there is no published advisory for it — so this assertion is the only thing '
        + 'standing between a lockfile edit and a re-opened paste vulnerability.',
    ).toBe(true)
  })
})
