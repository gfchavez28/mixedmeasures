import { describe, it, expect } from 'vitest'
import type { Coder, CodingImportCoderCandidate, ProjectColumnInfo } from '@/lib/api'
import {
  CODER_NAME_MAX_LENGTH, coderOptionLabel, draftBlocker, initialDraft,
  matchKeyOptions, namesSharingACoder, toDecision, type CoderDraft,
} from './coding-import-mapping'

const candidate = (over: Partial<CodingImportCoderCandidate> = {}): CodingImportCoderCandidate => ({
  name: 'GPT-4o', row_count: 3, rows_to_apply: 3, local_user_id: null, local_coder_type: null,
  local_archived: false, local_application_count: 0, local_machine_provenance: null,
  ...over,
})

describe('initialDraft', () => {
  it('pre-selects a name match, and CREATE for an unknown name', () => {
    expect(initialDraft(candidate()).action).toBe('create')
    expect(initialDraft(candidate({ local_user_id: 4 }))).toMatchObject({
      action: 'match', targetUserId: 4,
    })
  })

  it('starts a name with NOTHING to import at skip — no kind to ask, no empty coder', () => {
    expect(initialDraft(candidate({ rows_to_apply: 0 })).action).toBe('skip')
    expect(initialDraft(candidate({ rows_to_apply: 0, local_user_id: 4 })).action).toBe('skip')
    expect(draftBlocker('GPT-4o', initialDraft(candidate({ rows_to_apply: 0 })))).toBeNull()
  })

  it('🔴 chooses NO kind for a new coder (#1038 h)', () => {
    expect(initialDraft(candidate()).coderType).toBeNull()
  })

  it('offers an ARCHIVED match back, visibly (#1031 c) — and only an archived one', () => {
    expect(initialDraft(candidate({ local_user_id: 4, local_archived: true })).unarchive).toBe(true)
    expect(initialDraft(candidate({ local_user_id: 4 })).unarchive).toBe(false)
    // An archived flag with no match is nothing to bring back.
    expect(initialDraft(candidate({ local_archived: true })).unarchive).toBe(false)
  })
})

describe('toDecision', () => {
  const base = initialDraft(candidate({ local_user_id: 4 }))

  it('carries `unarchive` only when it is asked for', () => {
    expect(toDecision(base)).toEqual({ action: 'match', target_user_id: 4 })
    expect(toDecision({ ...base, unarchive: true }))
      .toEqual({ action: 'match', target_user_id: 4, unarchive: true })
  })

  it('a machine carries its configuration; a person carries none', () => {
    const create: CoderDraft = { ...initialDraft(candidate()), coderType: 'ai', model: 'm' }
    expect(toDecision(create)).toMatchObject({ coder_type: 'ai', machine_provenance: { model: 'm' } })
    expect(toDecision({ ...create, coderType: 'human' }))
      .toMatchObject({ coder_type: 'human', machine_provenance: null })
  })
})

describe('draftBlocker', () => {
  it('asks for the kind of a new coder', () => {
    expect(draftBlocker('GPT-4o', initialDraft(candidate())))
      .toBe('Say whether “GPT-4o” is a person or a model.')
    expect(draftBlocker('GPT-4o', { ...initialDraft(candidate()), coderType: 'ai' })).toBeNull()
  })

  it('asks which coder a match is', () => {
    expect(draftBlocker('A', { ...initialDraft(candidate()), action: 'match', targetUserId: null }))
      .toBe('Choose which coder “A” is.')
  })

  it('refuses a name longer than a coder can have — the FILE’s name when none is typed', () => {
    const long = 'x'.repeat(CODER_NAME_MAX_LENGTH + 1)
    const draft: CoderDraft = { ...initialDraft(candidate({ name: long })), coderType: 'human', newUsername: '' }
    expect(draftBlocker(long, draft)).toMatch(/longer than 50/)
    // Exactly the limit is fine — the server's boundary is the same.
    const edge = 'y'.repeat(CODER_NAME_MAX_LENGTH)
    expect(draftBlocker(edge, { ...draft, newUsername: edge })).toBeNull()
  })

  it('a skipped name blocks nothing', () => {
    expect(draftBlocker('A', { ...initialDraft(candidate()), action: 'skip' })).toBeNull()
  })
})

describe('namesSharingACoder (#1039 i)', () => {
  it('pairs the names that go to ONE coder, and nothing else', () => {
    const d = (targetUserId: number | null, action: CoderDraft['action'] = 'match'): CoderDraft =>
      ({ ...initialDraft(candidate()), action, targetUserId })
    const shared = namesSharingACoder({
      Alice: d(1), alice: d(1), Bob: d(2), New: d(1, 'create'), Unset: d(null),
    })
    expect(shared.get('Alice')).toEqual(['alice'])
    expect(shared.get('alice')).toEqual(['Alice'])
    expect(shared.has('Bob')).toBe(false)
    expect(shared.has('New')).toBe(false)   // a create never shares
    expect(shared.has('Unset')).toBe(false)
  })
})

describe('coderOptionLabel', () => {
  it('names the kind and the archive, so the picker cannot hide either', () => {
    expect(coderOptionLabel({ id: 1, username: 'Alice', coder_type: 'human' } as Coder)).toBe('Alice')
    expect(coderOptionLabel({ id: 2, username: 'GPT', coder_type: 'ai', archived: true } as Coder))
      .toBe('GPT · model (archived)')
  })
})

describe('matchKeyOptions (#1032 a/b)', () => {
  const col = (id: number, dataset_id: number, column_type: string, name: string): ProjectColumnInfo =>
    ({ id, dataset_id, column_type, column_name: name, column_text: name } as ProjectColumnInfo)
  const COLUMNS = [
    col(1, 10, 'open_text', 'comment'),      // the coded column
    col(2, 10, 'numeric', 'respondent_no'),
    col(3, 10, 'identifier', 'post_id'),
    col(4, 10, 'ordinal', 'agree'),          // not key-shaped
    col(5, 20, 'identifier', 'other_id'),    // ANOTHER dataset
    col(6, 10, 'open_text', 'second_text'),
  ]

  it('offers the coded dataset’s key-shaped columns, identifiers first, never the coded one', () => {
    expect(matchKeyOptions(COLUMNS, 1)).toEqual([
      { id: 3, label: 'post_id · identifier' },
      { id: 2, label: 'respondent_no · number' },
      { id: 6, label: 'second_text · text' },
    ])
  })

  it('🔴 offers NOTHING from another dataset — the server refuses it', () => {
    expect(matchKeyOptions(COLUMNS, 1).map(o => o.id)).not.toContain(5)
  })

  it('offers nothing until a coded column is chosen, or when it is unknown', () => {
    expect(matchKeyOptions(COLUMNS, null)).toEqual([])
    expect(matchKeyOptions(COLUMNS, 999)).toEqual([])
  })
})
