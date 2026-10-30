/**
 * #1319 / D5 — the dialog that shows a text edit's flagged quotes before saving.
 *
 * What it must do: name every quote the edit touches, runs across or removes —
 * with its words before and after — in the accessible DESCRIPTION (a sentence
 * outside it is on screen and silent, #955 d); offer "keep as shown" only when it
 * can succeed; and answer exactly once per opening (an Action's click is followed
 * by the Root's close).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { TextEditPlan, TextEditQuote } from '@/lib/api/segments'
import { TextEditQuotesDialog } from './TextEditQuotesDialog'

afterEach(cleanup)

const quote = (over: Partial<TextEditQuote>): TextEditQuote => ({
  excerpt_id: 1, outcome: 'silent', old_start: 0, old_end: 5, new_start: 0, new_end: 5,
  old_text: 'alpha', new_text: 'alpha', has_note: false, removed: false, explicit: false,
  ...over,
})

const PLAN: TextEditPlan = {
  text: 'Honestly, it was not helpful whatsoever.',
  quotes: [
    quote({ excerpt_id: 1, outcome: 'silent', old_text: 'Honestly', new_text: 'Honestly' }),
    quote({ excerpt_id: 2, outcome: 'edge', old_text: 'not helpfull', new_text: 'not helpful', has_note: true }),
    quote({ excerpt_id: 3, outcome: 'gone', old_text: 'at all', new_text: null, new_start: null, new_end: null }),
  ],
  needs_confirmation: true,
  collisions: [],
  capped: false,
}

describe('TextEditQuotesDialog', () => {
  it('names each flagged quote, before and after, inside the description — and not the silent one', () => {
    render(<TextEditQuotesDialog plan={PLAN} onChoose={vi.fn()} />)
    const dialog = screen.getByRole('alertdialog', { name: 'This edit changes quoted words' })
    expect(dialog).toHaveAccessibleDescription(/2 quotes on this passage would change/)
    expect(dialog).toHaveAccessibleDescription(/“not helpfull”.*“not helpful”/)
    expect(dialog).toHaveAccessibleDescription(/“at all”.*removed/)
    expect(dialog).toHaveAccessibleDescription(/It has a note/)
    expect(dialog).not.toHaveAccessibleDescription(/Honestly/)
  })

  it('keep as shown answers "keep", once', () => {
    const onChoose = vi.fn()
    render(<TextEditQuotesDialog plan={PLAN} onChoose={onChoose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep as shown and save' }))
    expect(onChoose.mock.calls[0]).toEqual(['keep'])
  })

  it('remove answers "remove"', () => {
    const onChoose = vi.fn()
    render(<TextEditQuotesDialog plan={PLAN} onChoose={onChoose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove 2 quotes and save' }))
    expect(onChoose.mock.calls[0]).toEqual(['remove'])
  })

  it('Cancel and Escape answer "cancel"', () => {
    const onChoose = vi.fn()
    const { unmount } = render(<TextEditQuotesDialog plan={PLAN} onChoose={onChoose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onChoose).toHaveBeenLastCalledWith('cancel')
    unmount()
    const onChoose2 = vi.fn()
    render(<TextEditQuotesDialog plan={PLAN} onChoose={onChoose2} />)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onChoose2).toHaveBeenLastCalledWith('cancel')
  })

  it('opens with focus on Cancel, the safe choice', () => {
    render(<TextEditQuotesDialog plan={PLAN} onChoose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('does not offer "keep" when two quotes would land on the same words, and says why', () => {
    render(<TextEditQuotesDialog plan={{ ...PLAN, collisions: [[2, 5]] }} onChoose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Keep as shown and save' })).not.toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(/cannot all be kept/)
    expect(screen.getByRole('button', { name: 'Remove 2 quotes and save' })).toBeInTheDocument()
  })

  it('does not offer "keep" when every flagged quote is gone', () => {
    const onlyGone = { ...PLAN, quotes: [PLAN.quotes[2]] }
    render(<TextEditQuotesDialog plan={onlyGone} onChoose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Keep as shown and save' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove the quote and save' })).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(/One quote .* Saving removes them/)
  })

  it('says when the change was too long to follow word by word', () => {
    render(<TextEditQuotesDialog plan={{ ...PLAN, capped: true }} onChoose={vi.fn()} />)
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(/could not be followed word by word/)
  })

  // #1492 — technique only: jsdom resolves no Tailwind and computes no colour, so
  // the colour itself was checked live in both themes; these pin the classes that
  // produce it. The outline variant sets no text colour of its own and must
  // INHERIT the dialog's, so the default's `text-primary-foreground` must be gone.
  it('#1492 (a): the remove action is the OUTLINE variant, with no default text colour left on it', () => {
    render(<TextEditQuotesDialog plan={PLAN} onChoose={vi.fn()} />)
    const remove = screen.getByRole('button', { name: 'Remove 2 quotes and save' })
    expect(remove.className).toContain('bg-background')
    expect(remove.className).not.toContain('text-primary-foreground')
    expect(remove.className).not.toContain('bg-primary')
    // The primary choice keeps the default (filled) variant.
    const keep = screen.getByRole('button', { name: 'Keep as shown and save' })
    expect(keep.className).toContain('bg-primary')
    expect(keep.className).toContain('text-primary-foreground')
  })

  it('#1492 (a): with nothing keepable, remove is the one filled action', () => {
    const onlyGone = { ...PLAN, quotes: [PLAN.quotes[2]] }
    render(<TextEditQuotesDialog plan={onlyGone} onChoose={vi.fn()} />)
    const remove = screen.getByRole('button', { name: 'Remove the quote and save' })
    expect(remove.className).toContain('bg-primary')
    expect(remove.className).toContain('text-primary-foreground')
  })

  it('#1492 (b): the footer wraps rather than scrolling the dialog sideways', () => {
    render(<TextEditQuotesDialog plan={PLAN} onChoose={vi.fn()} />)
    const footer = screen.getByRole('button', { name: 'Cancel' }).parentElement!
    expect(footer.className).toContain('sm:flex-wrap')
    expect(footer.className).toContain('gap-2')
    // `space-x` indents a wrapped row; the footer's own `sm:space-x-2` must be gone.
    expect(footer.className).not.toContain('sm:space-x-2')
  })

  it('is closed with no plan', () => {
    render(<TextEditQuotesDialog plan={null} onChoose={vi.fn()} />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
