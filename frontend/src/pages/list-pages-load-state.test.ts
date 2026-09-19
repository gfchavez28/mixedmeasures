/**
 * #963 — the list pages, as a POPULATION.
 *
 * Every one of these renders a "No … yet" screen with a create or import
 * affordance beside it, and every one gated that screen on `isLoading` alone.
 * **React Query v5 reports `isLoading` as `false` once a failure has SETTLED**
 * (`isPending && isFetching`), so a failed load fell straight through to the
 * first-run screen. Driven on the running app: the conversations page said *"No
 * conversations yet"* with the Import button, while the nav rail beside it still
 * showed **12** from a different query.
 *
 * Written as a population assertion with a per-file self-check rather than a
 * test per page: this rule has shipped partially before — three times for
 * #771/#785 — because each pass fixed the instance in front of it. A seventh
 * list page must fail this file until it decides.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '@/lib/strip-comments'
import { SRC_DIR } from '@/test-support/source-tree'

/** file → the `ListLoad` its empty screen waits on, and the words it guards. */
const PAGES: { file: string; load: string; claim: string }[] = [
  { file: 'pages/Dashboard.tsx', load: 'projectsLoad', claim: 'No projects yet' },
  { file: 'pages/ConversationsListPage.tsx', load: 'conversationsLoad', claim: 'No conversations yet' },
  { file: 'pages/DocumentsListPage.tsx', load: 'documentsLoad', claim: 'No documents yet' },
  { file: 'pages/DatasetsListPage.tsx', load: 'datasetsLoad', claim: 'No datasets yet' },
  { file: 'pages/ObservationsListPage.tsx', load: 'observationsLoad', claim: 'No observations yet' },
  { file: 'pages/ParticipantsPage.tsx', load: 'participantsLoad', claim: 'No participants yet' },
  // The words live in `components/crosswalk/CrosswalkEmptyState.tsx`; what
  // this page owns is the decision to MOUNT it.
  { file: 'pages/CrosswalkView.tsx', load: 'crosswalkLoad', claim: '<CrosswalkEmptyState' },
]

const source = (file: string) =>
  stripComments(readFileSync(join(SRC_DIR, file), 'utf8'), file.split('/').pop())

describe('#963 — a list page says "none yet" only of an answered query', () => {
  it('scans the whole population', () => {
    // A floor, so a deletion that empties the list fails loudly rather than
    // passing by finding nothing.
    expect(PAGES.length).toBeGreaterThanOrEqual(7)
  })

  for (const page of PAGES) {
    describe(page.file, () => {
      const src = source(page.file)

      it('can still see the code it is scanning', () => {
        expect(src).toContain(page.claim)
        expect(src.length).toBeGreaterThan(2_000)
      })

      it('derives a ListLoad and gates the empty screen on it', () => {
        expect(src).toMatch(new RegExp(`const\\s+${page.load}\\s*=\\s*useListLoad\\(`))
        expect(src).toMatch(new RegExp(`${page.load}\\.status\\s*!==\\s*'ready'`))
      })

      it('no longer gates that screen on isLoading, which a settled failure reports false', () => {
        // The pages keep other `isLoading`s for unrelated detail queries; what
        // must be gone is the one that decided the EMPTY SCREEN. Both shapes the
        // seven used are banned.
        expect(src).not.toMatch(/^\s*if \(isLoading\) \{/m)
        expect(src).not.toMatch(/\{isLoading \? \(/)
      })

      it('does not ask the server again for an answer it already gave', () => {
        expect(src).toContain('retry: retryUnanswered')
      })
    })
  }

  it('the crosswalk waits on ALL THREE of its lists, not the first one to answer', () => {
    // §1 of the internal design notes: a claim that rests on several
    // lists is only as known as the least-known one. "No variable groups yet"
    // with Suggest Groups beside it rests on the project's columns, its domains
    // AND its equivalence groups — a mutant narrowing this to one query is
    // invisible to the generic assertions above, which is why it is named here.
    const src = source('pages/CrosswalkView.tsx')
    const at = src.indexOf('const crosswalkLoad = useListLoad(')
    expect(at).toBeGreaterThan(-1)
    const call = src.slice(at, src.indexOf(')', at) + 1)
    for (const q of ['allColumnsQuery', 'domainsQuery', 'equivalenceGroupsQuery']) {
      expect(call).toContain(q)
    }
  })

  it('the gate predicate is falsifiable', () => {
    // A scan whose predicate matches anything certifies nothing.
    const fake = 'if (rows.length === 0) return <EmptyState />'
    expect(fake).not.toMatch(/\w+Load\.status\s*!==\s*'ready'/)
  })

  it('the isLoading ban is falsifiable', () => {
    expect('  if (isLoading) {').toMatch(/^\s*if \(isLoading\) \{/m)
    expect('        {isLoading ? (').toMatch(/\{isLoading \? \(/)
  })
})
