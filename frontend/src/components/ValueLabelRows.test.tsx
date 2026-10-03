/**
 * #890 — the invalid MARKER and the error MESSAGE are one decision.
 *
 * `showError` exists (#637) because two consumers legitimately disagree about
 * WHEN an invalid state should be announced: the import wizard shows it at once
 * (its Apply is disabled and needs a reason), the retro dialog stays silent until
 * a label is typed. The marker (`aria-invalid` + `aria-describedby`) used to
 * ignore that prop entirely, so the silent consumer rendered a pristine row as
 * invalid, pointing at a message it had deliberately not rendered.
 *
 * Found by the #887 name sweep's dangling-target arm, live on the Variables view:
 * two inputs `aria-invalid="true"`, `aria-describedby="vl-labels-error"`, target
 * absent, no `role="alert"` on the page.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { ValueLabelRows, type ValueLabelRow } from './ValueLabelRows'

afterEach(cleanup)

/** A row that fails validation: a label with no code. `badRow` points at it. */
const BAD_ROWS: ValueLabelRow[] = [{ code: '', label: 'Strongly agree' }]
const BAD_VALIDATION = { ok: false as const, msg: 'Every label needs a code.', badRow: 0, payload: [] }

function renderRows(showError: boolean | undefined) {
  return render(
    <ValueLabelRows
      rows={BAD_ROWS}
      onRowsChange={() => {}}
      colType="ordinal"
      onColTypeChange={() => {}}
      validation={BAD_VALIDATION}
      showError={showError}
    />,
  )
}

/** Every `aria-describedby` on the page must point at an element that exists. */
function danglingReferences(): string[] {
  return Array.from(document.querySelectorAll('[aria-describedby]')).flatMap(el =>
    (el.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .filter(id => !document.getElementById(id)),
  )
}

describe('ValueLabelRows — the marker and the message agree (#890)', () => {
  it('announces the invalid row AND renders the message when showError is true', () => {
    renderRows(true)
    expect(screen.getByRole('alert')).toHaveTextContent('Every label needs a code.')
    expect(document.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0)
    expect(danglingReferences()).toEqual([])
  })

  it('marks NOTHING invalid when the consumer has chosen to stay silent', () => {
    // The retro-dialog case. Before the fix this rendered aria-invalid with a
    // describedby pointing at the message it deliberately withheld.
    renderRows(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0)
    expect(danglingReferences()).toEqual([])
  })

  it('never leaves a dangling aria-describedby under the default heuristic either', () => {
    // showError undefined → falls back to "has the user typed anything?", which is
    // TRUE here (there is a label), so the message shows and the marker is honest.
    renderRows(undefined)
    expect(danglingReferences()).toEqual([])
    const invalid = document.querySelectorAll('[aria-invalid="true"]')
    const alert = screen.queryByRole('alert')
    // The invariant, whichever way the heuristic falls: a marker implies a message.
    expect(invalid.length > 0).toBe(alert !== null)
  })
})

describe('ValueLabelRows — every box has its own name, and keeps it (#1104 ⚪)', () => {
  const OK = { ok: true as const, msg: '', payload: [] }
  const names = () =>
    screen.getAllByRole('textbox').map(el => el.getAttribute('aria-label'))

  it('a blank added row does not share a name with a real code', () => {
    // Four seeded codes with gaps, then an added blank row: the fifth row. Its
    // label box used to borrow the row number while the code was empty —
    // "Label for code 5" — beside the real code 5's box of the same name.
    render(
      <ValueLabelRows
        rows={[{ code: '1', label: '' }, { code: '2', label: '' }, { code: '5', label: '' },
               { code: '7', label: '' }, { code: '', label: '' }]}
        onRowsChange={() => {}} colType="ordinal" onColTypeChange={() => {}}
        validation={OK} showError={false}
      />,
    )
    const all = names()
    expect(new Set(all).size).toBe(all.length)
  })

  it('a label box is not renamed by typing a code beside it', () => {
    // A name carrying the neighbouring field's live value is changing state
    // in a name (#770): each keystroke in the code box renamed the label box.
    const view = (code: string) => (
      <ValueLabelRows
        rows={[{ code, label: '' }]}
        onRowsChange={() => {}} colType="ordinal" onColTypeChange={() => {}}
        validation={OK} showError={false}
      />
    )
    const { rerender } = render(view(''))
    const before = screen.getAllByRole('textbox').find(el => el.getAttribute('type') !== 'number')
      ?.getAttribute('aria-label')
    rerender(view('42'))
    const after = screen.getAllByRole('textbox').find(el => el.getAttribute('type') !== 'number')
      ?.getAttribute('aria-label')
    expect(before).toBeTruthy()
    expect(after).toBe(before)
  })
})
