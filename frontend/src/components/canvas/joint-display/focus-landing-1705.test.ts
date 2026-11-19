/**
 * #1705 (a) (D386) — `landOnFirstField`: a dialog whose body was not ready at Radix's open
 * autofocus opened on Close; once ready, its first field takes focus — only while focus is still
 * where the opening put it (Close, the dialog, `<body>`), never from where the researcher moved.
 * The DOM shape is the wrapper's (`components/ui/dialog.tsx`): Close is the dialog's own child,
 * named by its sr-only "Close". Chrome's order is checked by the drive, not here.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { landOnFirstField } from './focus-landing'

function dialog() {
  document.body.innerHTML = `
    <div role="dialog" tabindex="-1">
      <div><input aria-label="Display title" /><input aria-label="Other" /></div>
      <button type="button"><span>Close</span></button>
    </div>`
  const root = document.querySelector<HTMLElement>('[role="dialog"]')!
  return {
    root,
    title: root.querySelector<HTMLInputElement>('[aria-label="Display title"]')!,
    other: root.querySelector<HTMLInputElement>('[aria-label="Other"]')!,
    close: root.querySelector<HTMLButtonElement>('button')!,
  }
}

afterEach(() => { document.body.innerHTML = '' })

describe('landOnFirstField (#1705 a, D386)', () => {
  it('moves focus from Close — where the opening put it — to the first field', () => {
    const d = dialog()
    d.close.focus()
    landOnFirstField(d.title)
    expect(document.activeElement).toBe(d.title)
  })

  it('moves it from the dialog itself, and from <body>', () => {
    const d = dialog()
    d.root.focus()
    landOnFirstField(d.title)
    expect(document.activeElement).toBe(d.title)
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    landOnFirstField(d.title)
    expect(document.activeElement).toBe(d.title)
  })

  it('never steals: a researcher in another field keeps their place', () => {
    const d = dialog()
    d.other.focus()
    landOnFirstField(d.title)
    expect(document.activeElement).toBe(d.other)
  })

  it('a missing field is a no-op', () => {
    const d = dialog()
    d.close.focus()
    landOnFirstField(null)
    expect(document.activeElement).toBe(d.close)
  })
})
