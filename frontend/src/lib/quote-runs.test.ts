/**
 * #1324 — the boundary sweep that lets quotes overlap and nest.
 *
 * The ORACLE here is per-character and brute force: for every code point, the set of
 * quotes whose [start, end) contains it. It is derived from the quotes alone, never
 * from `quoteRuns`, so it can disagree with it (an oracle, not a mirror).
 */
import { describe, it, expect } from 'vitest'
import { quoteRuns, quoteRunClass, quoteLabel, QUOTE_LABEL_MAX, compareQuotesInPassageOrder } from './quote-runs'
import { codePointLength, sliceByCodePoints } from './text-offsets'
import { mulberry32, randomQuoteSet } from '@/test-support/seeded-random'

const TURN = 'We rolled it out in March and nobody was ready.'
const ASTRAL = 'Reaction 😀 then CODE THIS PHRASE and 𠀀 more 👨‍👩‍👧‍👦 at the end 🇺🇸.'

function coverageOracle(length: number, quotes: { id: number; start_offset: number; end_offset: number }[]): number[][] {
  const out: number[][] = []
  for (let i = 0; i < length; i++) {
    out.push(quotes.filter(q => q.start_offset <= i && i < q.end_offset).map(q => q.id).sort((a, b) => a - b))
  }
  return out
}

describe('quoteRuns — the filed shapes', () => {
  it('a nested pair: three runs, the inner one under both quotes, outer listed first', () => {
    const runs = quoteRuns(TURN, [
      { id: 2, start_offset: 10, end_offset: 14 },
      { id: 1, start_offset: 0, end_offset: 47 },
    ])
    expect(runs).toEqual([
      { start: 0, end: 10, quoteIds: [1] },
      { start: 10, end: 14, quoteIds: [1, 2] },
      { start: 14, end: 47, quoteIds: [1] },
    ])
  })

  it('a crossing pair: the shared middle is ONE run under both', () => {
    const runs = quoteRuns(TURN, [
      { id: 1, start_offset: 4, end_offset: 23 },
      { id: 2, start_offset: 15, end_offset: 34 },
    ])
    expect(runs.map(r => [r.start, r.end, r.quoteIds])).toEqual([
      [0, 4, []], [4, 15, [1]], [15, 23, [1, 2]], [23, 34, [2]], [34, 47, []],
    ])
  })

  it('whole-segment quotes take no part (they are not ranges in the text)', () => {
    expect(quoteRuns(TURN, [{ id: 9, start_offset: null, end_offset: null }]))
      .toEqual([{ start: 0, end: 47, quoteIds: [] }])
  })

  it('past damage is clamped, and a quote wholly outside the text draws NO empty run', () => {
    const runs = quoteRuns('short', [
      { id: 1, start_offset: 2, end_offset: 99 },
      { id: 2, start_offset: 40, end_offset: 50 },
    ])
    expect(runs).toEqual([
      { start: 0, end: 2, quoteIds: [] },
      { start: 2, end: 5, quoteIds: [1] },
    ])
  })

  it('an empty text has no runs', () => {
    expect(quoteRuns('', [{ id: 1, start_offset: 0, end_offset: 3 }])).toEqual([])
  })
})

describe('quoteRuns — PROPERTY over seeded random quote sets (astral text)', () => {
  const TEXTS = [TURN, ASTRAL, '😀😀😀😀😀😀😀😀😀😀', 'a']
  const SEEDS = 2000

  it('tiles the text exactly, each run carries exactly the quotes covering its characters, and no two neighbours carry the same set', () => {
    let deep = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = mulberry32(seed)
      const text = TEXTS[seed % TEXTS.length]
      const length = codePointLength(text)
      const quotes = randomQuoteSet(rnd, length)
      const runs = quoteRuns(text, quotes)
      const oracle = coverageOracle(length, quotes)

      // Tiling: contiguous from 0 to length — "each character once" by construction.
      expect(runs[0].start, `seed ${seed}`).toBe(0)
      expect(runs[runs.length - 1].end, `seed ${seed}`).toBe(length)
      for (let i = 1; i < runs.length; i++) expect(runs[i].start).toBe(runs[i - 1].end)
      expect(runs.map(r => sliceByCodePoints(text, r.start, r.end)).join(''), `seed ${seed}`).toBe(text)

      for (const [i, run] of runs.entries()) {
        expect(run.end, `seed ${seed}: empty run`).toBeGreaterThan(run.start)
        for (let c = run.start; c < run.end; c++) {
          expect([...run.quoteIds].sort((a, b) => a - b), `seed ${seed} char ${c}`).toEqual(oracle[c])
        }
        if (i > 0) expect(run.quoteIds, `seed ${seed}: a cut that changes nothing`).not.toEqual(runs[i - 1].quoteIds)
        if (run.quoteIds.length >= 2) deep++
      }
    }
    // Population floor: the generator must produce overlap, or the coverage arm is idle.
    expect(deep).toBeGreaterThan(SEEDS / 2)
  })
})

