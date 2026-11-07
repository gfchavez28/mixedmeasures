/** #1329 (D51) — the sentence for groups a row shows and its tests leave out. */
import { describe, expect, it } from 'vitest'
import { untestedGroupsNote } from './untested-groups'

describe('untestedGroupsNote', () => {
  it('names one group', () => {
    expect(untestedGroupsNote(['C'])).toBe(
      'C has only one value, so it is shown without an SD and left out of the tests.')
  })

  it('names several, in the order the server sent', () => {
    expect(untestedGroupsNote(['West', 'North', 'East'])).toBe(
      'West, North and East have only one value each, so they are shown without an SD and left out of the tests.')
  })

  it('prefixes the variable when a table holds several rows', () => {
    expect(untestedGroupsNote(['C'], 'Wellbeing')).toMatch(/^Wellbeing: C has only one value/)
  })

  it('says nothing when nobody is left out or the payload predates the field', () => {
    expect(untestedGroupsNote([])).toBeNull()
    expect(untestedGroupsNote(undefined)).toBeNull()
    expect(untestedGroupsNote(null)).toBeNull()
  })
})
