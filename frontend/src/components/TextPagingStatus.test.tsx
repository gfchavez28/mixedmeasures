import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import TextPagingStatus from './TextPagingStatus'

afterEach(cleanup)

const props = {
  loaded: 200, total: 450, hasMore: true, isLoadingMore: false, onLoadMore: () => {},
}

describe('TextPagingStatus', () => {
  it('names the remainder in the button, with the row’s own noun (#969)', () => {
    render(<TextPagingStatus {...props} noun={{ one: 'clip', many: 'clips' }} />)
    expect(screen.getByText('Showing 200 of 450 clips')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more clips — 250 remaining' })).toBeInTheDocument()
  })

  it('🔴 stays FOCUSABLE while it loads — aria-disabled, never disabled (#965)', () => {
    // Chrome blurs a focused button that becomes `disabled`, so a keyboard press
    // dropped focus to <body> mid-request.
    const onLoadMore = vi.fn()
    render(<TextPagingStatus {...props} isLoadingMore onLoadMore={onLoadMore} />)
    const button = screen.getByRole('button', { name: /Load more/ })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(button)
    expect(onLoadMore).not.toHaveBeenCalled()   // the guard is the half that refuses
  })

  it('🔴 when the LAST page lands, focus moves to the count instead of falling to <body>', () => {
    const { rerender } = render(<TextPagingStatus {...props} />)
    const button = screen.getByRole('button', { name: /Load more/ })
    button.focus()
    fireEvent.click(button)
    rerender(<TextPagingStatus {...props} loaded={450} hasMore={false} />)
    expect(document.activeElement).toBe(screen.getByText('All 450 responses loaded'))
  })

  it('…and takes no focus when the press did not come from the button (positive control)', () => {
    const { rerender } = render(<TextPagingStatus {...props} />)
    rerender(<TextPagingStatus {...props} loaded={450} hasMore={false} />)
    expect(document.activeElement).toBe(document.body)
  })

  it('says a FAILED next page beside the button; the button keeps its one name (#770)', () => {
    render(<TextPagingStatus {...props} loadFailed />)
    expect(screen.getByText(/the next responses could not be loaded/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more responses — 250 remaining' })).toBeInTheDocument()
  })

  it('#1038 (i) — while the previous filter’s rows are held it states no count and offers nothing', () => {
    render(<TextPagingStatus {...props} updating />)
    expect(screen.getByText('Updating for the new filter…')).toBeInTheDocument()
    expect(screen.queryByText(/Showing/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
