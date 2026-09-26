import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { CodeSet, CodeSetMember } from '@/lib/api'
import { CodeSetPicker } from '@/components/CodeSetPicker'

afterEach(cleanup)

const member = (id: number, name: string, over: Partial<CodeSetMember> = {}): CodeSetMember => ({
  id, numeric_id: id, name, description: null, color: null,
  is_active: true, is_universal: false, ...over,
})

const STANCE: CodeSet = {
  id: 7, project_id: 1, label: 'Stance', description: null, exhaustive: false,
  members: [member(11, 'Positive'), member(23, 'Negative'), member(47, 'Neutral')],
  set_basis: 'inclusive_with_none', composition_warnings: [],
  created_at: '', updated_at: '',
}

const EXHAUSTIVE: CodeSet = {
  ...STANCE, exhaustive: true, set_basis: 'exhaustive_with_missing',
}

function setup(props: Partial<React.ComponentProps<typeof CodeSetPicker>> = {}) {
  const onSelect = vi.fn()
  render(
    <CodeSetPicker set={STANCE} selectedCodeId={null} onSelect={onSelect} {...props} />,
  )
  return { onSelect }
}

describe('what it announces', () => {
  it('is ONE radiogroup named by the set', () => {
    setup()
    expect(screen.getByRole('radiogroup', { name: 'Stance' })).toBeInTheDocument()
    // Not N toggle buttons: the whole point is that a reader can learn choosing
    // one value clears another.
    expect(screen.queryAllByRole('button', { name: /^Positive$/ })).toHaveLength(0)
  })

  it('gives EVERY value an aria-checked, not only the chosen one', () => {
    setup({ selectedCodeId: 23 })
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    // An omitted `false` is a MISSING state, not a false one — so assert the
    // attribute is present on all three, not merely that one is true.
    for (const radio of radios) {
      expect(radio).toHaveAttribute('aria-checked')
    }
    expect(screen.getByRole('radio', { name: 'Negative' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Positive' })).not.toBeChecked()
  })

  it('names each value for the value it selects, and nothing else', () => {
    // #912: a name is a claim about the ACT. "Apply Negative" would be false of
    // a control that also clears Positive.
    setup({ selectedCodeId: 11 })
    expect(screen.getByRole('radio', { name: 'Negative' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /apply/i })).toBeNull()
  })

  it('does not put the clear button inside the radiogroup', () => {
    // A radiogroup may own only radios; a plain button among them is invalid
    // ARIA and a reader counting the options would either include it or drop it.
    setup()
    const group = screen.getByRole('radiogroup', { name: 'Stance' })
    const clear = screen.getByRole('button', { name: /none of these/i })
    expect(group.contains(clear)).toBe(false)
  })
})

describe('the clear control', () => {
  it('exists as a REAL named control, not "press it again"', () => {
    setup({ selectedCodeId: 11 })
    const clear = screen.getByRole('button', { name: 'None of these for Stance' })
    expect(clear).toBeEnabled()
  })

  it('says something different on an exhaustive set', () => {
    // Clearing an inclusive set MEANS "none of these"; clearing an exhaustive
    // one means "not yet decided". Same act, different claim.
    const onSelect = vi.fn()
    render(<CodeSetPicker set={EXHAUSTIVE} selectedCodeId={11} onSelect={onSelect} />)
    expect(
      screen.getByRole('button', { name: 'Clear Stance — not yet decided' }),
    ).toBeInTheDocument()
  })

  it('is disabled when there is nothing to clear', () => {
    setup({ selectedCodeId: null })
    expect(screen.getByRole('button', { name: /none of these/i })).toBeDisabled()
  })

  it('clears through the same callback', () => {
    const { onSelect } = setup({ selectedCodeId: 47 })
    fireEvent.click(screen.getByRole('button', { name: /none of these/i }))
    expect(onSelect).toHaveBeenCalledWith(null)
  })
})

describe('choosing', () => {
  it('selects an unselected value', () => {
    const { onSelect } = setup({ selectedCodeId: null })
    fireEvent.click(screen.getByRole('radio', { name: 'Neutral' }))
    expect(onSelect).toHaveBeenCalledWith(47)
  })

  it('clears when the selected value is pressed again', () => {
    const { onSelect } = setup({ selectedCodeId: 47 })
    fireEvent.click(screen.getByRole('radio', { name: 'Neutral' }))
    expect(onSelect).toHaveBeenCalledWith(null)
  })
})

describe('the keyboard', () => {
  it('costs ONE tab stop, on the checked value', () => {
    setup({ selectedCodeId: 23 })
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  })

  it('falls back to the first value when nothing is chosen', () => {
    // Otherwise an unanswered set has no tabbable value and the keyboard cannot
    // reach it at all — #701(a)'s closed loop.
    setup({ selectedCodeId: null })
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('tabindex')))
      .toEqual(['0', '-1', '-1'])
  })

  it('moves focus with arrows and WRAPS', () => {
    setup({ selectedCodeId: null })
    const radios = screen.getAllByRole('radio')
    radios[0].focus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(radios[1]).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(radios[0]).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(radios[2]).toHaveFocus()
  })

  it('does NOT select as focus moves', () => {
    // Committing fires a request that clears another application, so arrowing
    // through the values would write four times on the way to the fifth.
    const { onSelect } = setup({ selectedCodeId: null })
    screen.getAllByRole('radio')[0].focus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('CLAIMS an unmatched printable key so it cannot arm a code chord', () => {
    // ⚠️ The positive form first: the handler must actually receive the event.
    // A `not.toHaveBeenCalled()` on a query that never matches is
    // indistinguishable from a pass (#770's rule).
    setup({ selectedCodeId: null })
    const radio = screen.getAllByRole('radio')[0]
    const digit = new KeyboardEvent('keydown', { key: '7', bubbles: true, cancelable: true })
    radio.dispatchEvent(digit)
    expect(digit.defaultPrevented).toBe(true)

    // …and a MODIFIER chord passes through, so Ctrl+Z stays undo.
    const undo = new KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    })
    radio.dispatchEvent(undo)
    expect(undo.defaultPrevented).toBe(false)
  })

  it('does NOT claim Space, which is how a radio and a button are activated (#1041)', () => {
    // `' '` is one character long, so the printable claim used to cancel it —
    // measured live, Space chose nothing on any value or on the clear control.
    // The digit beside it is the positive control: the claim still runs.
    setup({ selectedCodeId: 11 })
    for (const control of [
      screen.getByRole('radio', { name: 'Negative' }),
      screen.getByRole('button', { name: 'None of these for Stance' }),
    ]) {
      const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
      control.dispatchEvent(space)
      expect(space.defaultPrevented).toBe(false)
      const digit = new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true })
      control.dispatchEvent(digit)
      expect(digit.defaultPrevented).toBe(true)
    }
  })
})

