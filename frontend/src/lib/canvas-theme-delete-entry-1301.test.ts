/**
 * #1301 — undoing a canvas theme delete restores what the delete destroyed.
 *
 * Driven through a REAL `useHistory`, as `undo-history.md` asks of a new entry: act → (the
 * page moves on) → undo → assert what the inverse sent. The server half (that the record
 * puts everything back) is `backend/tests/test_canvas_theme_restore_1301.py`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { toastError, toastWarning } = vi.hoisted(() => ({ toastError: vi.fn(), toastWarning: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { error: toastError, warning: toastWarning, info: vi.fn(), success: vi.fn() },
}))

import { useHistory } from '@/hooks/useHistory'
import { themeDeleteEntry, restoreLostSentences } from './canvas-theme-delete-entry'
import type { ThemeRestoreRecord } from '@/lib/api'

const record = (id: number, text: string): ThemeRestoreRecord => ({
  id, name: 'Trust', section_type: 'prose', description: 'why', color: null, doc_order: 200,
  table_column_order: 200, viz_x: 12.5, viz_y: 80, parent_theme_id: 3,
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  child_ids: [], relationships: [], deleted_audit_id: 40 + id,
})
const NONE = { parent: false, children: 0, relationships: 0 }

function harness() {
  const deleteTheme = vi.fn()
  const restoreTheme = vi.fn()
  const onDeleted = vi.fn()
  const onChanged = vi.fn()
  const { result } = renderHook(() => useHistory())
  const entry = themeDeleteEntry({
    themeId: 7, name: 'Trust', api: { deleteTheme, restoreTheme }, onDeleted, onChanged,
  })
  return { result, entry, deleteTheme, restoreTheme, onDeleted, onChanged }
}

beforeEach(() => { toastError.mockClear(); toastWarning.mockClear() })

describe('#1301 — the theme-delete entry', () => {
  it('undo sends back EXACTLY what the delete reported destroying, and redo deletes the restored id', async () => {
    const h = harness()
    h.deleteTheme.mockResolvedValueOnce({ status: 'ok', deleted_id: 7, restore: record(7, 'first draft') })
    await act(() => h.result.current.execute(h.entry))
    expect(h.deleteTheme).toHaveBeenCalledWith(7)
    expect(h.onDeleted).toHaveBeenCalledWith(7)

    // The old id was taken by a newer theme, so the server hands back a new one.
    h.restoreTheme.mockResolvedValueOnce({ theme: { id: 9 }, not_restored: NONE })
    await act(() => h.result.current.undo())
    expect(h.restoreTheme).toHaveBeenCalledTimes(1)
    expect(h.restoreTheme.mock.calls[0][0]).toEqual(record(7, 'first draft'))
    expect(toastWarning).not.toHaveBeenCalled()

    h.deleteTheme.mockResolvedValueOnce({ status: 'ok', deleted_id: 9, restore: record(9, 'edited since') })
    await act(() => h.result.current.redo())
    expect(h.deleteTheme).toHaveBeenLastCalledWith(9)

    // The second undo restores the SECOND delete's record — never the first one's writing.
    h.restoreTheme.mockResolvedValueOnce({ theme: { id: 9 }, not_restored: NONE })
    await act(() => h.result.current.undo())
    expect(h.restoreTheme.mock.calls[1][0]).toEqual(record(9, 'edited since'))
    expect(h.onChanged).toHaveBeenCalledTimes(4)
  })

  it('says what the canvas no longer allowed, and keeps the step as undone', async () => {
    const h = harness()
    h.deleteTheme.mockResolvedValueOnce({ status: 'ok', deleted_id: 7, restore: record(7, 'x') })
    await act(() => h.result.current.execute(h.entry))
    h.restoreTheme.mockResolvedValueOnce({
      theme: { id: 7 }, not_restored: { parent: true, children: 1, relationships: 2 },
    })
    await act(() => h.result.current.undo())
    expect(toastWarning).toHaveBeenCalledWith('Restored "Trust", but not everything around it', {
      description:
        'The section it was nested under has been deleted or nested since, so it is back at the top level. '
        + '1 section that was nested under it has been moved or deleted since, so it stays where it is. '
        + '2 links could not be restored: the section at the other end has been deleted, or the two are linked again.',
    })
    expect(h.result.current.canRedo).toBe(true)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('a REFUSED restore (a withdrawal since) leaves the history in the server’s words', async () => {
    const h = harness()
    h.deleteTheme.mockResolvedValueOnce({ status: 'ok', deleted_id: 7, restore: record(7, 'x') })
    await act(() => h.result.current.execute(h.entry))
    const detail = 'This section can no longer be brought back: a participant was withdrawn after it was deleted, and it holds quotes that may be theirs.'
    h.restoreTheme.mockRejectedValueOnce(Object.assign(new Error('409'), { status: 409, response: { data: { detail } } }))
    await act(() => h.result.current.undo())
    expect(toastError).toHaveBeenCalledWith(detail, expect.objectContaining({ description: expect.stringContaining('removed from the history') }))
    expect(h.result.current.canUndo).toBe(false)
    expect(h.result.current.canRedo).toBe(false)
  })

  it('the sentences agree in number', () => {
    expect(restoreLostSentences(NONE)).toEqual([])
    expect(restoreLostSentences({ parent: false, children: 2, relationships: 1 })).toEqual([
      '2 sections that were nested under it have been moved or deleted since, so they stay where they are.',
      '1 link could not be restored: the section at the other end has been deleted, or the two are linked again.',
    ])
  })
})
