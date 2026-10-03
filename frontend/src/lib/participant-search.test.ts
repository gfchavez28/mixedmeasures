/**
 * #1045 / #1052 — the ONE search-and-bound rule for a project's participant
 * list. The three surfaces that render the list each have their own render
 * test; this file owns the ranking and the words.
 */
import { describe, it, expect } from 'vitest'
import type { Participant } from '@/lib/api/participants'
import {
  PARTICIPANT_LIST_LIMIT,
  pickerLimitNote,
  searchParticipants,
  shownOfTotal,
} from './participant-search'

function p(id: number, identifier: string, over: Partial<Participant> = {}): Participant {
  return {
    id,
    project_id: 1,
    identifier,
    display_name: null,
    role: null,
    demographics: null,
    role_auto_filled_from: null,
    created_at: '',
    updated_at: '',
    linked_speakers: [],
    dataset_rows: [],
    linked_documents: [],
    ...over,
  } as Participant
}

describe('searchParticipants', () => {
  it('returns the list ITSELF for an empty or blank search — no copy, no filter', () => {
    const list = [p(1, 'A'), p(2, 'B')]
    expect(searchParticipants(list, '')).toBe(list)
    expect(searchParticipants(list, '   ')).toBe(list)
  })

  it('matches name, identifier and role, case-insensitively', () => {
    const list = [
      p(1, 'P001', { display_name: 'Ada Chen' }),
      p(2, 'P002', { role: 'Finance' }),
      p(3, 'P003'),
    ]
    expect(searchParticipants(list, 'ada').map(x => x.id)).toEqual([1])
    expect(searchParticipants(list, 'FINANCE').map(x => x.id)).toEqual([2])
    expect(searchParticipants(list, 'p003').map(x => x.id)).toEqual([3])
    expect(searchParticipants(list, 'zzz')).toEqual([])
  })

  it('ranks an EXACT match first, then prefix matches, then the rest', () => {
    // Server order is by identifier, so the exact id sorts AFTER ids that merely
    // contain it — the case that hides it behind a bounded list.
    const list = [p(1, '1123'), p(2, '11230'), p(3, '123'), p(4, '1230'), p(5, '4123')]
    expect(searchParticipants(list, '123').map(x => x.identifier)).toEqual([
      '123', // exact
      '1230', // prefix
      '1123', '11230', '4123', // contains, in server order
    ])
  })

  it('keeps the server order WITHIN a tier', () => {
    const list = [p(1, 'Bex'), p(2, 'Bea'), p(3, 'Ben')]
    expect(searchParticipants(list, 'be').map(x => x.id)).toEqual([1, 2, 3])
  })

  it('takes the BEST tier across fields — a role equal to the term is exact', () => {
    const list = [p(1, 'teacher-17'), p(2, 'P2', { role: 'Teacher' })]
    expect(searchParticipants(list, 'teacher').map(x => x.id)).toEqual([2, 1])
  })

  it('a later field that merely CONTAINS the term never demotes an earlier prefix match', () => {
    // Adaline's name starts with "ada"; her identifier contains it further in.
    // Listed after a contains-only participant, so a demotion would show.
    const list = [p(1, 'z-adam'), p(2, 'x-ada-7', { display_name: 'Adaline' })]
    expect(searchParticipants(list, 'ada').map(x => x.id)).toEqual([2, 1])
  })

  it('an exact match beyond the bound in server order still lands inside it', () => {
    // 500 ids containing "77" sort before the exact "77" (strings: "1077" < "77").
    const list = Array.from({ length: 500 }, (_, i) => p(i + 1, `1${String(i).padStart(3, '0')}77`))
    list.push(p(999, '77'))
    const shown = searchParticipants(list, '77').slice(0, PARTICIPANT_LIST_LIMIT)
    expect(shown[0].identifier).toBe('77')
  })

  it('answers the same for a second call on the same array (cached index)', () => {
    const list = [p(1, 'Ann'), p(2, 'Anna'), p(3, 'Joanne')]
    const first = searchParticipants(list, 'ann').map(x => x.id)
    expect(searchParticipants(list, 'ann').map(x => x.id)).toEqual(first)
    expect(first).toEqual([1, 2, 3])
  })
})

describe('the disclosure a bounded list owes', () => {
  it('says nothing when nothing is hidden', () => {
    expect(shownOfTotal(12, 12, false)).toBeNull()
    expect(pickerLimitNote(0, 0, true)).toBeNull()
  })

  it('names the shown and total counts, with the thousands separated', () => {
    expect(shownOfTotal(200, 20000, false)).toBe(
      `Showing the first 200 of ${(20000).toLocaleString()} participants`,
    )
    expect(shownOfTotal(200, 1234, true)).toBe(
      `Showing the first 200 of ${(1234).toLocaleString()} matching participants`,
    )
  })

  it('the picker form says what reaches the rest, and it differs while searching', () => {
    expect(pickerLimitNote(200, 900, false)).toMatch(/Type a name or ID to find the others\.$/)
    expect(pickerLimitNote(200, 900, true)).toMatch(/matching participants\. Keep typing to narrow the list\.$/)
  })
})
