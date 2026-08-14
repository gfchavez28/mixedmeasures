/**
 * buildValueLabelPayload — validation + payload for the value-labels editor
 * (#576/#577). Mirrors the backend ApplyValueLabelsRequest schema.
 *
 * Component tests (#604/#613) — the seed/enable interaction the pure validator
 * tests cannot see: a reverse-blocked column must still be able to declare
 * missing values (the seeded scale labels used to lock Apply), and seeding is
 * once-per-open (a frequencies refetch must never wipe in-progress edits).
 */
import { describeRecoveredUnmapped, describeMissingValueChanges } from '@/lib/missing-values-copy'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { DatasetColumn } from '@/lib/api/datasets'

const getFrequencies = vi.fn()
const setMissingValues = vi.fn()
const applyValueLabels = vi.fn()
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    recodeApi: {
      ...actual.recodeApi,
      getFrequencies: (...a: unknown[]) => getFrequencies(...a),
      setMissingValues: (...a: unknown[]) => setMissingValues(...a),
      applyValueLabels: (...a: unknown[]) => applyValueLabels(...a),
    },
  }
})

import {
  ValueLabelsDialog,
  buildValueLabelPayload,
} from './ValueLabelsDialog'
import { labelRowsTouched } from './ValueLabelRows'

const row = (code: string, label: string) => ({ code, label })

describe('labelRowsTouched (#637)', () => {
  it('is FALSE for seeded codes with no labels — the state the dialog opens in', () => {
    expect(labelRowsTouched([row('1', ''), row('2', ''), row('99', '')])).toBe(false)
  })

  it('is TRUE as soon as one label is typed', () => {
    expect(labelRowsTouched([row('1', 'Never'), row('2', '')])).toBe(true)
  })

  it('ignores whitespace-only labels', () => {
    expect(labelRowsTouched([row('1', '   ')])).toBe(false)
  })

  it('does NOT key on codes — the mistake it exists to prevent', () => {
    // Keying on `r.code || r.label` is what made every seeded column read as
    // touched, in two components independently.
    expect(labelRowsTouched([row('1', ''), row('2', '')])).toBe(false)
  })
})

describe('buildValueLabelPayload', () => {
  it('builds the API payload from filled rows (gapped/multi-digit codes)', () => {
    const res = buildValueLabelPayload([row('2', 'Low'), row('4', 'Mid'), row('10', 'Top')])
    expect(res.ok).toBe(true)
    expect(res.payload).toEqual([
      { value: 2, label: 'Low' },
      { value: 4, label: 'Mid' },
      { value: 10, label: 'Top' },
    ])
  })

  it('ignores fully-blank rows', () => {
    const res = buildValueLabelPayload([row('1', 'A'), row('', ''), row('2', 'B')])
    expect(res.ok).toBe(true)
    expect(res.payload).toHaveLength(2)
  })

  it('rejects a code with no label', () => {
    expect(buildValueLabelPayload([row('1', '')]).ok).toBe(false)
  })

  it('rejects a non-numeric code', () => {
    const res = buildValueLabelPayload([row('x', 'A')])
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('not a number')
  })

  it('rejects duplicate codes', () => {
    const res = buildValueLabelPayload([row('1', 'A'), row('1', 'B')])
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('once')
  })

  it('rejects duplicate labels (case-insensitive)', () => {
    const res = buildValueLabelPayload([row('1', 'Agree'), row('2', 'agree')])
    expect(res.ok).toBe(false)
    expect(res.msg).toContain('distinct')
  })

  it('rejects an all-empty form', () => {
    expect(buildValueLabelPayload([row('', '')]).ok).toBe(false)
  })

  it('accepts a 0-based code (a scale point of 0)', () => {
    const res = buildValueLabelPayload([row('0', 'None'), row('1', 'Some')])
    expect(res.ok).toBe(true)
    expect(res.payload?.[0]).toEqual({ value: 0, label: 'None' })
  })
})

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const BASE_COLUMN: DatasetColumn = {
  id: 31,
  column_code: 'C001',
  column_name: 'anxiety',
  group_code: null,
  group_label: null,
  column_text: 'How anxious do you feel?',
  column_type: 'ordinal',
  sequence_order: 1,
  scale_labels: null,
  scale_values: null,
  missing_values: null,
  scale_points: null,
  numeric_min: 1,
  numeric_max: 5,
  numeric_format: null,
  source: 'imported',
}

