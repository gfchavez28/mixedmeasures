import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveBreadcrumbs } from '@/layouts/breadcrumbs'
import { SRC_DIR } from '@/test-support/source-tree'
import { CONTEXT_HINT_MAX, scratchpadContextHint } from './scratchpad-context'

const hint = (path: string, pageLabel = '', search = '') =>
  scratchpadContextHint(deriveBreadcrumbs(path, 'Study', 1), pageLabel, search)

/**
 * Every route under the project, with ids filled in — read from `App.tsx` so a
 * new route is covered the day it lands (the population, not a list I kept).
 */
function projectRoutes(): string[] {
  const app = readFileSync(join(SRC_DIR, 'App.tsx'), 'utf8')
  const nested = [...app.matchAll(/<Route path="([a-z][^"]*)" element=/g)].map(m => m[1])
  return nested.map(p => `/projects/1/${p.replace(/:[A-Za-z]+/g, '7')}`)
}

describe('#1002 — a scratchpad note says where it was jotted', () => {
  it('says "Project overview" only on the overview', () => {
    expect(hint('/projects/1/overview')).toBe('Project overview')
    const routes = projectRoutes()
    expect(routes.length).toBeGreaterThan(25)   // the scan read App.tsx's routes
    const misfiled = routes.filter(r => !r.endsWith('/overview') && hint(r) === 'Project overview')
    expect(misfiled, 'these pages filed their notes under the overview').toEqual([])
  })

  it('names the pages the old list did not — documents, observations, codebook, ratings, participants', () => {
    expect(hint('/projects/1/documents/4', 'Interview notes.pdf')).toBe('Documents › Interview notes.pdf')
    expect(hint('/projects/1/observations/2', 'Classroom 3')).toBe('Observations › Classroom 3')
    expect(hint('/projects/1/analysis/codebook')).toBe('Analysis › Codebook')
    expect(hint('/projects/1/analysis/ratings')).toBe('Analysis › Ratings')
    expect(hint('/projects/1/participants')).toBe('Participants')
    expect(hint('/projects/1/coding-import')).toBe('Import codings')
  })

  it('adds the page’s own name when no crumb carries it — a canvas names itself only that way', () => {
    expect(hint('/projects/1/analysis/canvas', 'Findings draft')).toBe('Analysis › Canvas › Findings draft')
    // …and never twice when a crumb already does.
    const crumbs = deriveBreadcrumbs('/projects/1/conversations/3', 'Study', 1)
    crumbs[2] = { ...crumbs[2], label: 'Interview 3' }
    expect(scratchpadContextHint(crumbs, 'Interview 3', '')).toBe('Conversations › Interview 3')
  })

  it('keeps the Relationships & Comparisons tab, which the trail cannot see', () => {
    expect(hint('/projects/1/analysis/quantitative', '', '?tab=rc'))
      .toBe('Analysis › Quantitative › Relationships & Comparisons')
    expect(hint('/projects/1/analysis/quantitative')).toBe('Analysis › Quantitative')
  })

  it('never exceeds the server’s limit — a 255-character name failed the whole save', () => {
    const long = 'é'.repeat(300)
    const out = hint('/projects/1/conversations/3', long)
    expect(Array.from(out)).toHaveLength(CONTEXT_HINT_MAX)
    expect(out.endsWith('…')).toBe(true)
    // The limit is the server's: held to `schemas/scratchpad.py` here.
    const schema = readFileSync(join(SRC_DIR, '..', '..', 'backend', 'app', 'schemas', 'scratchpad.py'), 'utf8')
    expect(schema).toMatch(new RegExp(`context_hint: str \\| None = Field\\(None, max_length=${CONTEXT_HINT_MAX}\\)`))
  })

  it('an unresolved entity name leaves the workspace, never a dangling separator', () => {
    expect(hint('/projects/1/conversations/3')).toBe('Conversations')
  })
})
