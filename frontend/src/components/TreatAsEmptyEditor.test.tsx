/**
 * `TreatAsEmptyEditor` — the UI half of the project's non-response vocabulary
 * (#816).
 *
 * The three states are the whole point, and two of them are easy to make
 * unreachable: `[]` ("only a genuinely blank cell counts") and `null` ("go back
 * to the standard list"). A control that can only ever send a non-empty list
 * looks complete and silently removes two declarations a researcher can make.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import TreatAsEmptyEditor from './TreatAsEmptyEditor'

const DEFAULTS = ['N/A', 'n/a', 'NA', 'No response', 'None', '-', '.']

function setup(props: Partial<React.ComponentProps<typeof TreatAsEmptyEditor>> = {}) {
  const onChange = vi.fn()
  render(
    <TreatAsEmptyEditor
      values={DEFAULTS}
      isDefault
      onChange={onChange}
      {...props}
    />,
  )
  return { onChange }
}

/** The section is a disclosure — open it before asserting on its contents. */
function open() {
  fireEvent.click(screen.getByRole('button', { name: /what counts as no response/i }))
}

afterEach(cleanup)

describe('TreatAsEmptyEditor', () => {
  it('is a real disclosure, not a div that toggles', () => {
    setup()

    const trigger = screen.getByRole('button', { name: /what counts as no response/i })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls')
  })

  it('🔴 names each remove button after ITS OWN value', () => {
    // #559/#785: N buttons called "Remove" say nothing about which. This list
    // is exactly the shape that invites one shared label.
    setup()
    open()

    for (const value of DEFAULTS) {
      expect(
        screen.getByRole('button', { name: `Remove "${value}" from non-responses` }),
        `"${value}" needs a remove button that names it`,
      ).toBeInTheDocument()
    }
  })

  it('removing a value sends the rest', () => {
    const { onChange } = setup()
    open()

    fireEvent.click(screen.getByRole('button', { name: 'Remove "None" from non-responses' }))

    expect(onChange).toHaveBeenCalledWith(DEFAULTS.filter(v => v !== 'None'))
  })

  it('🔴 removing the LAST value reaches the empty declaration', () => {
    // `[]` is a real state — "only a genuinely blank cell counts as no
    // response" — and it is the one a control built around "add values" tends
    // to make unreachable.
    const { onChange } = setup({ values: ['N/A'], isDefault: false })
    open()

    fireEvent.click(screen.getByRole('button', { name: 'Remove "N/A" from non-responses' }))

    expect(onChange).toHaveBeenCalledWith([])
  })

  it('says what an empty declaration means rather than rendering nothing', () => {
    setup({ values: [], isDefault: false })
    open()

    expect(screen.getByText(/only a genuinely empty cell/i)).toBeInTheDocument()
  })

  it('adds a typed value', () => {
    const { onChange } = setup({ values: ['N/A'], isDefault: false })
    open()

    fireEvent.change(screen.getByLabelText('Add an answer'), { target: { value: 'Declined' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }))

    expect(onChange).toHaveBeenCalledWith(['N/A', 'Declined'])
  })

  it('refuses a duplicate and SAYS why the button is off', () => {
    // A disabled control with no explanation reads as broken — and the value
    // is visible in the list right above, so the researcher has no way to tell
    // "already there" from "this is not working".
    const { onChange } = setup({ values: ['N/A'], isDefault: false })
    open()

    fireEvent.change(screen.getByLabelText('Add an answer'), { target: { value: 'N/A' } })

    expect(screen.getByRole('button', { name: /^Add$/ })).toBeDisabled()
    expect(screen.getByText(/is already counted as no response/i)).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('🔴 sends null — not an empty list — to reset to the standard list', () => {
    // The two are DIFFERENT instructions on the wire: `null` restores the
    // defaults, `[]` declares that nothing but a blank cell is empty. Sending
    // the wrong one here silently declares the opposite of what the button says.
    const { onChange } = setup({ values: ['Declined'], isDefault: false })
    open()

    fireEvent.click(screen.getByRole('button', { name: /use the standard list/i }))

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('offers no reset when the standard list is already in effect', () => {
    // ⚠️ Keyed on the SERVER's `isDefault`, never on comparing the values
    // against a client-side copy of the defaults.
    setup({ values: DEFAULTS, isDefault: true })
    open()

    expect(screen.queryByRole('button', { name: /use the standard list/i })).toBeNull()
  })

  it('states the consequence in the units rendered beside it', () => {
    // The disclosure #519 left open: adding a value moves the response counts
    // in the picker directly above this control.
    setup()
    open()

    expect(screen.getByText(/excluded from the response counts above/i)).toBeInTheDocument()
  })
})
