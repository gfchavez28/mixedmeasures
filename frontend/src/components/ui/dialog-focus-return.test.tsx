/**
 * #959 — every dialog returns focus through the `components/ui` wrappers, here
 * driven through REAL Radix (no mocks), keyboard only.
 *
 * Before: Radix returns focus only to a `Trigger`, and 71 of the app's 72 dialogs
 * are opened by state, so each of these cases left focus on `<body>` (measured
 * live on the Export dialog, and on a delete confirmation's Cancel and Delete).
 * The rules themselves are unit-tested in `lib/dialog-focus-return.test.ts`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog'
import { ConfirmDialog } from '@/components/ConfirmDialog'

afterEach(cleanup)

const active = () => document.activeElement

function StateDialog({ autoFocusInput = false, onCloseAutoFocus }: {
  autoFocusInput?: boolean
  onCloseAutoFocus?: (e: Event) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <main id="main-content" tabIndex={-1}>
      <button onClick={() => setOpen(true)}>Export</button>
      <button>Elsewhere</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
          <DialogTitle>Export Project Data</DialogTitle>
          <DialogDescription>Pick what to export.</DialogDescription>
          {autoFocusInput && <input aria-label="File name" autoFocus />}
          <button>Export Selected</button>
        </DialogContent>
      </Dialog>
    </main>
  )
}

/** A list whose rows each open ONE shared delete confirmation, like the list pages. */
function DeletableList({ removeLate = false }: { removeLate?: boolean }) {
  const [rows, setRows] = useState(['alpha', 'beta', 'gamma'])
  const [target, setTarget] = useState<string | null>(null)
  return (
    <main id="main-content" tabIndex={-1}>
      <ul>
        {rows.map(r => (
          <li key={r}><button onClick={() => setTarget(r)}>Delete {r}</button></li>
        ))}
      </ul>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={o => { if (!o) setTarget(null) }}
        title="Delete row?"
        description="This cannot be undone."
        onConfirm={() => {
          const t = target
          setTarget(null)
          // The list pages close on the server's answer and the refetch removes
          // the row afterwards; `removeLate` reproduces that order.
          if (removeLate) setTimeout(() => setRows(rs => rs.filter(x => x !== t)), 30)
          else setRows(rs => rs.filter(x => x !== t))
        }}
      />
    </main>
  )
}

const openDialog = () => document.querySelector('[role="dialog"], [role="alertdialog"]')

async function openWithKeyboard(name: string) {
  const btn = screen.getByRole('button', { name })
  btn.focus()
  fireEvent.click(btn)
  await waitFor(() => expect(openDialog()).not.toBeNull())
}

async function closeWithEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  await waitFor(() => expect(openDialog()).toBeNull())
}

