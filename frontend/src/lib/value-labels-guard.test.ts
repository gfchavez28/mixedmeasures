import { describe, it, expect } from 'vitest'
import { blockingReversePrimary } from './value-labels-guard'
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

describe('blockingReversePrimary', () => {
  it('blocks a reverse PRIMARY, returning the definition so the UI can name it', () => {
    const d = def({ name: 'Reverse scored', recode_type: 'reverse', is_primary: true })
    expect(blockingReversePrimary({ recode_definitions: [d] })).toBe(d)
  })

  it('does NOT block a reverse that is not primary (it does not drive value_numeric)', () => {
    const d = def({ recode_type: 'reverse', is_primary: false })
    expect(blockingReversePrimary({ recode_definitions: [d] })).toBeNull()
  })

  it('does NOT block a scale_map primary — value_numeric IS the code, so relabelling is correct', () => {
    // The auto scale_map that apply_value_labels itself creates lands here; blocking
    // it would make editing labels a one-shot operation.
    const d = def({ recode_type: 'scale_map', is_primary: true, is_auto_detected: true })
    expect(blockingReversePrimary({ recode_definitions: [d] })).toBeNull()
  })

  it('does NOT block a category_group primary — it clears value_numeric, so the code is re-read from the text', () => {
    const d = def({ recode_type: 'category_group', output_type: 'categorical', is_primary: true })
    expect(blockingReversePrimary({ recode_definitions: [d] })).toBeNull()
  })

  it('picks the reverse primary out of a mixed definition list', () => {
    const rev = def({ id: 3, recode_type: 'reverse', is_primary: true })
    const col = {
      recode_definitions: [
        def({ id: 1, recode_type: 'scale_map' }),
        def({ id: 2, recode_type: 'reverse' }),
        rev,
      ],
    }
    expect(blockingReversePrimary(col)).toBe(rev)
  })

  it('treats a column with no recodes, or none on the payload, as clear', () => {
    expect(blockingReversePrimary({ recode_definitions: [] })).toBeNull()
    // recode_definitions rides only the /data payload — absent means "unknown",
    // and the backend is the authority that actually refuses.
    expect(blockingReversePrimary({ recode_definitions: undefined })).toBeNull()
  })
})
