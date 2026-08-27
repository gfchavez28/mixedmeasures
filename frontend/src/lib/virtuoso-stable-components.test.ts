/**
 * #826 — every virtualised coding surface hands react-virtuoso a STABLE
 * `components` reference.
 *
 * **What an inline object costs, measured.** `ByTextTable` passed
 * `components={{ Table: (props) => …, TableRow: ({item, ...props}) => … }}` —
 * a fresh object with fresh component identities on every render, whose `Table`
 * closed over `selectedValueIds`. React therefore destroyed and rebuilt the
 * whole `<table>` on every selection change, and **DOM focus went with the
 * detached node, to `<body>`**. `aria-activedescendant` is honoured only on the
 * element that HAS focus, so a browse-mode screen reader was told nothing while
 * the researcher arrowed through the records. Proved by tagging the node across
 * a real keypress: `sameElement: false`, `oldStillInDocument: false`.
 *
 * ⚠️ **Nothing else can see it.** The ARIA is valid in a snapshot (the attribute
 * is set on the NEW table), sighted keyboard use is unaffected (the shared
 * keyboard layer treats focus-on-body as its own), and jsdom mounts every row
 * so no render test reproduces the recycle. `frontend-a11y.md` has stated this
 * rule in prose since #484 and one of four surfaces drifted anyway — which is
 * the argument for a scan rather than another paragraph.
 *
 * ⚠️ **Self-checks, one per NARROWING (#814's lesson).** A scan that reads a
 * file successfully and then resolves its slice to nothing passes exactly like
 * a scan that found no violations. So each step below asserts its own result is
 * non-empty: the file list, the `components={…}` match, and the module-scope
 * declaration lookup.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')

/**
 * The population: every non-test source that mounts a Virtuoso list.
 *
 * Hand-listed, then re-derived below — a surface added without a row here
 * fails the enumeration check, not silently nothing.
 */
const SURFACES = [
  'components/TranscriptPanel.tsx',
  'components/ByTextTable.tsx',
  'pages/DocumentCodingWorkbench.tsx',
  'pages/ObservationWorkbench.tsx',
] as const

/**
 * The mount tag.
 *
 * ⚠️ `(?![A-Za-z])` rather than `[\s>]`: `ObservationWorkbench` writes
 * `<Virtuoso<ObservationSegment, ClipListContext>`, so the next character is
 * `<`. The first draft used `[\s>]`, and the self-check below caught it on its
 * first run — which is the whole reason that assertion exists.
 */
const MOUNT_RE = /<(?:Table|Grouped)?Virtuoso(?![A-Za-z])/

function read(file: string): string {
  return readFileSync(join(SRC, file), 'utf8')
}

describe('#826 — a virtualised list never remounts on a state change', () => {
  it('the scan reads every listed surface, and each one really mounts a Virtuoso', () => {
    // Self-check 1: the walk. `readFileSync` throws on a moved file, so the
    // risk here is a file that exists and no longer mounts a list — which would
    // leave the assertions below true and meaningless.
    expect(SURFACES.length).toBeGreaterThanOrEqual(4)
    for (const file of SURFACES) {
      expect(MOUNT_RE.test(read(file)), `${file} no longer mounts a Virtuoso`).toBe(true)
    }
  })

  it('passes a NAMED reference, never an inline object literal', () => {
    const inline: string[] = []
    const named = new Map<string, string>()
    for (const file of SURFACES) {
      const src = read(file)
      if (/components=\{\{/.test(src)) inline.push(file)
      const m = src.match(/components=\{(\w+)\}/)
      if (m) named.set(file, m[1])
    }
    expect(
      inline,
      'An inline `components={{…}}` gives react-virtuoso new component ' +
        'identities every render; React then destroys the list and focus falls ' +
        'to <body> (#826).',
    ).toEqual([])
    // Self-check 2: the match resolved for every surface. Without this, a
    // renamed prop would empty the map and the next assertion would iterate
    // nothing.
    expect(named.size).toBe(SURFACES.length)
  })

  it('declares that reference at MODULE scope', () => {
    const offenders: string[] = []
    let checked = 0
    for (const file of SURFACES) {
      const src = read(file)
      const ident = src.match(/components=\{(\w+)\}/)?.[1]
      if (!ident) continue
      // Column 0 = module scope. A `useMemo` inside the component would still
      // change identity whenever its deps did, which is the same remount.
      const declared = new RegExp(`^const ${ident}\\b`, 'm').test(src)
      checked += 1
      if (!declared) offenders.push(`${file} (${ident})`)
    }
    // Self-check 3: the declaration lookup ran for every surface.
    expect(checked).toBe(SURFACES.length)
    expect(
      offenders,
      'The components object must be declared at module scope; volatile state ' +
        "reaches it through Virtuoso's `context` prop.",
    ).toEqual([])
  })

  it('threads volatile state through `context`, not a closure', () => {
    // The corollary of module scope: the components can no longer close over
    // component state, so each surface must pass a `context`. A module-scope
    // object with nothing threaded in would be stable and inert.
    const missing = SURFACES.filter(f => !/\bcontext=\{/.test(read(f)))
    expect(missing).toEqual([])
  })
})