describe('while a choice is being saved (#1041)', () => {
  it('is aria-disabled, never natively disabled — Chrome blurs a focused disabled control', () => {
    // Measured live: every press dropped focus to <body> ~300 ms later, because
    // the pending state set `disabled` on the button the coder had just pressed.
    setup({ selectedCodeId: 11, busy: true })
    const controls = [
      ...screen.getAllByRole('radio'),
      screen.getByRole('button', { name: 'None of these for Stance' }),
    ]
    for (const control of controls) {
      expect(control).toHaveAttribute('aria-disabled', 'true')
      expect(control).not.toHaveAttribute('disabled')
    }
    // Still one reachable tab stop on the checked value.
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('tabindex')))
      .toEqual(['0', '-1', '-1'])
  })

  it('ignores a press — the plan would be built from a state about to change', () => {
    const { onSelect } = setup({ selectedCodeId: 11, busy: true })
    fireEvent.click(screen.getByRole('radio', { name: 'Negative' }))
    fireEvent.click(screen.getByRole('button', { name: 'None of these for Stance' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('carries no aria-disabled when idle (positive control)', () => {
    setup({ selectedCodeId: 11 })
    expect(screen.getByRole('radio', { name: 'Negative' })).not.toHaveAttribute('aria-disabled')
  })
})

describe('where focus goes after "None" (#1041)', () => {
  function renderControlled(selectedCodeId: number | null) {
    const onSelect = vi.fn()
    const view = render(
      <CodeSetPicker set={STANCE} selectedCodeId={selectedCodeId} onSelect={onSelect} />,
    )
    const rerenderWith = (next: number | null) =>
      view.rerender(<CodeSetPicker set={STANCE} selectedCodeId={next} onSelect={onSelect} />)
    return { onSelect, rerenderWith }
  }

  it('lands on the group’s tab stop once the clear has landed', () => {
    // The clear control disables itself when there is nothing left to clear,
    // which blurs it; the next choice is made in the group, so focus goes there.
    const { rerenderWith } = renderControlled(23)
    const clear = screen.getByRole('button', { name: 'None of these for Stance' })
    clear.focus()
    fireEvent.click(clear)
    rerenderWith(null)
    expect(clear).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Positive' })).toHaveFocus()
  })

  it('does NOT move focus when the value is cleared some other way (an undo)', () => {
    const { rerenderWith } = renderControlled(23)
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    rerenderWith(null)
    expect(elsewhere).toHaveFocus()
    elsewhere.remove()
  })

  it('does NOT pull focus off <body> for a clear nobody pressed here', () => {
    // The case the "was it pressed?" flag exists for. Focus on <body> is the
    // workbench's own ("focus nowhere → ours", #789): the next ArrowDown moves
    // the transcript. An undo that happens to clear this set must not quietly
    // move that key into the picker. (The case above is protected by the
    // focus check alone, which is why it could not tell the flag was missing.)
    const { rerenderWith } = renderControlled(23)
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    rerenderWith(null)
    expect(document.activeElement).toBe(document.body)
  })

  it('does NOT pull focus back if the coder has already moved on', () => {
    const { rerenderWith } = renderControlled(23)
    fireEvent.click(screen.getByRole('button', { name: 'None of these for Stance' }))
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    rerenderWith(null)
    expect(elsewhere).toHaveFocus()
    elsewhere.remove()
  })
})

describe('the contradiction notice', () => {
  it('is silent in the ordinary case', () => {
    setup({ selectedCodeId: 11 })
    expect(screen.queryByText(/two values/i)).toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'Stance' }))
      .not.toHaveAttribute('aria-describedby')
  })

  it('describes the GROUP rather than shouting as an alert', () => {
    // Persistent state, not something that just happened: an assertive live
    // region would announce on every mount of a passage that has been in this
    // condition since a merge.
    setup({ selectedCodeId: 11, multipleSelected: true })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'Stance' }))
      .toHaveAccessibleDescription(/two values of “stance” are on this passage/i)
  })
})

describe('inactive values', () => {
  it('are not offered, mirroring the server’s refusal', () => {
    const onSelect = vi.fn()
    render(
      <CodeSetPicker
        set={{ ...STANCE, members: [...STANCE.members, member(88, 'Mixed', { is_active: false })] }}
        selectedCodeId={null}
        onSelect={onSelect}
      />,
    )
    expect(screen.queryByRole('radio', { name: 'Mixed' })).toBeNull()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it('render nothing at all when a set has no choosable value left', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <CodeSetPicker
        set={{ ...STANCE, members: [member(88, 'Mixed', { is_active: false })] }}
        selectedCodeId={null}
        onSelect={onSelect}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
