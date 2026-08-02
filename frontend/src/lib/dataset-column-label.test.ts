import { describe, it, expect } from 'vitest'
import { columnDisplayLabel } from './dataset-column-label'

describe('columnDisplayLabel', () => {
  it('prefers the short name when present', () => {
    expect(columnDisplayLabel({ id: 1, column_name: 'Anxiety', column_text: 'How anxious…?' }))
      .toBe('Anxiety')
  })

  it('falls back to column_text when name is null/blank', () => {
    expect(columnDisplayLabel({ id: 1, column_name: null, column_text: 'How anxious…?' }))
      .toBe('How anxious…?')
    expect(columnDisplayLabel({ id: 1, column_name: '  ', column_text: 'How anxious…?' }))
      .toBe('How anxious…?')
  })

  it('falls back to column_code, then a Column {id} literal', () => {
    expect(columnDisplayLabel({ id: 7, column_name: null, column_text: null, column_code: 'Q7' }))
      .toBe('Q7')
    expect(columnDisplayLabel({ id: 7, column_name: null, column_text: null, column_code: null }))
      .toBe('Column 7')
  })

  it('truncates to maxLength when given', () => {
    expect(columnDisplayLabel({ id: 1, column_text: 'a'.repeat(40) }, { maxLength: 10 }))
      .toBe('aaaaaaaaaa')
  })
})
