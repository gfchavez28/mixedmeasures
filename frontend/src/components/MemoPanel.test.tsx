/**
 * #912 — the workbench memo row's per-memo action (a11y sweep run 5, 2026-09-08).
 *
 * Three facts measured in Chrome's accessibility tree, all on one 24×24 button:
 *   (a) it was named "Delete memo" while its handler is `onArchive` — the name
 *       promised the irreversible act and the click archived (`is_archived=1`);
 *   (b) it revealed on hover only: `opacity: 0` while holding keyboard focus
 *       (#777's class — reachable by Tab, invisible when reached);
 *   (c) it named no memo, so N memos would give N identical buttons.
 *
 * jsdom computes accessible NAMES from `aria-label`, so (a) and (c) are asserted
 * on the computed name. jsdom applies no CSS, so (b) is pinned on the MECHANISM —
 * the `focus-within:` class on the wrapper that hover already had — and the
 * announcement itself was re-measured in the browser.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoItem } from './MemoPanel'
import { memoPreview, MEMO_PREVIEW_MAX } from '@/lib/memo-preview'
import type { Memo } from '@/lib/api'

const memo = (content: string): Memo =>
  ({
    id: 7,
    project_id: 1,
    numeric_id: 7,
    entity_type: 'conversation',
    entity_id: 9,
    title: null,
    content,
    is_archived: false,
    created_at: '2026-09-08T10:00:00Z',
    updated_at: '2026-09-08T10:00:00Z',
  }) as Memo

function renderItem(content: string) {
  return render(
    <MemoItem
      memo={memo(content)}
      codes={[]}
      conversations={[]}
      isEditing={false}
      editContent=""
      onEditContentChange={vi.fn()}
      onStartEdit={vi.fn()}
      onFinishEdit={vi.fn()}
      onArchive={vi.fn()}
    />,
  )
}

describe('MemoItem — the per-memo action (#912)', () => {
  it('is named for what it DOES (archive) and for WHICH memo', () => {
    renderItem('Follow up with the site lead about the timeline slip')
    const button = screen.getByRole('button', {
      name: 'Archive memo: Follow up with the site lead about the…',
    })
    expect(button).toBeTruthy()
    // The old name is gone — it promised a permanent deletion the handler never did.
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })

  it('reveals on keyboard focus, not only on hover', () => {
    renderItem('short')
    const button = screen.getByRole('button', { name: 'Archive memo: short' })
    const wrapper = button.parentElement as HTMLElement
    // The hover arm was already there; the focus arm is the fix. Both must sit on
    // the SAME element, or a Tab still lands on an invisible control.
    expect(wrapper.className).toMatch(/\bgroup-hover:opacity-100\b/)
    expect(wrapper.className).toMatch(/\bfocus-within:opacity-100\b/)
  })
})

describe('memoPreview — what a memo control is named from', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    const long = 'a'.repeat(MEMO_PREVIEW_MAX + 10)
    expect(memoPreview(long)).toHaveLength(MEMO_PREVIEW_MAX)
    expect(memoPreview(long).endsWith('…')).toBe(true)
    expect(memoPreview('  two\n\nlines  ')).toBe('two lines')
    // The cut never leaves a space before the ellipsis.
    expect(memoPreview('Follow up with the site lead about the timeline slip')).toBe(
      'Follow up with the site lead about the…',
    )
  })

  it('names an empty memo rather than producing "Archive memo: "', () => {
    expect(memoPreview('')).toBe('empty memo')
    expect(memoPreview(null)).toBe('empty memo')
    expect(memoPreview('   ')).toBe('empty memo')
  })
})
