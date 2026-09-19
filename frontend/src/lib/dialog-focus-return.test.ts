/**
 * #959 — the rules for where focus goes when a dialog closes, as pure DOM.
 * The Radix wiring is covered by `components/ui/dialog-focus-return.test.tsx`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  captureFocusTarget,
  focusSamePlace,
  returnFocusAfterDialog,
  startDialogFocusSession,
  watchRestoredFocus,
} from './dialog-focus-return'

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

/** A list of cards, each wrapped the way the list pages wrap theirs (a span around a link). */
function list(names: string[]): { grid: HTMLElement; link: (name: string) => HTMLAnchorElement } {
  const main = document.createElement('main')
  main.id = 'main-content'
  main.tabIndex = -1
  const grid = document.createElement('div')
  grid.setAttribute('data-testid', 'grid')
  for (const n of names) {
    const wrap = document.createElement('span')
    const a = document.createElement('a')
    a.href = `#${n}`
    a.textContent = n
    wrap.appendChild(a)
    grid.appendChild(wrap)
  }
  main.appendChild(grid)
  document.body.appendChild(main)
  return { grid, link: (name: string) => [...grid.querySelectorAll('a')].find(a => a.textContent === name)! }
}

const active = () => document.activeElement

describe('captureFocusTarget', () => {
  it('records nothing for <body> — a dialog opened with nothing focused returns to nothing', () => {
    expect(captureFocusTarget(document.body)).toBeNull()
    expect(captureFocusTarget(null)).toBeNull()
  })

  it('records each ancestor with the index of the child on the path', () => {
    const { link, grid } = list(['a', 'b', 'c'])
    const t = captureFocusTarget(link('b'))!
    expect(t.path[0].index).toBe(0)                 // the link inside its span
    expect(t.path[1]).toEqual({ parent: grid, index: 1 })
  })
})

describe('focusSamePlace — whatever took the removed element\'s place', () => {
  it('focuses the NEXT card after the focused one is removed', () => {
    const { link } = list(['a', 'b', 'c'])
    const t = captureFocusTarget(link('b'))!
    link('b').parentElement!.remove()
    expect(focusSamePlace(t)).toBe(link('c'))
    expect(active()).toBe(link('c'))
  })

  it('focuses the PREVIOUS card when the removed one was last', () => {
    const { link } = list(['a', 'b', 'c'])
    const t = captureFocusTarget(link('c'))!
    link('c').parentElement!.remove()
    expect(focusSamePlace(t)).toBe(link('b'))
  })

  it('tries the predecessor when the child now at the index holds nothing focusable', () => {
    const { grid, link } = list(['a', 'b'])
    const t = captureFocusTarget(link('b'))!
    link('b').parentElement!.replaceWith(Object.assign(document.createElement('p'), { textContent: 'no controls' }))
    expect(grid.children).toHaveLength(2)
    expect(focusSamePlace(t)).toBe(link('a'))
  })

  it('gives up when the container is empty', () => {
    const { grid, link } = list(['only'])
    const t = captureFocusTarget(link('only'))!
    grid.innerHTML = ''
    expect(focusSamePlace(t)).toBeNull()
  })

  it('never uses <body> as the container — a portal\'s index means nothing afterwards', () => {
    list(['a'])
    const portal = document.createElement('div')
    const item = document.createElement('button')
    portal.appendChild(item)
    document.body.appendChild(portal)
    const t = captureFocusTarget(item)!
    portal.remove()
    expect(focusSamePlace(t)).toBeNull()
  })

  it('skips a disabled control and an inert one', () => {
    const wrap = document.createElement('div')
    const disabled = Object.assign(document.createElement('button'), { disabled: true, textContent: 'off' })
    const inert = document.createElement('div')
    inert.setAttribute('inert', '')
    inert.appendChild(Object.assign(document.createElement('button'), { textContent: 'inert' }))
    const gone = Object.assign(document.createElement('button'), { textContent: 'gone' })
    wrap.append(disabled, inert, gone)
    document.body.appendChild(wrap)
    const t = captureFocusTarget(gone)!
    gone.remove()
    // At index 2 nothing is left; index 1 is inert; neither may take focus.
    expect(focusSamePlace(t)).toBeNull()
  })
})

