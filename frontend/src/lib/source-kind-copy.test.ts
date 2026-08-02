/**
 * The source-kind copy is single-sourced, and this is the guard that makes that
 * true rather than merely intended.
 *
 * A unit test asserting "both surfaces render the constant" proves only that they
 * both CALL it — it cannot catch someone re-typing the sentence into a third
 * place, which is the actual failure. So this is a fail-closed SOURCE SCAN, the
 * same shape as the upload-format guard (#552) and the ownership sweep (#553).
 *
 * It matters here more than most: these sentences are what a researcher decides
 * on before coding for hours, and one of them was FALSE in the plan for a day
 * (D16 told people an Observation has no consensus or reconciliation; D18 showed
 * that is untrue once the clip set is frozen). A duplicated sentence is a
 * sentence that gets corrected in one place and left wrong in another.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  LOAD_BEARING_PHRASES,
  SOURCE_KIND_ONE_LINER,
  OBSERVATION_TRADEOFFS,
  FROZEN_CONSEQUENCES,
  OPEN_CONSEQUENCES,
  RELIABILITY_EXPLAINER_FROZEN,
  RELIABILITY_EXPLAINER_OPEN,
} from './source-kind-copy'

const SRC = join(__dirname, '..')
const OWNER = 'lib/source-kind-copy.ts'

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return tsFilesUnder(full)
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
    return [full]
  })
}

/** Comments explaining the rule are documentation, not a re-typed gate. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1')
}

describe('source-kind copy is single-sourced (fail-closed)', () => {
  const files = tsFilesUnder(join(SRC, 'pages'))
    .concat(tsFilesUnder(join(SRC, 'components')))
    .concat(tsFilesUnder(join(SRC, 'lib')).filter(f => !f.endsWith('source-kind-copy.ts')))

  it('scans a real, non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(80)
  })

  it.each(LOAD_BEARING_PHRASES)('the phrase %p appears nowhere but the copy module', (phrase) => {
    const offenders = files
      .filter(f => code(readFileSync(f, 'utf8')).toLowerCase().includes(phrase.toLowerCase()))
      .map(f => f.slice(f.indexOf('/src/') + 5))

    expect(
      offenders,
      `${offenders.join(', ')} re-types a load-bearing phrase. Import it from ${OWNER} — `
      + 'these sentences are what a researcher makes an irreversible decision on, and a '
      + 'duplicate is a sentence that gets corrected in one place and left wrong in another.',
    ).toEqual([])
  })
})

describe('the copy says what D18 actually established', () => {
  it('never claims an Observation categorically has no consensus or reconciliation', () => {
    // D16's original wording, struck by D18: a FROZEN clip set gets ordinary
    // agreement scoring, consensus AND reconciliation, through the shipped
    // engines. Saying otherwise at the fork is the single most dangerous
    // sentence in the feature — it is false, and it is irreversible-decision copy.
    const all = [
      SOURCE_KIND_ONE_LINER,
      ...OBSERVATION_TRADEOFFS,
    ].join(' ').toLowerCase()

    expect(all).not.toContain('no consensus')
    expect(all).not.toContain('no reconciliation')
  })

  it('does not promise event-matched agreement while 6b-A-3 is unbuilt', () => {
    // D47 specifies event-matched κ; nothing computes it yet, and copy must not
    // claim what the tool doesn't ship (the §8n claim-discipline rule — this
    // exact sentence overclaimed for a week). Flip this pin in the SAME change
    // that ships 6b-A-3.
    expect(OPEN_CONSEQUENCES.toLowerCase()).not.toContain('event-matched')
    expect(RELIABILITY_EXPLAINER_OPEN.toLowerCase()).not.toContain('event-matched')
  })

  it('ties the consensus consequence to the FREEZE, not to the source type', () => {
    expect(FROZEN_CONSEQUENCES.toLowerCase()).toContain('consensus')
    expect(FROZEN_CONSEQUENCES.toLowerCase()).toContain('reconciliation')
    // Open cuts are where "no consensus" is true — and the reason is stated, not asserted.
    expect(OPEN_CONSEQUENCES.toLowerCase()).toContain('no consensus')
    expect(OPEN_CONSEQUENCES.toLowerCase()).toContain('one vote')
  })

  it('the Reliability tab will explain the freeze in the SAME words as the import fork', () => {
    // Identity, not equality: the reliability surface (slab 6b) cannot paraphrase.
    expect(RELIABILITY_EXPLAINER_FROZEN).toBe(FROZEN_CONSEQUENCES)
    expect(RELIABILITY_EXPLAINER_OPEN).toBe(OPEN_CONSEQUENCES)
  })
})
