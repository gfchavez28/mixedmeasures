/**
 * #1407 — the Data grid's pager keeps keyboard focus.
 *
 * Chrome blurs a focused button that becomes `disabled`, so focus fell to
 * `<body>` three ways: *Previous* and *Next* while a page loaded, *Previous* on
 * reaching the first page and *Next* the last, and *Go* after every accepted
 * jump (it clears the field it is disabled by). Measured by keyboard on a
 * 450-record scratch dataset (run 14; *Go* re-measured at the build).
 *
 * ⚠️ jsdom does not blur a disabled element, so these tests assert the two things
 * that decide the outcome in Chrome: busy is `aria-disabled` (never native
 * `disabled`), and focus is MOVED to the decided landing. Each landing test fails
 * without its effect because jsdom leaves focus on the disabled button.
 *
 * The harness plays `DatasetView`'s part with explicit props: a press asks for an
 * offset (`pageOffset` moves at once), and the page arrives later (`shownOffset`
 * catches up, `isFetching` clears) — the query's placeholder data in between.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import DatasetPager from './DatasetPager'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const TOTAL = 450
const PAGE = 200

function pager(pageOffset: number, shownOffset: number, isFetching: boolean, onPageOffsetChange = vi.fn()) {
  return (
    <>
      <DatasetPager
        pageOffset={pageOffset}
        shownOffset={shownOffset}
        pageStart={shownOffset + 1}
        pageEnd={Math.min(shownOffset + PAGE, TOTAL)}
        totalRows={TOTAL}
        pageSize={PAGE}
        isFetching={isFetching}
        onPageOffsetChange={onPageOffsetChange}
      />
      <button type="button">Elsewhere</button>
    </>
  )
}

const button = (name: string) => screen.getByRole('button', { name })
const field = () => screen.getByRole('textbox', { name: 'Go to record number' })

afterEach(cleanup)

describe('a press that makes its own button unusable lands on the next control (D1)', () => {
  it('Next onto the last page lands on Previous, once that page has arrived', () => {
    const ask = vi.fn()
    const { rerender } = render(pager(PAGE, PAGE, false, ask))
    button('Next').focus()
    fireEvent.click(button('Next'))
    expect(ask).toHaveBeenCalledWith(400)

    rerender(pager(400, PAGE, true, ask)) // asked; page 2 still on screen
    expect(button('Next')).not.toBeDisabled()
    expect(document.activeElement).toBe(button('Next'))

    rerender(pager(400, 400, false, ask)) // page 3 arrives: Next is disabled
    expect(button('Next')).toBeDisabled()
    expect(document.activeElement).toBe(button('Previous'))
  })

  it('Previous onto the first page lands on Next at once — that edge is the offset asked for', () => {
    const ask = vi.fn()
    const { rerender } = render(pager(PAGE, PAGE, false, ask))
    button('Previous').focus()
    fireEvent.click(button('Previous'))
    expect(ask).toHaveBeenCalledWith(0)

    rerender(pager(0, PAGE, true, ask))
    expect(button('Previous')).toBeDisabled()
    expect(document.activeElement).toBe(button('Next'))
  })

  it('Go lands on the record-number field, which its own submit has emptied', () => {
    const ask = vi.fn()
    render(pager(0, 0, false, ask))
    fireEvent.change(field(), { target: { value: '250' } })
    button('Go').focus()
    fireEvent.click(button('Go'))
    expect(ask).toHaveBeenCalledWith(200)
    expect(button('Go')).toBeDisabled()
    expect(document.activeElement).toBe(field())
  })
})

describe('the landing never fires where it was not earned', () => {
  it('a press onto a middle page leaves focus on the button pressed', () => {
    const ask = vi.fn()
    const { rerender } = render(pager(0, 0, false, ask))
    button('Next').focus()
    fireEvent.click(button('Next'))
    rerender(pager(PAGE, 0, true, ask))
    rerender(pager(PAGE, PAGE, false, ask))
    expect(document.activeElement).toBe(button('Next'))
  })

  it('a jump to the last page moves nothing — focus stays in the field it was typed in', () => {
    const ask = vi.fn()
    const { rerender } = render(pager(PAGE, PAGE, false, ask))
    field().focus()
    fireEvent.change(field(), { target: { value: '450' } })
    fireEvent.submit(field().closest('form')!)
    expect(ask).toHaveBeenCalledWith(400)
    rerender(pager(400, PAGE, true, ask))
    rerender(pager(400, 400, false, ask))
    expect(document.activeElement).toBe(field())
  })

  it('never steals: focus the researcher moved during the load stays where it went', () => {
    const ask = vi.fn()
    const { rerender } = render(pager(PAGE, PAGE, false, ask))
    button('Next').focus()
    fireEvent.click(button('Next'))
    rerender(pager(400, PAGE, true, ask))
    button('Elsewhere').focus()
    rerender(pager(400, 400, false, ask))
    expect(document.activeElement).toBe(button('Elsewhere'))
  })

  it('a press made without focus on the button (a pointer that does not focus) moves nothing', () => {
    const ask = vi.fn()
    const { rerender } = render(pager(PAGE, PAGE, false, ask))
    expect(document.activeElement).toBe(document.body)
    fireEvent.click(button('Next'))
    rerender(pager(400, PAGE, true, ask))
    rerender(pager(400, 400, false, ask))
    expect(document.activeElement).toBe(document.body)
  })

  it('the same for Go: a press that did not take focus leaves focus where it was', () => {
    const ask = vi.fn()
    render(pager(0, 0, false, ask))
    fireEvent.change(field(), { target: { value: '250' } })
    expect(document.activeElement).toBe(document.body)
    fireEvent.click(button('Go'))
    expect(ask).toHaveBeenCalledWith(200)
    expect(document.activeElement).toBe(document.body)
  })
})

describe('while a page loads, the three buttons are busy — focusable, and refusing', () => {
  it('Previous, Next and Go are aria-disabled + aria-busy, never natively disabled', () => {
    render(pager(400, PAGE, true))
    fireEvent.change(field(), { target: { value: '5' } })
    for (const name of ['Previous', 'Next', 'Go']) {
      expect(button(name)).not.toBeDisabled()
      expect(button(name)).toHaveAttribute('aria-disabled', 'true')
      expect(button(name)).toHaveAttribute('aria-busy', 'true')
    }
  })

  it('a press on any of them asks for nothing', () => {
    const ask = vi.fn()
    render(pager(400, PAGE, true, ask))
    fireEvent.change(field(), { target: { value: '5' } })
    fireEvent.click(button('Previous'))
    fireEvent.click(button('Next'))
    fireEvent.submit(field().closest('form')!)
    expect(ask).not.toHaveBeenCalled()
  })

  it('control: idle, none of them carries the busy attributes', () => {
    render(pager(PAGE, PAGE, false))
    fireEvent.change(field(), { target: { value: '5' } })
    for (const name of ['Previous', 'Next', 'Go']) {
      expect(button(name)).not.toHaveAttribute('aria-disabled')
      expect(button(name)).not.toHaveAttribute('aria-busy')
    }
  })
})

describe('the preconditions keep native disabled (#754 transient arm)', () => {
  it('first page: Previous; last page: Next; an empty field: Go', () => {
    const { rerender } = render(pager(0, 0, false))
    expect(button('Previous')).toBeDisabled()
    expect(button('Go')).toBeDisabled()
    rerender(pager(400, 400, false))
    expect(button('Next')).toBeDisabled()
  })

  it('a press that asks for the page already asked for asks nothing (a failed fetch left page 2 on screen)', () => {
    const ask = vi.fn()
    render(pager(400, PAGE, false, ask))
    fireEvent.click(button('Next'))
    expect(ask).not.toHaveBeenCalled()
  })
})
