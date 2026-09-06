/**
 * #703 — every surface that shows a word figure states the unit.
 *
 * A SOURCE SCAN rather than a render test, and deliberately: the risk is not
 * that today's four surfaces regress, it is the FIFTH one added later by someone
 * who has no reason to know that `word_count` is `len(text.split())` and that
 * the number means "segments" for a third of the world's writing systems.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORD_COUNT_NOTE, WORD_COUNT_UNIT } from './word-count-basis'
import { sourceFiles, srcRel } from '@/test-support/source-tree'

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** Surfaces that render a word figure to a researcher. */
const WORD_SURFACES = [
  'components/ResponseLengthPanel.tsx',
  'components/qualitative-analysis/QualSummaryTable.tsx',
  'components/qualitative-analysis/ContentByCode.tsx',
] as const

describe('#703 — the word count states its unit', () => {
  for (const rel of WORD_SURFACES) {
    it(`${rel} imports the shared caveat rather than wording its own`, () => {
      expect(read(rel)).toMatch(/word-count-basis/)
    })
  }

  it('the caveat names the scripts it is about, not just "some languages"', () => {
    // A researcher planning fieldwork needs to recognise their own case.
    expect(WORD_COUNT_NOTE).toMatch(/Chinese/)
    expect(WORD_COUNT_NOTE).toMatch(/Japanese/)
    expect(WORD_COUNT_NOTE).toMatch(/Thai/)
    expect(WORD_COUNT_UNIT).toMatch(/whitespace-delimited/)
  })

  /**
   * Fail-closed: any OTHER component rendering a `word_count` / `avg_words`
   * figure must either import the caveat or be added above with a reason.
   * Files that merely aggregate the number (chart denominators) are excluded —
   * they display no "words" label of their own.
   */
  it('no unlisted component renders a word figure without the caveat', () => {
    const offenders: string[] = []
    // The walk carries its population floor (#730) through `sourceFiles()`;
    // this scan had none until #729's substrate landed.
    for (const abs of sourceFiles({ root: 'components', ext: 'tsx', floor: 100 })) {
      const rel = srcRel(abs)
      const src = read(rel)
      // A user-facing word LABEL, not an arithmetic use of the field.
      const showsWordLabel = /\bword\{|avg words|Avg Words|% Words/.test(src)
      if (!showsWordLabel) continue
      const listed = (WORD_SURFACES as readonly string[]).includes(rel)
      if (!listed && !src.includes('word-count-basis')) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
