/**
 * `ConfirmDialog` — what Batch 4b added to it.
 *
 * - #1139: a `fitViewport` dialog opens scrolled to its top, and starting the work
 *   put a wait above the footer with the scroll position unchanged, so the focused
 *   busy confirm sat below the visible part (measured on the restore and withdrawal
 *   confirms; the project delete, Link by column and the overwrite import share the
 *   shape). It is scrolled back into view when `loading` turns on.
 * - #1152: `confirmWaiting` — the act's precondition is still being read as the
 *   dialog opens. `aria-disabled` + the guard, the name unchanged (#770).
 *
 * jsdom computes no layout and has no `scrollIntoView`: the call is stubbed and
 * asserted; the positions are measured live.
 */
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ConfirmDialog, DIALOG_FITS_VIEWPORT } from './ConfirmDialog'

afterEach(cleanup)

/** A page that starts its work on the confirm and keeps the dialog open meanwhile. */
function Working({ fitViewport = true }: { fitViewport?: boolean }) {
  const [loading, setLoading] = useState(false)
  return (
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete project"
      description="It goes for good."
      confirmLabel="Delete"
      loadingLabel="Deleting…"
      loading={loading}
      fitViewport={fitViewport}
      onConfirm={() => setLoading(true)}
    />
  )
}

describe('#1139 — the busy confirm is kept in view', () => {
  it('scrolls the confirm into view (nearest) when the work starts, and not before', () => {
    const spy = vi.fn()
    HTMLElement.prototype.scrollIntoView = spy
    try {
      render(<Working />)
      expect(spy).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      const busy = screen.getByRole('button', { name: 'Deleting…' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith({ block: 'nearest' })
      expect(spy.mock.contexts[0]).toBe(busy)
      // `block: 'nearest'` ignores the dialog's padding: without a scroll margin
      // the button lands flush on its bottom edge (measured live, builder A).
      expect(busy).toHaveClass('scroll-mb-6')
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('`fitViewport` caps the dialog at the window; without it, nothing is added', () => {
    render(<Working />)
    const dialog = screen.getByRole('alertdialog')
    for (const c of DIALOG_FITS_VIEWPORT.split(' ')) expect(dialog).toHaveClass(c)
    cleanup()
    render(<Working fitViewport={false} />)
    expect(screen.getByRole('alertdialog')).not.toHaveClass('overflow-y-auto')
  })
})

function Waiting({ waiting, onConfirm }: { waiting: boolean; onConfirm: () => void }) {
  return (
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete Amara Okafor’s record? (E-01)"
      description="This removes the participant record only."
      confirmLabel="Delete record"
      confirmWaiting={waiting}
      onConfirm={onConfirm}
    />
  )
}

describe('#1152 — `confirmWaiting`', () => {
  it('is unavailable but focusable, keeps its name, and a press does nothing', () => {
    const onConfirm = vi.fn()
    render(<Waiting waiting onConfirm={onConfirm} />)
    const confirm = screen.getByRole('button', { name: 'Delete record' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    expect(confirm).not.toBeDisabled()
    expect(confirm).toHaveClass('aria-disabled:opacity-50')
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('POSITIVE CONTROL: once it has answered the confirm acts', () => {
    const onConfirm = vi.fn()
    render(<Waiting waiting={false} onConfirm={onConfirm} />)
    const confirm = screen.getByRole('button', { name: 'Delete record' })
    expect(confirm).not.toHaveAttribute('aria-disabled')
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