describe('quoteRunClass — the overlap is visible', () => {
  it('two or more quotes draw a different highlight from one, and three draw the same as two', () => {
    expect(quoteRunClass(2)).not.toBe(quoteRunClass(1))
    expect(quoteRunClass(3)).toBe(quoteRunClass(2))
  })

  it('one quote keeps the pre-#1324 amber exactly', () => {
    expect(quoteRunClass(1)).toContain('bg-amber-100 dark:bg-amber-900/30')
    expect(quoteRunClass(1)).toContain('border-amber-400 dark:border-amber-600')
  })
})

describe('compareQuotesInPassageOrder — the row menu reads outer first (D25)', () => {
  it('whole-segment first, then by start, and at a shared start the longer quote first', () => {
    // Given in an order the sort must change on every axis it decides.
    const given = [
      { id: 1, start_offset: 10, end_offset: 14 },
      { id: 2, start_offset: 0, end_offset: 36 },
      { id: 3, start_offset: 0, end_offset: 47 },
      { id: 4, start_offset: null, end_offset: null },
      { id: 5, start_offset: 4, end_offset: 23 },
    ]
    expect([...given].sort(compareQuotesInPassageOrder).map(q => q.id)).toEqual([4, 3, 2, 5, 1])
  })
})

describe('quoteLabel — a menu item names ONE quote', () => {
  it('two nested quotes sharing a start get different labels', () => {
    const a = quoteLabel(TURN, 0, 47)
    const b = quoteLabel(TURN, 0, 36)
    // The pre-#1324 label: the first 30 UTF-16 units — identical for both.
    expect(TURN.slice(0, 47).slice(0, 30)).toBe(TURN.slice(0, 36).slice(0, 30))
    expect(a).not.toBe(b)
    expect(a.startsWith('We rolled')).toBe(true)
    expect(a.endsWith('ready.')).toBe(true)
  })

  it('a short quote is its words', () => {
    expect(quoteLabel(TURN, 30, 36)).toBe('nobody')
  })

  it('a long quote is cut at word boundaries, never inside a word', () => {
    // Both halves of TURN fall mid-word at the code-point cut ("…it o" and "ody…").
    expect(quoteLabel(TURN, 0, 47)).toBe('We rolled it…was ready.')
    expect(quoteLabel(TURN, 0, 36)).toBe('We rolled it…and nobody')
    // The drive's case (2026-11-01d): it read "what would be…l expectations".
    const turn9 = 'And what would be your personal expectations in promoting scientific integrity?'
    expect(quoteLabel(turn9, 4, 44)).toBe('what would be…expectations')
    expect(quoteLabel(turn9, 0, 79)).toBe('And what would…integrity?')
  })

  it('a half with no space keeps its code-point cut rather than vanishing', () => {
    const word = 'Antidisestablishmentarianism-and-more-besides-this'
    const label = quoteLabel(word, 0, codePointLength(word))
    expect(label).toBe(`${word.slice(0, 14)}…${word.slice(-14)}`)
    // A quote that starts with a space: trimming back to it would leave no head.
    const spaced = ' Antidisestablishmentarianism words at the end here'
    expect(quoteLabel(spaced, 0, codePointLength(spaced)).split('…')[0]).toBe(' Antidisestabl')
  })

  it('never splits a surrogate pair, and stays within the budget in code points', () => {
    const text = '😀'.repeat(50)
    const label = quoteLabel(text, 0, 50)
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    expect(codePointLength(label)).toBeLessThanOrEqual(QUOTE_LABEL_MAX)
  })
})
