import { describe, it, expect } from 'vitest'
import type { Coder, CodingImportCoderCandidate, ProjectColumnInfo } from '@/lib/api'
import {
  CODER_NAME_MAX_LENGTH, MAPPING_INTRO, coderOptionLabel, draftBlocker, initialDraft,
  matchKeyOptions, namesSharingACoder, sharedCreateConflicts, takenNameSuffix,
  toDecision, type CoderDraft,
} from './coding-import-mapping'

const candidate = (over: Partial<CodingImportCoderCandidate> = {}): CodingImportCoderCandidate => ({
  name: 'GPT-4o', row_count: 3, rows_to_apply: 3, local_user_id: null, local_coder_type: null,
  local_archived: false, local_application_count: 0, local_machine_provenance: null,
  ...over,
})

describe('initialDraft', () => {
  it('🔴 #1193: a name match starts UNANSWERED with its coder one click away; CREATE for an unknown name', () => {
    expect(initialDraft(candidate()).action).toBe('create')
    expect(initialDraft(candidate({ local_user_id: 4 }))).toMatchObject({
      action: null, targetUserId: 4,
    })
    expect(draftBlocker('Researcher', initialDraft(candidate({ local_user_id: 4 }))))
      .toBe('Choose whether “Researcher” is an existing coder, a new coder, or not imported.')
    // Answered "An existing coder" with nothing else touched: the same-name coder.
    const answered: CoderDraft = { ...initialDraft(candidate({ local_user_id: 4 })), action: 'match' }
    expect(draftBlocker('Researcher', answered)).toBeNull()
    expect(toDecision(answered)).toEqual({ action: 'match', target_user_id: 4 })
  })

  it('🔴 #1193: NO candidate shape starts at match — the intro says so unconditionally', () => {
    const shapes = [
      candidate(), candidate({ local_user_id: 4 }), candidate({ local_user_id: 4, local_archived: true }),
      candidate({ local_user_id: 4, local_coder_type: 'ai' }), candidate({ rows_to_apply: 0, local_user_id: 4 }),
    ]
    expect(shapes.map(c => initialDraft(c).action)).not.toContain('match')
    expect(MAPPING_INTRO).toMatch(/Nothing is matched by name on your behalf/)
  })

  it('an unanswered name never becomes a decision', () => {
    expect(() => toDecision(initialDraft(candidate({ local_user_id: 4 })))).toThrow(/not been answered/)
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
  const base: CoderDraft = { ...initialDraft(candidate({ local_user_id: 4 })), action: 'match' }

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
      .toBe('Say whether “GPT-4o” is a person or a machine.')
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

describe('namesSharingACoder (#1039 i, #1082 b)', () => {
  const d = (targetUserId: number | null, action: CoderDraft['action'] = 'match', newUsername = ''): CoderDraft =>
    ({ ...initialDraft(candidate()), action, targetUserId, newUsername })

  it('pairs the names that go to ONE coder, and nothing else', () => {
    const shared = namesSharingACoder({
      Alice: d(1), alice: d(1), Bob: d(2), New: d(1, 'create'), Unset: d(null),
    })
    expect(shared.get('Alice')).toEqual(['alice'])
    expect(shared.get('alice')).toEqual(['Alice'])
    expect(shared.has('Bob')).toBe(false)
    // A create lands on the coder its NEW NAME makes — never on an existing coder,
    // whatever id its draft happens to carry.
    expect(shared.has('New')).toBe(false)
    expect(shared.has('Unset')).toBe(false)
  })

  it('🔴 two names CREATED under one new name are one coder (#1082 b)', () => {
    const shared = namesSharingACoder({
      'A. Smith': d(null, 'create', 'Alice Smith'),
      asmith: d(null, 'create', ' Alice Smith '),   // trimmed, as the server does
      Other: d(null, 'create', 'Alice smith'),       // another spelling is another name
    })
    expect(shared.get('A. Smith')).toEqual(['asmith'])
    expect(shared.get('asmith')).toEqual(['A. Smith'])
    expect(shared.has('Other')).toBe(false)
  })

  it('the FILE’s name is the new name when none is typed', () => {
    const shared = namesSharingACoder({ Alice: d(null, 'create'), alice: d(null, 'create', 'Alice') })
    expect(shared.get('alice')).toEqual(['Alice'])
  })
})

describe('sharedCreateConflicts (#1082 b)', () => {
  const create = (newUsername: string, coderType: CoderDraft['coderType'], model = ''): CoderDraft =>
    ({ ...initialDraft(candidate()), action: 'create', newUsername, coderType, model })

  it('a person and a model under one name cannot be one coder', () => {
    expect(sharedCreateConflicts({ Alice: create('Shared', 'human'), Bot: create('Shared', 'ai') }))
      .toEqual(['“Alice” and “Bot” are both to become a new coder called “Shared”, '
        + 'but one is a person and the other a machine. Give them different names.'])
  })

  it('two model configurations under one name cannot either', () => {
    const out = sharedCreateConflicts({ a: create('GPT', 'ai', 'gpt-4o'), b: create('GPT', 'ai', 'gpt-4o-mini') })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/different model configurations/)
  })

  it('#1150 (b): settings typed in another ORDER are one configuration, as the server reads them', () => {
    // The server compares dicts; the page compared `JSON.stringify`, which keeps the
    // order typed — so these were refused on the page and accepted by the server.
    const a = { ...create('GPT', 'ai', 'gpt-4o'), parameters: 'temperature=0\ntop_p=1' }
    const b = { ...create('GPT', 'ai', 'gpt-4o'), parameters: 'top_p=1\ntemperature=0' }
    expect(sharedCreateConflicts({ a, b })).toEqual([])
    const c = { ...create('GPT', 'ai', 'gpt-4o'), parameters: 'top_p=1\ntemperature=1' }
    expect(sharedCreateConflicts({ a, c })).toHaveLength(1)
  })

  it('agreeing ones are fine — and an unchosen kind is left to its own blocker', () => {
    expect(sharedCreateConflicts({ a: create('GPT', 'ai', 'gpt-4o'), b: create('GPT', 'ai', 'gpt-4o') })).toEqual([])
    expect(sharedCreateConflicts({ a: create('X', 'human'), b: create('X', null) })).toEqual([])
    expect(sharedCreateConflicts({ a: create('X', 'human'), b: create('Y', 'ai') })).toEqual([])
  })
})

describe('takenNameSuffix (#1082 b)', () => {
  const roster = [
    { id: 1, username: 'Alice', coder_type: 'human' },
    { id: 2, username: 'Alice (2)', coder_type: 'human', archived: true },
  ] as Coder[]

  it('predicts the number the server adds, past an archived holder too', () => {
    expect(takenNameSuffix('Alice', roster)).toBe('Alice (3)')
  })

  it('says nothing for a free name — the match is exact, as the server’s is', () => {
    expect(takenNameSuffix('Bob', roster)).toBeNull()
    expect(takenNameSuffix('alice', roster)).toBeNull()
  })

  it('#1150 (c): skips a number another card TYPED, as the server reserves it', () => {
    // An existing "Alice"; one card creates "Alice", another "Alice (3)". The server
    // reserves every typed name before numbering, so the first becomes "Alice (4)".
    const typed = new Set(['Alice', 'Alice (3)'])
    expect(takenNameSuffix('Alice', roster, typed)).toBe('Alice (4)')
    // A card's OWN typed name is not reserved against itself.
    expect(takenNameSuffix('Alice (3)', roster, typed)).toBeNull()
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
