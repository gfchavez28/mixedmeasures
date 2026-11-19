/**
 * The notice rule's R3 (2026-11-18): the shared collapsed section for a notice's longer account.
 * jsdom cannot show what Chrome reads from a closed `<details>`; that is checked in the browser.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { NoticeDetails } from './NoticeDetails'

afterEach(cleanup)

describe('NoticeDetails', () => {
  it('starts closed, with its label as the summary and its contents inside', () => {
    const { container } = render(
      <NoticeDetails label="Where copies remain">
        <p>The update copies are in the backup folder.</p>
      </NoticeDetails>,
    )
    const details = container.querySelector('details')!
    expect(details).not.toHaveAttribute('open')
    expect(container.querySelector('summary')!.textContent).toBe('Where copies remain')
    expect(details).toContainElement(container.querySelector('p'))
  })

  it('opens and closes from its summary', () => {
    const { container } = render(<NoticeDetails label="Why">text</NoticeDetails>)
    const details = container.querySelector('details')!
    fireEvent.click(container.querySelector('summary')!)
    expect(details).toHaveAttribute('open')
    fireEvent.click(container.querySelector('summary')!)
    expect(details).not.toHaveAttribute('open')
  })

  it('is closed again when its notice mounts again', () => {
    const { container, unmount } = render(<NoticeDetails label="Why">text</NoticeDetails>)
    fireEvent.click(container.querySelector('summary')!)
    expect(container.querySelector('details')).toHaveAttribute('open')
    unmount()
    const again = render(<NoticeDetails label="Why">text</NoticeDetails>)
    expect(again.container.querySelector('details')).not.toHaveAttribute('open')
  })

  it('hides its chevron from the accessibility tree and keeps a 24 px summary', () => {
    const { container } = render(<NoticeDetails label="Why">text</NoticeDetails>)
    const summary = container.querySelector('summary')!
    expect(summary.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(summary.className).toContain('min-h-6')
  })
})
