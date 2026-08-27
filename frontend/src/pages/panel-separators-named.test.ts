import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every draggable panel separator carries an accessible name (2026-08-24).
 *
 * 🔴 **Found by driving, not by reading.** `react-resizable-panels` gives its
 * `Separator` `role="separator"`, `tabIndex={0}` and a live `aria-valuenow` —
 * everything except a NAME. Measured on the running page: the control is
 * focusable and announces as a bare "separator". That is #559's rule one library
 * deeper: **a third-party component's ARIA defaults are markup you did not write
 * and did not review** (the same lesson #776 recorded about dnd-kit's
 * `roleDescription`), and no static gate reports it because the attributes that
 * ARE present look complete.
 *
 * ⚠️ A POPULATION assertion over the splitter surfaces rather than a test of the
 * new one. Two of the three had shipped unnamed months earlier; writing this as
 * "the Variables view's handle is named" would have left them that way and made
 * the next splitter the fourth.
 */

const SRC = join(__dirname, '..')

/** Every page that mounts a resizable panel group. */
const SPLITTER_PAGES = [
  'pages/RecodeWorkbench.tsx',
  'pages/AnalysisView.tsx',
  'pages/QualitativeAnalysisView.tsx',
] as const

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

describe('panel separators are named', () => {
  it('the surface list is complete (a stale list makes this vacuous)', () => {
    // Guard the guard: if a fourth page starts importing the library, this fails
    // until it is listed — which is the only way a population scan can stay one.
    const importers = SPLITTER_PAGES.filter(p => read(p).includes('react-resizable-panels'))
    expect(importers, 'a listed page no longer uses the library — re-derive the list')
      .toEqual([...SPLITTER_PAGES])
  })

  it.each(SPLITTER_PAGES)('%s names its resize handle', (rel) => {
    const src = read(rel)
    // Every PanelResizeHandle opening tag must carry an aria-label before its
    // className — asserted on the tag, not the file, so a page with two handles
    // cannot pass on the strength of one.
    const handles = src.match(/<PanelResizeHandle[\s\S]*?>/g) ?? []
    expect(handles.length, `${rel} renders no resize handle — re-anchor this scan`)
      .toBeGreaterThan(0)
    for (const tag of handles) {
      expect(tag, `${rel} has a PanelResizeHandle with no aria-label`)
        .toMatch(/aria-label=/)
    }
  })
})