describe('returnFocusAfterDialog', () => {
  it('returns to the newest candidate that still exists', () => {
    const { link } = list(['a', 'b'])
    const detached = captureFocusTarget(document.createElement('button'))! // a menu item, already unmounted
    expect(returnFocusAfterDialog([detached, captureFocusTarget(link('b'))!, captureFocusTarget(link('a'))!]))
      .toBe(link('b'))
  })

  it('prefers a surviving candidate over the same-place of a newer removed one', () => {
    const { link } = list(['a', 'b', 'c'])
    const newer = captureFocusTarget(link('b'))!
    const older = captureFocusTarget(link('a'))!
    link('b').parentElement!.remove()
    expect(returnFocusAfterDialog([newer, older])).toBe(link('a'))
  })

  it('falls to the same place when no candidate survives', () => {
    const { link } = list(['a', 'b', 'c'])
    const t = captureFocusTarget(link('b'))!
    link('b').parentElement!.remove()
    expect(returnFocusAfterDialog([t])).toBe(link('c'))
  })

  it('falls to the main content when neither the element nor its place survives', () => {
    const { grid, link } = list(['only'])
    const t = captureFocusTarget(link('only'))!
    grid.remove()
    expect(returnFocusAfterDialog([t])).toBe(document.getElementById('main-content'))
  })

  it('moves nothing when there is no candidate — "where you came from" was nowhere', () => {
    list(['a'])
    expect(returnFocusAfterDialog([])).toBeNull()
    expect(active()).toBe(document.body)
  })

  it('never steals focus that something else has already placed', () => {
    const { link } = list(['a', 'b'])
    link('a').focus()
    expect(returnFocusAfterDialog([captureFocusTarget(link('b'))!])).toBeNull()
    expect(active()).toBe(link('a'))
  })
})

describe('watchRestoredFocus — a removal that lands after the dialog closed', () => {
  it('moves focus to the next card when the focused card is removed later', async () => {
    const { link } = list(['a', 'b', 'c'])
    link('b').focus()
    watchRestoredFocus(captureFocusTarget(link('b'))!)
    link('b').parentElement!.remove()
    await vi.waitFor(() => expect(active()).toBe(link('c')))
  })

  it('stops watching once focus moves elsewhere on purpose — even if focus is later lost', async () => {
    // The researcher moved on, then clicked blank space (focus to <body>). The old
    // card's removal must not pull focus back into the list: that would be a jump
    // nobody asked for. "Never steal" alone cannot see this — focus IS lost by then.
    const { link } = list(['a', 'b', 'c'])
    link('b').focus()
    watchRestoredFocus(captureFocusTarget(link('b'))!)
    link('a').focus()
    link('a').blur()
    expect(active()).toBe(document.body)
    link('b').parentElement!.remove()
    await new Promise(r => setTimeout(r, 20))
    expect(active()).toBe(document.body)
  })

  it('stops after its window', () => {
    vi.useFakeTimers()
    const { link } = list(['a', 'b', 'c'])
    link('b').focus()
    const observe = vi.spyOn(MutationObserver.prototype, 'disconnect')
    watchRestoredFocus(captureFocusTarget(link('b'))!, 1000)
    vi.advanceTimersByTime(1001)
    expect(observe).toHaveBeenCalled()
    observe.mockRestore()
  })
})

describe('startDialogFocusSession — what happened while the dialog was open', () => {
  it('lists focus that landed OUTSIDE the dialog, newest first, then the opener', () => {
    const { link } = list(['card', 'other'])
    const dialog = document.createElement('div')
    const inside = document.createElement('button')
    dialog.appendChild(inside)
    document.body.appendChild(dialog)
    dialog.setAttribute('role', 'dialog')   // Radix gives its content this role
    const opener = captureFocusTarget(link('other'))
    const session = startDialogFocusSession(opener)
    link('card').focus()   // the menu hands focus back to its trigger…
    inside.focus()          // …and the dialog's trap takes it back
    session.stop()
    expect(session.candidates().map(c => c.el)).toEqual([link('card'), link('other')])
  })

  it('records where a focusout was GOING — the trap can cancel the move before any focusin', () => {
    // Measured in Chrome: the dialog's trap refocuses inside during `focusout`, so
    // the card the menu handed focus to never receives `focusin`.
    const { link } = list(['card'])
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'alertdialog')
    const cancel = document.createElement('button')
    dialog.appendChild(cancel)
    document.body.appendChild(dialog)
    cancel.focus()
    const session = startDialogFocusSession(null)
    cancel.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: link('card') }))
    session.stop()
    expect(session.candidates().map(c => c.el)).toEqual([link('card')])
  })

  it('ignores focus inside another dialog, and stops recording when stopped', () => {
    const { link } = list(['card'])
    const other = document.createElement('div')
    other.setAttribute('role', 'alertdialog')
    const btn = document.createElement('button')
    other.appendChild(btn)
    document.body.appendChild(other)
    const session = startDialogFocusSession(null)
    btn.focus()
    session.stop()
    link('card').focus()
    expect(session.candidates()).toEqual([])
  })
})