const FREQ = (values: string[]) => ({
  frequencies: values.map(v => ({ value_text: v, count: 3, is_na: false })),
})

function renderDialog(column: DatasetColumn) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ValueLabelsDialog
          column={column}
          open
          projectId={1}
          datasetId={2}
          onClose={onClose}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return { qc, onClose }
}

describe('ValueLabelsDialog (component)', () => {
  it('#604: a reverse-blocked column with scale metadata can still declare missing values', async () => {
    getFrequencies.mockResolvedValue(FREQ(['Never', 'Always']))
    setMissingValues.mockResolvedValue({
      column_id: 31, missing_values: [{ value: '99' }], nulled_rows: 1,
      labelled_rows: 0, stripped_scale_points: 0, recovered_rows: 0,
      recovered_values: [], recovered_unmapped: [],
    })
    const { onClose } = renderDialog({
      ...BASE_COLUMN,
      // The #604 blind spot: reverse primary AND scale metadata (every typical
      // reverse-scored ordinal — write_back_scale_metadata runs for all types).
      scale_labels: ['Never', 'Always'],
      scale_values: [1, 5],
      recode_definitions: [{
        id: 9, name: 'Reverse anxiety', recode_type: 'reverse',
        output_type: 'numeric', mapping: { Never: 1, Always: 5 },
        exclude_values: null, is_primary: true, is_auto_detected: false,
        source_definition_id: null,
      }],
    })

    // The labels arm is blocked (rejection, not concealment)…
    await screen.findByTestId('value-labels-reverse-block')

    // …but a missing declaration must still be possible: pick "These values"
    // (which seeds a blank row) and type "99".
    fireEvent.click(screen.getByRole('tab', { name: 'These values' }))
    fireEvent.change(screen.getByLabelText('Missing value code for row 1'), {
      target: { value: '99' },
    })

    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeEnabled()
    fireEvent.click(apply)

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(setMissingValues).toHaveBeenCalledWith(1, 2, 31, [{ value: '99' }])
    expect(applyValueLabels).not.toHaveBeenCalled()
  })

  it('#613: a frequencies refetch mid-edit does not wipe typed rows', async () => {
    // The refetch must return CHANGED data (counts drifted — an append ran in
    // another tab): TanStack's structural sharing keeps the old identity for a
    // byte-identical refetch, so identical data never re-ran the seed even
    // pre-fix. Changed data is the honest repro.
    let call = 0
    getFrequencies.mockImplementation(() => {
      call += 1
      const data = FREQ(['1', '2', '99'])
      data.frequencies.forEach(f => { f.count = 3 + call })
      return Promise.resolve(data)
    })
    const { qc } = renderDialog(BASE_COLUMN)

    // Label rows seed from the first frequencies response.
    const labelInput = await screen.findByLabelText('Label for code 1')
    fireEvent.change(labelInput, { target: { value: 'Never' } })
    fireEvent.click(screen.getByRole('tab', { name: 'These values' }))
    fireEvent.change(screen.getByLabelText('Missing value code for row 1'), {
      target: { value: '99' },
    })

    // A >60s window refocus refetches the frequencies query; the seed effect
    // must NOT re-run on the new data identity.
    await qc.invalidateQueries()
    await waitFor(() => expect(getFrequencies).toHaveBeenCalledTimes(2))

    expect(screen.getByLabelText('Label for code 1')).toHaveValue('Never')
    expect(screen.getByLabelText('Missing value code for row 1')).toHaveValue('99')
  })

  it('#609: "Nothing missing" declares [] — a real declaration, not an un-declare', async () => {
    getFrequencies.mockResolvedValue(FREQ(['1', '2']))
    setMissingValues.mockResolvedValue({
      column_id: 31, missing_values: [], nulled_rows: 0, labelled_rows: 0,
      stripped_scale_points: 0, recovered_rows: 2, recovered_values: ['N/A'],
      recovered_unmapped: [],
    })
    const { onClose } = renderDialog(BASE_COLUMN)

    await screen.findByLabelText('Label for code 1')
    fireEvent.click(screen.getByRole('tab', { name: 'Nothing missing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(setMissingValues).toHaveBeenCalledWith(1, 2, 31, [])
  })

  it('#608: readers are invalidated even when the mutation fails (finally, not success-only)', async () => {
    getFrequencies.mockResolvedValue(FREQ(['1', '2']))
    setMissingValues.mockRejectedValue(new Error('boom'))
    const { qc, onClose } = renderDialog(BASE_COLUMN)
    const invalidate = vi.spyOn(qc, 'invalidateQueries')

    await screen.findByLabelText('Label for code 1')
    fireEvent.click(screen.getByRole('tab', { name: 'Nothing missing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    // A partial/failed apply may still have landed server-side state; the
    // dialog stays open, but every reader must be marked stale regardless.
    await waitFor(() => expect(invalidate).toHaveBeenCalled())
    const roots = invalidate.mock.calls.map(
      c => (c[0] as { queryKey: unknown[] } | undefined)?.queryKey?.[0],
    )
    expect(roots).toContain('dataset-data')
    expect(roots).toContain('dq-summary')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('#637: the labels error and the Apply button must agree', () => {
  it('says nothing on mount, and Apply stays enabled for the missing-only path', async () => {
    // Numeric cells => rows seed with codes and EMPTY labels. Before the fix the
    // announcement keyed on "a code exists", so it fired here — telling the
    // researcher off for work they had not done, while Apply sat enabled.
    getFrequencies.mockResolvedValue(FREQ(['1', '2', '3']))
    renderDialog(BASE_COLUMN)

    await waitFor(() => expect(screen.getByTestId('missing-values-section')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })

  it('announces once a label is typed, and Apply blocks for the SAME reason', async () => {
    getFrequencies.mockResolvedValue(FREQ(['1', '2', '3']))
    renderDialog(BASE_COLUMN)

    await waitFor(() => expect(screen.getByTestId('missing-values-section')).toBeInTheDocument())

    // One label filled, the others still blank => a genuinely incomplete set.
    const labelInputs = screen
      .getAllByRole('textbox')
      .filter(el => /label/i.test(el.getAttribute('aria-label') || ''))
    expect(labelInputs.length).toBeGreaterThan(0)
    fireEvent.change(labelInputs[0], { target: { value: 'Never' } })

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })
})

describe('describeRecoveredUnmapped (#609d)', () => {
  it('is grammatical for one value', () => {
    expect(describeRecoveredUnmapped(['N/A']))
      .toBe('"N/A" became data again but has no code yet.')
  })

  it('caps the list at 5 and pluralizes', () => {
    const msg = describeRecoveredUnmapped(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(msg).toContain('+2 more')
    expect(msg).toContain('have no codes yet')
    expect(msg).not.toContain('"f"')
  })
})


describe('describeMissingValueChanges (#680)', () => {
  const base = { nulled_rows: 0, labelled_rows: 0, stripped_scale_points: 0, recovered_rows: 0 }

  it('says nothing when nothing changed, so the caller keeps its plain success', () => {
    expect(describeMissingValueChanges(base)).toBeNull()
  })

  it('reports cells removed from analysis', () => {
    expect(describeMissingValueChanges({ ...base, nulled_rows: 47 }))
      .toBe('47 cells no longer counted in analysis.')
  })

  /**
   * The one that matters: `labelled_rows` is a SUBSET of `nulled_rows`
   * (`schemas/recode.py:201`). Rendering them as siblings would say 94 cells
   * were touched when 47 were — an overstatement in a disclosure about the
   * researcher's own data.
   */
  it('renders relabelled cells as a qualifier, never as a second population', () => {
    const msg = describeMissingValueChanges({ ...base, nulled_rows: 47, labelled_rows: 12 })!
    expect(msg).toBe('47 cells no longer counted in analysis, 12 relabelled.')
    expect(msg).not.toMatch(/12 cells/)
  })

  it('reports recovery on un-declare', () => {
    expect(describeMissingValueChanges({ ...base, recovered_rows: 12 }))
      .toBe('12 cells counted again.')
  })

  it('reports stripped scale points', () => {
    expect(describeMissingValueChanges({ ...base, nulled_rows: 3, stripped_scale_points: 1 }))
      .toBe('3 cells no longer counted in analysis; 1 scale point removed.')
  })

  it('pluralises every count independently (#640 was "Preview (1 rows)")', () => {
    expect(describeMissingValueChanges({ ...base, nulled_rows: 1, stripped_scale_points: 2 }))
      .toBe('1 cell no longer counted in analysis; 2 scale points removed.')
    expect(describeMissingValueChanges({ ...base, recovered_rows: 1 }))
      .toBe('1 cell counted again.')
  })
})
