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
