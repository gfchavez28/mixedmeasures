/**
 * #1008 — what the four source list pages must keep once they share a toolbar.
 *
 * Source scans, because these pages need the whole project layout to render; each
 * pins a property no rendered test of the toolbar can see.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'

const source = (file: string) =>
  stripComments(readFileSync(join(SRC_DIR, file), 'utf8'), file.split('/').pop())

describe('Datasets — sorting must not recolour a dataset', () => {
  const src = source('pages/DatasetsListPage.tsx')

  it('derives the accent from the FULL server-ordered list, never the sorted one', () => {
    // A dataset's colour is its position in `allDatasetIds`; built from the
    // sorted or filtered list, colours would move as the researcher sorts and
    // stop matching the same dataset in the crosswalk.
    expect(src).toMatch(/const allDatasetIds = useMemo\(\(\) => datasets\.map\(/)
    expect(src).toContain('getDatasetAccent(ds.id, allDatasetIds, ds.color)')
    expect(src).not.toMatch(/allDatasetIds\s*=\s*[^\n]*filteredAndSorted/)
  })

  it('renders the rows from the sorted list', () => {
    expect(src).toContain('filteredAndSorted.map((ds)')
  })
})

describe('each list names its formats from the shared label, never by hand', () => {
  it.each([
    ['pages/ConversationsListPage.tsx', 'TRANSCRIPT_FORMAT_LABEL'],
    ['pages/DocumentsListPage.tsx', 'DOCUMENT_FORMAT_LABEL'],
    ['pages/DatasetsListPage.tsx', 'DATASET_FORMAT_LABEL'],
    ['pages/ObservationsListPage.tsx', 'OBSERVATION_MEDIA_FORMAT_LABEL'],
  ])('%s', (file, label) => {
    const src = source(file)
    expect(src).toContain(`{${label}}`)
    // The two hand-written lists this replaced.
    expect(src).not.toMatch(/Import a dataset CSV|drag and drop CSV files|Drop CSV files|Import DOCX, PDF, or TXT/)
  })
})

describe('every list answers a drop — none lets it vanish', () => {
  it.each([
    'pages/ConversationsListPage.tsx',
    'pages/DocumentsListPage.tsx',
    'pages/DatasetsListPage.tsx',
    'pages/ObservationsListPage.tsx',
  ])('%s handles onDrop and says something when it cannot use the file', (file) => {
    const src = source(file)
    expect(src).toMatch(/onDrop:/)
    expect(src).toMatch(/toast\.error\(`Drop a/)
  })
})
