import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Palette } from 'lucide-react'
import OptionRow from './OptionRow'

afterEach(cleanup)

/**
 * #900/#906 — `OptionRow` decides how its contents are NAMED, not only how they
 * are laid out.
 *
 * jsdom computes accessible names from `<label>` association and `aria-label`
 * correctly (it is DESCRIPTIONS it cannot do — the internal design notes),
 * so this is the right channel for these two properties. The browser sweep is
 * still what verifies the CALL SITES; this pins the component contract they rely on.
 */
describe('OptionRow (#900)', () => {
  it('names a single control by wrapping it — the fourth naming route', () => {
    // This is why `Color palette` and `Data labels` announce correctly while
    // carrying no aria-label, no aria-labelledby and no htmlFor (#889 recorded
    // three routes; the wrapping <label> is a fourth).
    render(
      <OptionRow icon={Palette} label="Color palette">
        <button type="button">Default</button>
      </OptionRow>,
    )
    expect(screen.getByRole('button', { name: 'Color palette' })).toBeInTheDocument()
  })

  it('fullWidth names the GROUP, so the caption is not lost', () => {
    render(
      <OptionRow icon={Palette} label="Fonts" fullWidth>
        <button type="button" aria-label="Label text size">
          12px
        </button>
      </OptionRow>,
    )
    // The group carries the caption...
    expect(screen.getByRole('group', { name: 'Fonts' })).toBeInTheDocument()
    // ...and the control still names itself, which is the half the group cannot do.
    expect(screen.getByRole('button', { name: 'Label text size' })).toBeInTheDocument()
  })

  it('fullWidth does NOT name its children — every control must name itself', () => {
    // The regression this guards: `fullWidth` reads as a layout switch, so a new
    // call site can reasonably assume the caption names what is inside it. It
    // does not, and that is #900 — seven chart-formatting selects announced as a
    // bare `combobox` with only their value.
    render(
      <OptionRow icon={Palette} label="Fonts" fullWidth>
        <button type="button">12px</button>
      </OptionRow>,
    )
    expect(screen.queryByRole('button', { name: 'Fonts' })).toBeNull()
    expect(screen.getByRole('button', { name: '12px' })).toBeInTheDocument()
  })

  it('the default branch names only its FIRST control, and that name ABSORBS the second — #906', () => {
    // `Axis range` passed two <Input>s to the default branch. Measured here
    // rather than reasoned: the first input's accessible name comes out
    // **"Axis range 9"** — the caption plus the SECOND input's value, because a
    // <label>'s name is computed from its whole subtree and an embedded control
    // contributes its value. So the minimum's name changed whenever the maximum
    // was edited, and the maximum fell through to its placeholder.
    //
    // This is the same mechanism as #902's `checkbox "Student_ID Identifier"`,
    // reached from inside a shared component instead of at a call site — which is
    // why a same-file source scan cannot see it: the <label> is here and the two
    // controls arrive as `children` from ChartOptionsPanel.
    render(
      <OptionRow icon={Palette} label="Axis range">
        <>
          <input type="number" defaultValue="1" />
          <input type="number" defaultValue="9" />
        </>
      </OptionRow>,
    )
    const [first, second] = screen.getAllByRole('spinbutton')
    expect(first).toHaveAccessibleName('Axis range 9')
    expect(second).toHaveAccessibleName('')

    // ...and the fix: an explicit name on each is immune to both halves.
    cleanup()
    render(
      <OptionRow icon={Palette} label="Axis range">
        <>
          <input type="number" aria-label="Axis range minimum" defaultValue="1" />
          <input type="number" aria-label="Axis range maximum" defaultValue="9" />
        </>
      </OptionRow>,
    )
    expect(screen.getByRole('spinbutton', { name: 'Axis range minimum' })).toHaveValue(1)
    expect(screen.getByRole('spinbutton', { name: 'Axis range maximum' })).toHaveValue(9)
  })
})
