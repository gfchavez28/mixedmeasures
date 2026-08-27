import { describe, it, expect } from 'vitest'
import { valueLabelBlocker } from './value-labels-guard'
import type { RecodeDefinitionSummary } from '@/lib/api/datasets'

const def = (o: Partial<RecodeDefinitionSummary>): RecodeDefinitionSummary => ({
  id: 1,
  name: 'D',
  recode_type: 'scale_map',
  output_type: 'numeric',
  mapping: {},
  exclude_values: null,
  is_primary: false,
  is_auto_detected: false,
  source_definition_id: null,
  ...o,
})

// Multi-digit + gapped, so a positional-vs-code confusion would surface
// (the 1..5 Likert blind spot).
const FORWARD = { '2': 2, '4': 4, '6': 6, '10': 10 }
const FLIP = { '2': 10, '4': 6, '6': 4, '10': 2 }
const COLLAPSE = { '2': 2, '4': 2, '6': 6, '10': 6 }

describe('valueLabelBlocker', () => {
  it('blocks a reverse PRIMARY, naming the definition and the kind', () => {
    const d = def({ name: 'Reverse scored', recode_type: 'reverse', is_primary: true })
    expect(valueLabelBlocker({ recode_definitions: [d] }))
      .toEqual({ definition: d, kind: 'reverse' })
  })

  it('blocks a FLIPPING scale_map primary — #793', () => {
    const d = def({ name: 'Anxiety (inverted)', is_primary: true, mapping: FLIP })
    expect(valueLabelBlocker({ recode_definitions: [d] }))
      .toEqual({ definition: d, kind: 'remap' })
  })

  it('blocks a COLLAPSING scale_map primary — its inputs are not recoverable', () => {
    const d = def({ name: 'Banded', is_primary: true, mapping: COLLAPSE })
    expect(valueLabelBlocker({ recode_definitions: [d] }))
      .toEqual({ definition: d, kind: 'remap' })
  })

  it('does NOT block an IDENTITY scale_map primary — value_numeric IS the code', () => {
    // The auto scale_map that apply_value_labels itself creates lands here;
    // blocking it would make editing labels a one-shot operation.
    const d = def({ is_primary: true, is_auto_detected: true, mapping: FORWARD })
    expect(valueLabelBlocker({ recode_definitions: [d] })).toBeNull()
  })

  it('does NOT block a LABEL-keyed scale_map — that is the ordinary re-edit path', () => {
    // The keys are labels, so there is no numeric key to judge and
    // `value_numeric` is the code. A hand-flip in this shape is invisible from
    // the client and is refused by the backend on save; this test pins that the
    // mirror does NOT over-reach and block every labelled column.
    const d = def({ is_primary: true, mapping: { Low: 2, Mid: 4, High: 6, Top: 10 } })
    expect(valueLabelBlocker({ recode_definitions: [d] })).toBeNull()
  })

  it('does NOT block a reverse that is not primary (it does not drive value_numeric)', () => {
    const d = def({ recode_type: 'reverse', is_primary: false })
    expect(valueLabelBlocker({ recode_definitions: [d] })).toBeNull()
  })

  it('does NOT block a flipping scale_map that is not primary', () => {
    const d = def({ is_primary: false, mapping: FLIP })
    expect(valueLabelBlocker({ recode_definitions: [d] })).toBeNull()
  })

  it('does NOT block a category_group primary — it clears value_numeric', () => {
    const d = def({
      recode_type: 'category_group', output_type: 'categorical', is_primary: true,
      mapping: { '2': 'Low band', '4': 'High band' },
    })
    expect(valueLabelBlocker({ recode_definitions: [d] })).toBeNull()
  })

  it('picks the PRIMARY out of a mixed definition list', () => {
    const flip = def({ id: 3, is_primary: true, mapping: FLIP })
    expect(valueLabelBlocker({
      recode_definitions: [
        def({ id: 1, mapping: FORWARD }),
        def({ id: 2, recode_type: 'reverse' }),
        flip,
      ],
    })).toEqual({ definition: flip, kind: 'remap' })
  })

  it('treats a blank or non-numeric mapping entry as no evidence, not as code 0', () => {
    // `Number('')` and `Number(null)` are both 0, so testing NaN-ness alone
    // would read a blank key as "code 0 maps to something else" and block a
    // healthy column.
    const d = def({ is_primary: true, mapping: { '': 4, '4': 4, notacode: 9 } })
    expect(valueLabelBlocker({ recode_definitions: [d] })).toBeNull()
  })

  describe('primary_recode — the payload EVERY surface carries', () => {
    // 🔴 Found by driving the Variables view: `recode_definitions` rides only
    // `GET …/data`, so when this editor moved off the Data view the pre-flight
    // returned "not blocked" for every column — including #793's. The backend
    // still refused; the researcher just learned it after typing five labels.
    it('blocks a reverse primary from primary_recode alone', () => {
      const p = { id: 9, name: 'Reversed', recode_type: 'reverse', remaps_codes: false }
      expect(valueLabelBlocker({ primary_recode: p }))
        .toEqual({ definition: p, kind: 'reverse' })
    })

    it('blocks a re-mapping scale_map from primary_recode alone', () => {
      const p = { id: 9, name: 'Inverted', recode_type: 'scale_map', remaps_codes: true }
      expect(valueLabelBlocker({ primary_recode: p }))
        .toEqual({ definition: p, kind: 'remap' })
    })

    it('does NOT block an identity scale_map', () => {
      expect(valueLabelBlocker({
        primary_recode: { id: 9, name: 'Scale', recode_type: 'scale_map', remaps_codes: false },
      })).toBeNull()
    })

    it('does NOT block a category_group primary', () => {
      expect(valueLabelBlocker({
        primary_recode: { id: 9, name: 'Bands', recode_type: 'category_group', remaps_codes: false },
      })).toBeNull()
    })

    it('is PREFERRED over recode_definitions when both are present', () => {
      // `/data` carries both. The server has already done the shape test, so
      // the summary is the authority and the client needs no mapping.
      expect(valueLabelBlocker({
        primary_recode: { id: 9, name: 'Inverted', recode_type: 'scale_map', remaps_codes: true },
        recode_definitions: [def({ id: 9, is_primary: true, mapping: FORWARD })],
      })).toEqual({
        definition: { id: 9, name: 'Inverted', recode_type: 'scale_map', remaps_codes: true },
        kind: 'remap',
      })
    })

    it('falls back to recode_definitions when the summary is absent', () => {
      const d = def({ id: 3, is_primary: true, mapping: FLIP })
      expect(valueLabelBlocker({ recode_definitions: [d] }))
        .toEqual({ definition: d, kind: 'remap' })
    })
  })

  it('treats a column with no recodes, or none on the payload, as clear', () => {
    expect(valueLabelBlocker({ recode_definitions: [] })).toBeNull()
    // recode_definitions rides only the /data payload — absent means "unknown",
    // and the backend is the authority that actually refuses.
    expect(valueLabelBlocker({ recode_definitions: undefined })).toBeNull()
  })
})
