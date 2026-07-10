/**
 * #414 slab 4 — the wizard's participant-link column derivation.
 *
 * `effectiveLinkColumnIndex` decides what rides `import_config.
 * participant_link_column_index`. The falsy-zero case (identifier at
 * column_index 0) is the documented trap — pin it.
 */
import { describe, it, expect } from 'vitest'
import { identifierColumns, effectiveLinkColumnIndex, type FileConfig } from './DatasetImport'
import type { DatasetColumnPreview } from '@/lib/api'

function col(index: number, suggested: string): DatasetColumnPreview {
  return {
    column_index: index,
    suggested_type: suggested,
    suggested_column_text: `col${index}`,
  } as DatasetColumnPreview
}

function config(overrides: Partial<FileConfig> = {}): FileConfig {
  return {
    preview: null,
    previewColumns: [],
    skippedIndices: new Set<number>(),
    typeOverrides: {},
    subtypeOverrides: {},
    datasetName: 'ds',
    datasetDescription: '',
    datasetSource: '',
    previewError: null,
    sheetName: null,
    linkParticipants: true,
    linkColumnIndex: null,
    ...overrides,
  }
}

describe('identifierColumns', () => {
  it('honors type overrides and skips', () => {
    const c = config({
      previewColumns: [col(0, 'open_text'), col(1, 'numeric'), col(2, 'identifier')],
      typeOverrides: { 0: 'identifier' },   // user retyped col 0
      skippedIndices: new Set([2]),          // user skipped the detected one
    })
    expect(identifierColumns(c).map(x => x.column_index)).toEqual([0])
  })
})

describe('effectiveLinkColumnIndex', () => {
  it('returns index 0 when the identifier is the first column (falsy-zero)', () => {
    const c = config({ previewColumns: [col(0, 'identifier'), col(1, 'numeric')] })
    expect(effectiveLinkColumnIndex(c)).toBe(0)
  })

  it('returns null when linking is opted out or no identifier exists', () => {
    const withId = config({ previewColumns: [col(0, 'identifier')], linkParticipants: false })
    expect(effectiveLinkColumnIndex(withId)).toBeNull()
    const withoutId = config({ previewColumns: [col(0, 'numeric')] })
    expect(effectiveLinkColumnIndex(withoutId)).toBeNull()
  })

  it('honors the user pick among several, and falls back when the pick went stale', () => {
    const c = config({
      previewColumns: [col(0, 'identifier'), col(1, 'identifier')],
      linkColumnIndex: 1,
    })
    expect(effectiveLinkColumnIndex(c)).toBe(1)
    // The picked column was retyped away → fall back to the first identifier
    const stale = config({
      previewColumns: [col(0, 'identifier'), col(1, 'identifier')],
      typeOverrides: { 1: 'nominal' },
      linkColumnIndex: 1,
    })
    expect(effectiveLinkColumnIndex(stale)).toBe(0)
  })
})
