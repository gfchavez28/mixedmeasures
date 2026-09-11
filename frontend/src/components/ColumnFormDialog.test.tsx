/**
 * #941 — what TYPE a new variable starts on.
 *
 * The *New blank table* dialog describes the feature as "for the small reference
 * tables that exist nowhere as a file, like sites, cohorts or departments", and
 * the very next dialog defaulted to **Ordinal** and offered *Strongly Disagree …
 * Strongly Agree* as its value-labels placeholder. Right for a survey, wrong for
 * the surface row 47 built.
 *
 * The default is the CALLER's decision now, because the signal is a property of
 * the dataset (has anything been imported into it?) and this component is handed
 * one column, never the table. These cases pin both directions plus the two
 * arms that must be unaffected — an edit, and the computed mode.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ColumnFormDialog, MANUAL_COLUMN_TYPES } from './ColumnFormDialog'
import type { DatasetColumn } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  datasetsApi: { previewComputed: vi.fn() },
}))

afterEach(cleanup)

const base = {
  open: true,
  onOpenChange: () => {},
  onSubmit: () => {},
  isSubmitting: false,
  submitError: null,
  title: 'Add Variable',
}

/** The type Select renders its current value as text on the trigger. */
const shownType = () => screen.getByLabelText('Type').textContent

/** What the SURFACE calls a type — `nominal` reads "Categorical" on screen. */
const labelFor = (value: string) =>
  MANUAL_COLUMN_TYPES.find(t => t.value === value)!.label

describe('the default type for a NEW manual variable', () => {
  it('is Ordinal when the caller says so — the survey case is unchanged', () => {
    render(<ColumnFormDialog {...base} defaultColumnType="ordinal" />)
    expect(shownType()).toContain('Ordinal')
  })

  it('is Categorical when the caller says so — the reference-table case', () => {
    // The surface's own word for `nominal`, taken from `MANUAL_COLUMN_TYPES`
    // rather than from the value, so this cannot drift from what is on screen.
    render(<ColumnFormDialog {...base} defaultColumnType="nominal" />)
    expect(shownType()).toContain(labelFor('nominal'))
  })

  it('falls back to Ordinal when the caller passes nothing', () => {
    // Three other call sites render this dialog and none of them is a create.
    // The fallback is what keeps them exactly as they were.
    render(<ColumnFormDialog {...base} />)
    expect(shownType()).toContain('Ordinal')
  })

  it('never overrides the type of a variable being EDITED', () => {
    // The `initial` arm comes first for a reason: a default that could win over
    // an existing value would silently retype a variable on open.
    const existing = { id: 1, column_text: 'Department', column_type: 'open_text' }
    render(
      <ColumnFormDialog
        {...base}
        initial={existing as unknown as DatasetColumn}
        defaultColumnType="nominal"
      />,
    )
    expect(shownType()).toContain(labelFor('open_text'))
  })

  it('leaves the computed mode on Numeric whatever the caller passes', () => {
    // A computed variable's type is decided by its formula's OUTPUT, not by the
    // table it sits in — and that control is a different one, labelled "Result
    // type", which is why this asserts through its own label rather than the
    // manual branch's.
    render(<ColumnFormDialog {...base} mode="computed" defaultColumnType="nominal" />)
    expect(screen.getByLabelText('Result type').textContent).toContain('Numeric')
  })
})

describe('#940 — the dialog says "variable", like the menu that opens it', () => {
  it('names its fields for a variable, not a column', () => {
    render(<ColumnFormDialog {...base} defaultColumnType="nominal" />)
    expect(screen.getByLabelText('Variable label')).toBeTruthy()
    expect(screen.getByLabelText('Variable code')).toBeTruthy()
    expect(screen.queryByLabelText('Column label')).toBeNull()
    expect(screen.queryByLabelText('Column code')).toBeNull()
  })

  it('submits with the noun the surface uses', () => {
    render(<ColumnFormDialog {...base} defaultColumnType="nominal" />)
    expect(screen.getByRole('button', { name: 'Add Variable' })).toBeTruthy()
  })
})
