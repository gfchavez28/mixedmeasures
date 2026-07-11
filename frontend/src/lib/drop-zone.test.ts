/**
 * #560a — zone click opens the picker, but exactly ONCE.
 *
 * The naive fix (a bare `onClick` on the zone) double-opens the file chooser:
 * the zone contains the control that already opens it, so a click on that control
 * opens the chooser AND bubbles up to the zone, which opens it again.
 */
import { describe, it, expect, vi } from 'vitest'
import type { MouseEvent } from 'react'

import { openPickerFromZoneClick } from './drop-zone'

/** Minimal stand-in for a React MouseEvent with a real DOM target. */
function clickOn(html: string, selector: string): MouseEvent<HTMLElement> {
  const zone = document.createElement('div')
  zone.innerHTML = html
  document.body.appendChild(zone)
  const target = selector === ':zone' ? zone : zone.querySelector(selector)!
  return { target } as unknown as MouseEvent<HTMLElement>
}

const ZONE_HTML = `
  <p>Drag and drop files here, or click to browse</p>
  <svg class="icon"></svg>
  <button type="button">Select Files</button>
  <input type="file" class="hidden" />
`

describe('openPickerFromZoneClick', () => {
  it('opens the picker for a click on the zone itself', () => {
    const open = vi.fn()
    openPickerFromZoneClick(clickOn(ZONE_HTML, ':zone'), open)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('opens the picker for a click on the zone copy or icon (dead space)', () => {
    const open = vi.fn()
    openPickerFromZoneClick(clickOn(ZONE_HTML, 'p'), open)
    openPickerFromZoneClick(clickOn(ZONE_HTML, 'svg'), open)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('does NOT fire for a click on the inner Button — it opens the picker itself', () => {
    // This is the whole point: without the guard the chooser opens TWICE.
    const open = vi.fn()
    openPickerFromZoneClick(clickOn(ZONE_HTML, 'button'), open)
    expect(open).not.toHaveBeenCalled()
  })

  it('does NOT fire for a click on a child INSIDE the Button (icon in a button)', () => {
    const open = vi.fn()
    const html = '<button type="button"><svg class="inner"></svg>Select</button>'
    openPickerFromZoneClick(clickOn(html, 'svg.inner'), open)
    expect(open).not.toHaveBeenCalled()
  })

  it('does NOT fire for a click on a <label> bound to the input', () => {
    const open = vi.fn()
    const html = '<label for="f">Select</label><input id="f" type="file" />'
    openPickerFromZoneClick(clickOn(html, 'label'), open)
    expect(open).not.toHaveBeenCalled()
  })

  it('does NOT fire for a click on the file input itself', () => {
    const open = vi.fn()
    openPickerFromZoneClick(clickOn(ZONE_HTML, 'input'), open)
    expect(open).not.toHaveBeenCalled()
  })

  it('does NOT fire for a click on a link inside the zone', () => {
    // ConversationImport's zone copy links out to the Documents importer (#412).
    const open = vi.fn()
    const html = '<p>Have a Word transcript? <a href="/docs">Documents</a></p>'
    openPickerFromZoneClick(clickOn(html, 'a'), open)
    expect(open).not.toHaveBeenCalled()
  })
})
