/**
 * #1184 — the import wizards' ONE step rail.
 *
 * jsdom computes no layout, so the narrow-window collapse is pinned as TECHNIQUE
 * (which class a label carries) and was driven at 640×360 and 1280×800. What this
 * file owns: the three states and what each SAYS, the accent tokens, the position
 * a wizard's mapping produces, and — by a source scan — that no wizard draws a rail
 * of its own.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { sourceFiles, srcRel } from '@/test-support/source-tree'
import ImportStepRail, { type StepRailAccent } from './ImportStepRail'
import { AFTER_LAST_STEP, RAIL_COLLAPSED_LABEL, RAIL_DONE_TEXT, railPosition } from '@/lib/step-rail'

const STEPS = [
  { key: 'upload', label: 'Upload' },
  { key: 'columns', label: 'Columns' },
  { key: 'speakers', label: 'Speakers' },
] as const

afterEach(cleanup)

function rail(current: string, accent: StepRailAccent = 'primary') {
  render(<ImportStepRail label="Import progress" steps={STEPS} current={current as 'upload'} accent={accent} />)
  const nav = screen.getByRole('navigation', { name: 'Import progress' })
  const items = within(nav).getAllByRole('listitem')
  return { nav, items }
}

describe('the three states', () => {
  it('is a list in the named landmark, one item per step', () => {
    const { nav, items } = rail('columns')
    expect(within(nav).getByRole('list').tagName).toBe('OL')
    expect(items).toHaveLength(3)
  })

  it('done says so in words; current is aria-current; future is neither', () => {
    const { items } = rail('columns')
    expect(items[0]).toHaveTextContent(`Upload${RAIL_DONE_TEXT}`)
    expect(items[0]).not.toHaveAttribute('aria-current')
    expect(items[1]).toHaveAttribute('aria-current', 'step')
    expect(items[1]).toHaveTextContent(/^2Columns$/)
    expect(items[2]).not.toHaveAttribute('aria-current')
    expect(items[2]).not.toHaveTextContent(RAIL_DONE_TEXT.trim())
    expect(RAIL_DONE_TEXT).toBe(', completed')
  })

  it('a done step shows a Check, the rest their number — and the circle is hidden from readers', () => {
    const { items } = rail('speakers')
    const circle = (li: HTMLElement) => li.firstElementChild as HTMLElement
    expect(circle(items[0]).querySelector('svg')).not.toBeNull()
    expect(circle(items[2])).toHaveTextContent('3')
    for (const li of items) expect(circle(li)).toHaveAttribute('aria-hidden', 'true')
  })

  it('past the last step: every step done, none current', () => {
    const { items } = rail(AFTER_LAST_STEP)
    for (const li of items) {
      expect(li).toHaveAttribute('data-step-state', 'done')
      expect(li).not.toHaveAttribute('aria-current')
    }
  })

  it('a key not on the rail marks nothing current — what a total mapping prevents', () => {
    expect(railPosition(STEPS, 'importing')).toBe(-1)
    expect(railPosition(STEPS, AFTER_LAST_STEP)).toBe(3)
    expect(railPosition(STEPS, 'columns')).toBe(1)
  })
})

describe('narrow windows', () => {
  it('only the CURRENT label escapes the collapse, and it collapses with sr-only, never hidden', () => {
    const { items } = rail('columns')
    const label = (li: HTMLElement) => within(li).getByText(STEPS[items.indexOf(li)].label)
    expect(label(items[1]).className).not.toContain(RAIL_COLLAPSED_LABEL)
    expect(label(items[0]).className).toContain(RAIL_COLLAPSED_LABEL)
    expect(label(items[2]).className).toContain(RAIL_COLLAPSED_LABEL)
    expect(RAIL_COLLAPSED_LABEL).toMatch(/^@max-\[[\d.]+rem\]\/steps:sr-only$/)
    expect(RAIL_COLLAPSED_LABEL).not.toMatch(/\bhidden\b|not-sr-only/)
  })

  it('the nav declares the named container the collapse queries (#899: a missing one is silent)', () => {
    const { nav } = rail('upload')
    expect(nav.className).toContain('@container/steps')
  })
})

describe('accents name defined tokens', () => {
  const cases: [StepRailAccent, string, string][] = [
    ['primary', 'bg-primary text-primary-foreground', 'bg-primary/15 text-primary'],
    ['orange', 'bg-mm-orange-fill text-mm-on-fill', 'bg-mm-orange/15 text-mm-orange-text'],
    ['teal', 'bg-mm-teal-fill text-mm-on-fill', 'bg-mm-teal/15 text-mm-teal-text'],
    ['purple', 'bg-mm-purple-fill text-mm-on-fill', 'bg-mm-purple/15 text-mm-purple-text'],
  ]
  for (const [accent, current, done] of cases) {
    it(`${accent}: current on its fill, done on its tint`, () => {
      const { items } = rail('columns', accent)
      const circle = (li: HTMLElement) => (li.firstElementChild as HTMLElement).className
      expect(circle(items[1])).toContain(current)
      expect(circle(items[0])).toContain(done)
      expect(circle(items[2])).toContain('bg-mm-border-subtle text-mm-text-secondary')
      expect(circle(items[1])).not.toMatch(/text-white|bg-purple-\d/)
      cleanup()
    })
  }
})

/**
 * POPULATION: the seven wizards draw their rail through this component and nothing
 * else writes `aria-current` "step". Enumerated by what a rail DOES (the attribute),
 * never by its landmark name — the Start-here block's `Import progress` search
 * missed Merge's rail.
 */
describe('every import wizard uses the one rail', () => {
  const WIZARDS = [
    'pages/AppendImport.tsx', 'pages/CodingImport.tsx', 'pages/ConversationImport.tsx',
    'pages/DatasetImport.tsx', 'pages/DocumentImport.tsx', 'pages/MergeProject.tsx',
    'pages/ObservationImport.tsx',
  ]
  const STEP_CURRENT = /aria-current=\{[^}]*['"]step['"]|aria-current=["']step["']/
  const files = sourceFiles({ ext: 'tsx', floor: 100 })
  const stripped = new Map<string, string>()
  for (const abs of files) {
    const raw = readFileSync(abs, 'utf-8')
    if (raw.includes('ImportStepRail') || /aria-current/.test(raw)) stripped.set(srcRel(abs), stripComments(raw))
  }

  it('finds the seven wizards (self-check: the scan can see its population)', () => {
    for (const w of WIZARDS) expect(stripped.has(w), `${w} not scanned`).toBe(true)
  })

  it('each renders <ImportStepRail', () => {
    const missing = WIZARDS.filter(w => !/<ImportStepRail\b/.test(stripped.get(w) ?? ''))
    expect(missing).toEqual([])
  })

  it('no file but the component writes aria-current "step"', () => {
    const writers = [...stripped].filter(([, src]) => STEP_CURRENT.test(src)).map(([rel]) => rel)
    expect(writers).toEqual(['components/ImportStepRail.tsx'])
  })

  it('the predicate fires on both shapes a hand-written rail used (falsifier)', () => {
    expect(STEP_CURRENT.test(`aria-current={stepIndex === i ? 'step' : undefined}`)).toBe(true)
    expect(STEP_CURRENT.test(`aria-current="step"`)).toBe(true)
    expect(STEP_CURRENT.test(`aria-current={isCurrent ? 'page' : undefined}`)).toBe(false)
  })
})
