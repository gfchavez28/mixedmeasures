/**
 * #1537/#1538 (1.6.0, D122–D125) — what the participant filter IS, decided once.
 *
 * `resolveFilterValues` is the panel's old rule (a union within a variable, an intersection across
 * variables), moved out of the panel so the page can hold the values; `participantFilterState` is
 * the one decision every surface reads. The fixture is the review's drive: Pat (501) = Group X /
 * Site North, Sam (502) = Group Y / Site South — so Group = Y and Site = South select the SAME
 * person, which is why a list's values are never inferred (D124).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { DemographicFilter } from '@/lib/api'
import { stripComments } from '@/lib/strip-comments'
import { sourceFiles, srcRel, SOURCE_SCAN_TIMEOUT_MS } from '@/test-support/source-tree'
import {
  describeFilterValues, filterApplied, givenFilterNote, hasChosenValues, noParticipantMatchesNotice,
  participantFilterState, resolveFilterValues, type FilterChoice,
} from './participant-filter'

const OPTIONS: DemographicFilter[] = [
  { subtype: 'group', label: 'Group', values: [
    { value: 'X', participant_ids: [501], count: 1 }, { value: 'Y', participant_ids: [502], count: 1 },
  ] },
  { subtype: 'site', label: 'Site', values: [
    { value: 'North', participant_ids: [501], count: 1 }, { value: 'South', participant_ids: [502], count: 1 },
  ] },
]
const set = (...v: string[]) => new Set(v)

describe('resolveFilterValues', () => {
  it('nothing chosen is no filter — an emptied variable counts as nothing chosen', () => {
    expect(resolveFilterValues({}, OPTIONS)).toEqual({ kind: 'none' })
    expect(resolveFilterValues({ group: set() }, OPTIONS)).toEqual({ kind: 'none' })
  })

  it('a union within a variable, sorted', () => {
    expect(resolveFilterValues({ group: set('Y', 'X') }, OPTIONS)).toEqual({ kind: 'ids', ids: [501, 502] })
  })

  it('an intersection across variables', () => {
    expect(resolveFilterValues({ group: set('X'), site: set('North') }, OPTIONS)).toEqual({ kind: 'ids', ids: [501] })
    expect(resolveFilterValues({ group: set('X', 'Y'), site: set('South') }, OPTIONS)).toEqual({ kind: 'ids', ids: [502] })
  })

  it('#1538 — values no participant holds together are "no one", never "no filter", in either order', () => {
    expect(resolveFilterValues({ group: set('X'), site: set('South') }, OPTIONS)).toEqual({ kind: 'nobody' })
    expect(resolveFilterValues({ site: set('South'), group: set('X') }, OPTIONS)).toEqual({ kind: 'nobody' })
  })

  it('a value or variable the options no longer list selects no one', () => {
    expect(resolveFilterValues({ group: set('Z') }, OPTIONS)).toEqual({ kind: 'nobody' })
    expect(resolveFilterValues({ region: set('East') }, OPTIONS)).toEqual({ kind: 'nobody' })
    expect(resolveFilterValues({ group: set('X'), region: set('East') }, OPTIONS)).toEqual({ kind: 'nobody' })
  })
})

describe('participantFilterState', () => {
  const choice = (values: FilterChoice['values'], producedIds: number[], projectId = 1): FilterChoice =>
    ({ projectId, values, producedIds })

  it('no values held and no list applied is no filter', () => {
    expect(participantFilterState(null, 1, [])).toEqual({ kind: 'none' })
  })

  it('#1537 D124 — a list with no values behind it (a link, a saved analysis) is GIVEN, not dropped', () => {
    expect(participantFilterState(null, 1, [502])).toEqual({ kind: 'given', ids: [502] })
  })

  it('held values are the filter, with the list they produced', () => {
    const c = choice({ group: set('Y') }, [502])
    expect(participantFilterState(c, 1, [502])).toEqual({ kind: 'values', values: c.values, ids: [502] })
  })

  it('the values hold while the URL has not caught up — they are never compared with it', () => {
    // BrowserRouter renders a URL write one transition after the state beside it.
    const c = choice({ group: set('Y') }, [502])
    expect(participantFilterState(c, 1, []).kind).toBe('values')
  })

  it('#1538 D125 — held values that produced no list are NO ONE', () => {
    const c = choice({ group: set('X'), site: set('South') }, [])
    expect(participantFilterState(c, 1, [])).toEqual({ kind: 'nobody', values: c.values })
  })

  it('values held for another project are not this project\'s filter', () => {
    const c = choice({ group: set('Y') }, [502], 2)
    expect(participantFilterState(c, 1, [])).toEqual({ kind: 'none' })
    expect(participantFilterState(c, 1, [7])).toEqual({ kind: 'given', ids: [7] })
  })

  it('a choice with every value removed is not a filter (it is never stored, but holds if it were)', () => {
    expect(participantFilterState(choice({ group: set() }, []), 1, [])).toEqual({ kind: 'none' })
  })

  it('filterApplied is true exactly where a list is applied (the rule line\'s condition)', () => {
    expect(filterApplied({ kind: 'none' })).toBe(false)
    expect(filterApplied({ kind: 'nobody', values: { group: set('X') } })).toBe(false)
    expect(filterApplied({ kind: 'given', ids: [502] })).toBe(true)
    expect(filterApplied({ kind: 'values', values: { group: set('Y') }, ids: [502] })).toBe(true)
  })
})

describe('the words', () => {
  it('names the chosen values in the options\' order, whatever order they were chosen in', () => {
    expect(describeFilterValues({ site: set('South'), group: set('Y', 'X') }, OPTIONS)).toBe('Group: X, Y; Site: South')
  })

  it('names a chosen value the options no longer list — it is what the researcher chose', () => {
    expect(describeFilterValues({ group: set('X', 'Z') }, OPTIONS)).toBe('Group: X, Z')
  })

  it('the notice carries the values; with none to name it still says the state', () => {
    expect(noParticipantMatchesNotice('Group: X; Site: South'))
      .toBe('No participant matches the chosen filters (Group: X; Site: South).')
    expect(noParticipantMatchesNotice('')).toBe('No participant matches the chosen filters.')
  })

  it('a given list counts its participants, singular and plural', () => {
    expect(givenFilterNote(1)).toMatch(/keeps 1 participant\. /)
    expect(givenFilterNote(3)).toMatch(/keeps 3 participants\. /)
    expect(givenFilterNote(1)).toMatch(/values were not saved with it/)
  })

  it('hasChosenValues reads every variable', () => {
    expect(hasChosenValues({})).toBe(false)
    expect(hasChosenValues({ group: set() })).toBe(false)
    expect(hasChosenValues({ group: set(), site: set('South') })).toBe(true)
  })
})

describe('#1537 D123 — the applied filter has a closed set of writers', () => {
  // `participantFilterState` trusts `filterChoice` without comparing it with the URL, which is
  // sound only because every writer of `pids` other than the panel's clears the choice. So the
  // writers are a POPULATION: only `useQualitativeAnalysis` names the param, and its writes are
  // exactly the two that know about the choice — `writeParticipantIds` (the panel's two acts) and
  // `loadMaterial` (which clears it). A third write, or a write elsewhere, fails here until
  // someone decides what it does to the chosen values.
  const HOOK = 'hooks/useQualitativeAnalysis.ts'
  const NAMES_PIDS = /['"`]pids['"`]/g
  const WRITES_PIDS = /\.(set|delete)\(\s*['"`]pids['"`]/g

  it('only the hook names the `pids` param, and it writes it in exactly four places', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const files = sourceFiles({ ext: 'both', floor: 400, sentinels: [HOOK, 'pages/QualitativeAnalysisView.tsx'] })
    const naming = files
      .filter(abs => (stripComments(readFileSync(abs, 'utf8')).match(NAMES_PIDS) ?? []).length > 0)
      .map(srcRel)
    expect(naming).toEqual([HOOK])  // also the falsifier: the scan finds the one it must
    const hook = stripComments(readFileSync(files.find(abs => srcRel(abs) === HOOK)!, 'utf8'))
    // writeParticipantIds: set + delete · loadMaterial: set + delete
    expect([...hook.matchAll(WRITES_PIDS)].map(m => m[1])).toEqual(['delete', 'set', 'set', 'delete'])
  })
})
