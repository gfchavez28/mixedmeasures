/**
 * #932 — a rendered list order must not depend on the server's incidental one.
 *
 * The defect that produced these cases: setting a document's subject moved its
 * card from last to first of fourteen. The filed cause was "the write moves the
 * sort key", and the code says otherwise — the key is `created_at`, which a
 * subject change cannot touch. What moves is `Document.updated_at`, which is
 * what the LIST ENDPOINT orders by, and every one of those fourteen documents
 * shares one `created_at` (measured: 14 of 14 on the `pd_audit` corpus, 4 on
 * `dev.db` — `CURRENT_TIMESTAMP` has second precision, so a batch import ties).
 *
 * `Array.sort` is stable, so a tie renders the INPUT order, and the input is
 * whatever the server sent. The tie-break is the whole fix.
 */
import { describe, it, expect } from 'vitest'
import { compareSources, sortSources, sourceProgress } from './source-list-sort'

interface Doc {
  id: number
  name: string
  created_at: string
  segment_count: number
  coded_segment_count: number
}

const doc = (id: number, over: Partial<Doc> = {}): Doc => ({
  id,
  name: `Workplan ${id}`,
  created_at: '2026-09-08 14:40:28',
  segment_count: 10,
  coded_segment_count: 0,
  ...over,
})

const dateOf = (d: Doc) => d.created_at
const order = (items: Doc[], by: 'name' | 'date' | 'progress', dir: 'asc' | 'desc' = 'desc') =>
  sortSources(items, by, dir, dateOf).map(d => d.id)

describe('a tied ordering does not follow the input', () => {
  it('🔴 renders the same order whichever order the server sent', () => {
    // THE defect, at the grain it actually occurred: fourteen documents, one
    // timestamp, and the endpoint re-ordering them by `updated_at` after an edit.
    const asImported = [doc(1), doc(2), doc(3)]
    const afterAnEdit = [doc(2), doc(1), doc(3)]   // doc 2 was touched, so it leads

    expect(order(asImported, 'date')).toEqual(order(afterAnEdit, 'date'))
  })

  it('breaks the tie on id, so a batch reads in the order it was added', () => {
    expect(order([doc(3), doc(1), doc(2)], 'date', 'asc')).toEqual([1, 2, 3])
  })

  it('carries the tie-break through the direction flip', () => {
    // Newest first for a tied batch means most-recently-ADDED first, or the two
    // halves of "descending" would disagree with each other.
    expect(order([doc(1), doc(2), doc(3)], 'date', 'desc')).toEqual([3, 2, 1])
  })

  it('ties on PROGRESS too, which is the commoner case', () => {
    // Every uncoded source has progress 0, so an untouched project is ALL ties.
    const uncoded = [doc(7), doc(4), doc(9)]
    expect(order(uncoded, 'progress', 'asc')).toEqual([4, 7, 9])
    expect(order([...uncoded].reverse(), 'progress', 'asc')).toEqual([4, 7, 9])
  })

  it('ties on identical NAMES', () => {
    const same = [doc(5, { name: 'Report' }), doc(2, { name: 'Report' })]
    expect(order(same, 'name', 'asc')).toEqual([2, 5])
  })
})

describe('the primary key still decides when it can', () => {
  it('orders by date when the dates differ', () => {
    const older = doc(9, { created_at: '2026-01-01 00:00:00' })
    const newer = doc(1, { created_at: '2026-09-01 00:00:00' })
    expect(order([older, newer], 'date', 'desc')).toEqual([1, 9])
    expect(order([older, newer], 'date', 'asc')).toEqual([9, 1])
  })

  it('orders by progress when the coding differs', () => {
    const half = doc(1, { coded_segment_count: 5 })
    const none = doc(2)
    expect(order([none, half], 'progress', 'desc')).toEqual([1, 2])
  })

  it('orders by name, case-insensitively as `localeCompare` does', () => {
    const a = doc(2, { name: 'apple' })
    const b = doc(1, { name: 'Banana' })
    expect(order([b, a], 'name', 'asc')).toEqual([2, 1])
  })
})

describe('the edges', () => {
  it('falls back to the tie-break when a date will not parse', () => {
    // `new Date('') - new Date(x)` is NaN, which orders nothing. The pair must
    // still come back in a consistent order rather than in whichever order they
    // arrived. ⚠️ This does NOT distinguish `Number.isFinite` from a `cmp || tie`
    // reduction — they agree on every value reachable here, which is recorded at
    // the comparator so nobody "hardens" one into the other believing it matters.
    const broken = doc(2, { created_at: 'not a date' })
    const fine = doc(1)
    expect(compareSources(broken, fine, 'date', 'asc', dateOf)).toBe(1)
    expect(compareSources(fine, broken, 'date', 'asc', dateOf)).toBe(-1)
  })

  it('never mutates its input', () => {
    const items = [doc(3), doc(1)]
    sortSources(items, 'date', 'asc', dateOf)
    expect(items.map(d => d.id)).toEqual([3, 1])
  })

  it('reports zero progress for a source with nothing to code', () => {
    expect(sourceProgress(doc(1, { segment_count: 0 }))).toBe(0)
  })
})
