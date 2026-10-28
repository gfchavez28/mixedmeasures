import { describe, it, expect } from 'vitest'
import {
  canKeepIdentity, codingCopyCandidates, codingCopyMapping, shouldAskWhoYouAre, whoIsYouBlocker,
} from './coding-copy'
import type { ImportValidationResult, MergeCoderMatch, MergeCoderPreview } from './api'

const ME = 7

const coder = (over: Partial<MergeCoderPreview>): MergeCoderPreview => ({
  original_id: 1, username: 'Researcher', coder_type: 'human', archived: false,
  file_app_count: 2, local_match: null, name_in_use: null, match_options: [],
  machine_provenance: null, create_username: 'Researcher', ...over,
})
const match = (id: number, basis: MergeCoderMatch['basis']): MergeCoderMatch => ({
  id, username: 'Researcher', archived: false, local_app_count: 0, basis,
})
const validation = (over: Partial<ImportValidationResult>): ImportValidationResult => ({
  manifest: { project_uuid: 'u', project_name: 'P' } as ImportValidationResult['manifest'],
  warnings: [], existing_project: null, merge_coders: null, merge_codes_preview: null, ...over,
})

describe('#1321 — canKeepIdentity', () => {
  it('is offered when the file has an identity and no project here shares it', () => {
    expect(canKeepIdentity(validation({}))).toBe(true)
  })
  it('is not offered beside a local copy (Merge / Overwrite are) or for a file with no identity', () => {
    expect(canKeepIdentity(validation({ existing_project: { id: 1, name: 'P' } }))).toBe(false)
    expect(canKeepIdentity(validation({
      manifest: { project_uuid: null, project_name: 'P' } as ImportValidationResult['manifest'],
    }))).toBe(false)
  })
})

describe('D2 — who the question lists (codingCopyCandidates)', () => {
  it('lists a person who coded, whom a NAME links to someone here or nothing does', () => {
    const byName = coder({ original_id: 1, local_match: match(ME, 'name') })
    const nobody = coder({ original_id: 2, username: 'Ana' })
    expect(codingCopyCandidates([byName, nobody])).toEqual([byName, nobody])
  })
  it('leaves out a coder known here by IDENTITY — the same coder needs no answer', () => {
    expect(codingCopyCandidates([coder({ local_match: match(3, 'identity') })])).toEqual([])
  })
  it('leaves out a machine, and any kind that is not a person', () => {
    expect(codingCopyCandidates([
      coder({ coder_type: 'ai' }), coder({ coder_type: 'unattributed' }), coder({ coder_type: 'consensus' }),
    ])).toEqual([])
  })
  it('leaves out a person with no codings in the file', () => {
    expect(codingCopyCandidates([coder({ file_app_count: 0 })])).toEqual([])
  })
  it('knows nothing when the server sent nothing (an older server, or a merge)', () => {
    expect(codingCopyCandidates(undefined)).toEqual([])
    expect(codingCopyCandidates(null)).toEqual([])
  })
})

describe('D2 — whether the dialog asks (shouldAskWhoYouAre)', () => {
  it('asks when someone is listed and no file coder is already you', () => {
    expect(shouldAskWhoYouAre([coder({ local_match: match(ME, 'name') })], ME)).toBe(true)
  })
  it('is skipped when nobody is listed', () => {
    expect(shouldAskWhoYouAre([coder({ coder_type: 'ai' })], ME)).toBe(false)
    expect(shouldAskWhoYouAre([], ME)).toBe(false)
  })
  it('is skipped when a file coder IS you by identity, though another is listed', () => {
    expect(shouldAskWhoYouAre([
      coder({ original_id: 1, local_match: match(ME, 'identity') }),
      coder({ original_id: 2, username: 'Ana' }),
    ], ME)).toBe(false)
  })
  it('still asks when the identity match is SOMEONE ELSE here, or a name match is you', () => {
    expect(shouldAskWhoYouAre([
      coder({ original_id: 1, local_match: match(3, 'identity') }),
      coder({ original_id: 2, local_match: match(ME, 'name') }),
    ], ME)).toBe(true)
  })
  it('is skipped with no active coder known (no one to map an answer onto)', () => {
    expect(shouldAskWhoYouAre([coder({})], null)).toBe(false)
    expect(shouldAskWhoYouAre([coder({})], undefined)).toBe(false)
  })
})

describe('D2 — the coder_mapping a coding copy sends (codingCopyMapping)', () => {
  const file = [coder({ original_id: 11, local_match: match(ME, 'name') }), coder({ original_id: 12, username: 'Ana' })]

  it('the chosen person → ONE match onto the active coder', () => {
    expect(codingCopyMapping(file, ME, { kind: 'person', originalId: 12 }))
      .toEqual({ '12': { action: 'match', target_user_id: ME } })
  })
  it('"None of them", or no answer, sends no mapping', () => {
    expect(codingCopyMapping(file, ME, { kind: 'none' })).toBeUndefined()
    expect(codingCopyMapping(file, ME, null)).toBeUndefined()
  })
  it('an answer naming nobody the question lists sends nothing (a stale answer)', () => {
    expect(codingCopyMapping(file, ME, { kind: 'person', originalId: 99 })).toBeUndefined()
    const known = [coder({ original_id: 13, local_match: match(3, 'identity') }), ...file]
    expect(codingCopyMapping(known, ME, { kind: 'person', originalId: 13 })).toBeUndefined()
  })
  it('nothing when the question is skipped — you are already identified', () => {
    const youAlready = [coder({ original_id: 14, local_match: match(ME, 'identity') }), ...file]
    expect(codingCopyMapping(youAlready, ME, { kind: 'person', originalId: 12 })).toBeUndefined()
  })
  it('nothing with no active coder', () => {
    expect(codingCopyMapping(file, null, { kind: 'person', originalId: 12 })).toBeUndefined()
  })
})

describe('D2 — the gate on *Import* (whoIsYouBlocker)', () => {
  it('names what is missing while the question is asked and unanswered', () => {
    expect(whoIsYouBlocker(true, null)).toBe(
      'Choose which of these people is you, or None of them, before importing.')
  })
  it('opens on either answer, and when nothing is asked', () => {
    expect(whoIsYouBlocker(true, { kind: 'none' })).toBeNull()
    expect(whoIsYouBlocker(true, { kind: 'person', originalId: 1 })).toBeNull()
    expect(whoIsYouBlocker(false, null)).toBeNull()
  })
})
