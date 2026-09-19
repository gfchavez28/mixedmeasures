/**
 * #959 — focus return after a dialog is decided in ONE seam, so no dialog may
 * bypass it.
 *
 * `components/ui/dialog.tsx` and `components/ui/alert-dialog.tsx` wire
 * `useDialogFocusReturn` into Radix's `Content`. A file importing
 * `@radix-ui/react-dialog` or `@radix-ui/react-alert-dialog` DIRECTLY would get
 * Radix's default instead — focus returns only to a `Trigger`, i.e. to `<body>`
 * for every dialog opened by state, which was 71 of 72 when this was measured.
 *
 * The property is WHICH MODULE IMPORTS WHAT, so a source scan is the right
 * instrument here. What the wiring DOES is asserted through real Radix in
 * `dialog-focus-return.test.tsx`, for both wrappers.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { sourceFiles, srcRel, SOURCE_SCAN_TIMEOUT_MS } from '@/test-support/source-tree'
import { stripComments } from '@/lib/strip-comments'

const WRAPPERS = ['components/ui/dialog.tsx', 'components/ui/alert-dialog.tsx']
const RADIX_DIALOG_IMPORT = /from\s+["']@radix-ui\/react-(alert-)?dialog["']/

describe('#959 — every dialog goes through the focus-return seam', () => {
  it('only the two ui wrappers import Radix\'s dialog packages', () => {
    const files = sourceFiles({ ext: 'both', floor: 400, sentinels: WRAPPERS })
    const importers = files
      .filter(f => RADIX_DIALOG_IMPORT.test(stripComments(readFileSync(f, 'utf8'), f)))
      .map(srcRel)
      .sort()
    // Population self-check: the scan must SEE the two it exists to allow.
    expect(importers).toEqual(expect.arrayContaining(WRAPPERS))
    expect(importers).toEqual([...WRAPPERS].sort())
  }, SOURCE_SCAN_TIMEOUT_MS)

  it('the import pattern matches both spellings it is written for (predicate falsifier)', () => {
    expect(RADIX_DIALOG_IMPORT.test('import * as D from "@radix-ui/react-dialog"')).toBe(true)
    expect(RADIX_DIALOG_IMPORT.test("import { Root } from '@radix-ui/react-alert-dialog'")).toBe(true)
    expect(RADIX_DIALOG_IMPORT.test("import { X } from '@/components/ui/dialog'")).toBe(false)
  })
})
