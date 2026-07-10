import { describe, it, expect } from 'vitest'
import {
  DATASET_ACCEPT,
  DATASET_FORMAT_LABEL,
  isSupportedDatasetFile,
} from './dataset-import-formats'

describe('isSupportedDatasetFile', () => {
  it.each(['data.csv', 'data.xlsx', 'survey.sav'])('accepts %s', name => {
    expect(isSupportedDatasetFile(name)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isSupportedDatasetFile('SURVEY.SAV')).toBe(true)
    expect(isSupportedDatasetFile('DATA.XLSX')).toBe(true)
  })

  it.each(['notes.txt', 'archive.zip', 'data.sav.txt', 'savvy'])('rejects %s', name => {
    expect(isSupportedDatasetFile(name)).toBe(false)
  })

  it('only matches the trailing extension', () => {
    expect(isSupportedDatasetFile('my.csv.backup')).toBe(false)
    expect(isSupportedDatasetFile('my.backup.csv')).toBe(true)
  })
})

describe('accept / label agreement', () => {
  it('every accepted extension is also matched by the predicate', () => {
    for (const ext of DATASET_ACCEPT.split(',')) {
      expect(isSupportedDatasetFile(`file${ext}`)).toBe(true)
    }
  })

  it('the human-readable label mentions every accepted extension', () => {
    // Drift guard: copy that omits a format is how .sav shipped unpickable.
    for (const ext of DATASET_ACCEPT.split(',')) {
      const bare = ext.replace('.', '')
      expect(DATASET_FORMAT_LABEL.toLowerCase()).toContain(bare)
    }
  })
})
