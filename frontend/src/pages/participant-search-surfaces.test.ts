/**
 * #1092 — every participant search box says the same thing.
 *
 * Three surfaces search participants through ONE module (`searchParticipants`):
 * the Participants page, "Who is this document about?" and the data grid's link
 * picker. They had grown three placeholders, two accessible names (the grid's
 * box had none — its placeholder was its name), three empty-list sentences, and
 * a hand-written tint for the grid's current row. A shared module is not a
 * shared surface.
 *
 * The population is DERIVED — every file that calls `searchParticipants` — so a
 * fourth picker is held to the same wording the day it is written, rather than
 * the day someone remembers this file.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SOURCE_SCAN_TIMEOUT_MS, SRC_DIR, sourceFiles } from '@/test-support/source-tree'

const consumers = sourceFiles({ ext: 'tsx', floor: 250 })
  .map(file => ({ file: relative(SRC_DIR, file), src: stripComments(readFileSync(file, 'utf8'), file) }))
  .filter(({ src }) => /\bsearchParticipants\(/.test(src))

describe('#1092 — the participant search surfaces share one wording', () => {
  it('finds the three known surfaces (the scan can see)', () => {
    expect(consumers.map(c => c.file).sort()).toEqual([
      'components/DatasetGridComponents.tsx',
      'components/DocumentSubjectDialog.tsx',
      'pages/ParticipantsPage.tsx',
    ])
  }, SOURCE_SCAN_TIMEOUT_MS)

  it.each(consumers.map(c => [c.file, c.src]))('%s names and words its search from the shared constants', (_, src) => {
    expect(src).toContain('placeholder={PARTICIPANT_SEARCH_PLACEHOLDER}')
    expect(src).toContain('aria-label={PARTICIPANT_SEARCH_LABEL}')
    expect(src).toContain('noParticipantsMatch(search)')
    // The three hand-written forms this replaced.
    expect(src).not.toMatch(/placeholder="Search participants/)
    expect(src).not.toMatch(/No participants? (match|found)/)
  })

  it('PREDICATE FALSIFIER: the hand-written forms are what the scan rejects', () => {
    expect('placeholder="Search participants..."').toMatch(/placeholder="Search participants/)
    expect('No participants found').toMatch(/No participants? (match|found)/)
    expect('No participant matches “x”').toMatch(/No participants? (match|found)/)
  })

  it('the grid picker marks its current link with the selected-row recipe', () => {
    const grid = consumers.find(c => c.file === 'components/DatasetGridComponents.tsx')!.src
    expect(grid).toMatch(/isCurrentRow\s*\?\s*SELECTED_ROW/)
    expect(grid).not.toContain('bg-mm-blue/12')
  })
})