describe('#959 — a dialog opened by state returns focus', () => {
  it('to the button it was opened from, on Escape (the Export dialog case)', async () => {
    render(<StateDialog />)
    await openWithKeyboard('Export')
    // The page is aria-hidden behind the modal, hence `hidden: true`.
    expect(active()).not.toBe(screen.getByRole('button', { name: 'Export', hidden: true }))
    await closeWithEscape()
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'Export' })))
  })

  it('to the opener even when an autoFocus field took focus first', async () => {
    render(<StateDialog autoFocusInput />)
    await openWithKeyboard('Export')
    expect(active()).toBe(screen.getByRole('textbox', { name: 'File name' }))
    await closeWithEscape()
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'Export' })))
  })

  it('lets a caller that prevents the default choose its own landing', async () => {
    const land = vi.fn((e: Event) => {
      e.preventDefault()
      screen.getByRole('button', { name: 'Elsewhere' }).focus()
    })
    render(<StateDialog onCloseAutoFocus={land} />)
    await openWithKeyboard('Export')
    await closeWithEscape()
    await waitFor(() => expect(land).toHaveBeenCalled())
    expect(active()).toBe(screen.getByRole('button', { name: 'Elsewhere' }))
  })

  it('a caller that prevents the default and focuses NOTHING is obeyed too', async () => {
    // "Its landing stands" includes no landing; "never steal" cannot tell, since
    // focus is on <body> either way.
    const land = vi.fn((e: Event) => e.preventDefault())
    render(<StateDialog onCloseAutoFocus={land} />)
    await openWithKeyboard('Export')
    await closeWithEscape()
    await waitFor(() => expect(land).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 20))
    expect(active()).toBe(document.body)
  })

  it('leaves focus where it was when the dialog opened with nothing focused', async () => {
    function OpenOnMount() {
      const [open, setOpen] = useState(true)
      return (
        <main id="main-content" tabIndex={-1}>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogTitle>Welcome</DialogTitle>
              <DialogDescription>Hello.</DialogDescription>
            </DialogContent>
          </Dialog>
        </main>
      )
    }
    ;(document.activeElement as HTMLElement | null)?.blur()
    render(<OpenOnMount />)
    await screen.findByRole('dialog')
    await closeWithEscape()
    await new Promise(r => setTimeout(r, 20))
    expect(active()).toBe(document.body)
  })

  it('to the control a MENU handed focus back to while the dialog was open', async () => {
    // A menu item opens the dialog and unmounts; the menu then returns focus to
    // its trigger (the card) and the dialog's trap pulls it back. That brief
    // focus is the only record of the card the researcher used.
    function MenuOpened() {
      const [menu, setMenu] = useState(true)
      const [open, setOpen] = useState(false)
      return (
        <main id="main-content" tabIndex={-1}>
          <a href="#card">Card</a>
          {menu && <button onClick={() => { setMenu(false); setOpen(true) }}>Delete (menu item)</button>}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogTitle>Delete?</DialogTitle>
              <DialogDescription>Sure?</DialogDescription>
              <button>Delete</button>
            </DialogContent>
          </Dialog>
        </main>
      )
    }
    render(<MenuOpened />)
    await openWithKeyboard('Delete (menu item)')
    act(() => { screen.getByRole('link', { name: 'Card', hidden: true }).focus() })
    await waitFor(() => expect(screen.getByRole('dialog').contains(active())).toBe(true))
    await closeWithEscape()
    await waitFor(() => expect(active()).toBe(screen.getByRole('link', { name: 'Card' })))
  })
})

describe('#959 — a delete confirmation lands in the same place', () => {
  it('Cancel returns to the row\'s own button', async () => {
    render(<DeletableList />)
    await openWithKeyboard('Delete beta')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'Delete beta' })))
  })

  it('confirming focuses the NEXT row when the deleted one is removed with the close', async () => {
    render(<DeletableList />)
    await openWithKeyboard('Delete beta')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'Delete gamma' })))
  })

  it('confirming still lands on the next row when the row is removed AFTER the dialog closed', async () => {
    render(<DeletableList removeLate />)
    await openWithKeyboard('Delete beta')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete beta' })).not.toBeInTheDocument())
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'Delete gamma' })))
  })

  it('deleting the LAST row focuses the one before it', async () => {
    render(<DeletableList />)
    await openWithKeyboard('Delete gamma')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'Delete beta' })))
  })
})

describe('#959 — ConfirmDialog\'s busy state keeps focus', () => {
  function Busy({ loading, onConfirm, onOpenChange }: {
    loading: boolean; onConfirm: () => void; onOpenChange: (o: boolean) => void
  }) {
    return (
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete dataset?"
        description="This cannot be undone."
        loading={loading}
        onConfirm={onConfirm}
      />
    )
  }

  it('is aria-disabled, not disabled — so the focused button keeps focus', async () => {
    const onConfirm = vi.fn()
    const { rerender } = render(<Busy loading={false} onConfirm={onConfirm} onOpenChange={() => {}} />)
    const action = await screen.findByRole('button', { name: 'Delete' })
    act(() => { action.focus() })
    expect(active()).toBe(action)
    rerender(<Busy loading onConfirm={onConfirm} onOpenChange={() => {}} />)
    const busy = screen.getByRole('button', { name: 'Deleting...' })
    expect(busy).toBe(action)
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).not.toBeDisabled()
    expect(active()).toBe(busy)
  })

  it('refuses a second confirm and refuses Cancel while busy — the guard, not the attribute', async () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(<Busy loading onConfirm={onConfirm} onOpenChange={onOpenChange} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deleting...' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })
})
