/**
 * #1301 — the page builds its theme-delete history entry through
 * `lib/canvas-theme-delete-entry.ts::themeDeleteEntry`, whose undo restores the delete's
 * record, and no inverse re-creates a `{ name, color }` shell. (The entry's behaviour:
 * `lib/canvas-theme-delete-entry-1301.test.ts`; the server's: `test_canvas_theme_restore_1301.py`.)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'

describe('#1301 — CanvasView’s theme delete', () => {
  const path = join(__dirname, 'CanvasView.tsx')
  const src = stripComments(readFileSync(path, 'utf8'), path)
  const body = src.match(/const executeThemeDelete = useCallback\(([\s\S]*?)\n {2}\}, \[/)?.[1] ?? ''

  it('read the function it scans', () => {
    expect(src.length, 'read the page').toBeGreaterThan(20_000)
    expect(body, 'found executeThemeDelete').toContain('history.execute')
  })

  it('records the entry that restores what the delete destroyed', () => {
    expect(body).toContain('themeDeleteEntry(')
    expect(body).toContain('canvasApi.restoreTheme(')
    expect(body, 'the old inverse re-created a { name, color } shell').not.toContain('createTheme(')
  })

  it('asks in D269’s words, counting a callout apart, on the shared destructive button', () => {
    // The sentence itself: `lib/canvas-theme-delete-confirm-1301.test.ts`.
    const dialog = src.match(/<AlertDialog open=\{deleteThemeTarget !== null\}[\s\S]*?<\/AlertDialog>/)?.[0] ?? ''
    expect(dialog, 'found the delete confirmation').toContain('Delete section?')
    expect(dialog).toContain('themeDeleteConfirmText(deleteThemeTarget.name, deleteThemeTarget.holds)')
    expect(dialog, 'the old words said the materials would be permanently deleted').not.toMatch(/permanent/i)
    expect(dialog).toContain('variant="destructive"')
    expect(dialog, 'a hand-set red with white text (#1492)').not.toMatch(/bg-red-\d+|text-white/)
    const holds = src.match(/const holds: ThemeDeleteHolds = \{([\s\S]*?)\n {4}\}/)?.[1] ?? ''
    expect(holds, 'found the counts').toContain('callouts: summary.calloutCount')
    expect(holds, 'a callout is not a project material').not.toMatch(/materials:[^\n]*calloutCount/)
  })
})
