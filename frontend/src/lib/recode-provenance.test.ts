/**
 * #587 — every path that COPIES a recode definition must record where it came
 * from (`source_definition_id`).
 *
 * Without it, the #578 startup repair's chain walk finds no reference for the
 * copy. Before the sibling fallback landed it skipped such defs FOREVER, leaving
 * a reverse recode stored FLIPPED — silently un-reversed — while its repaired
 * original was correct: one item battery, inconsistently coded, with no visual
 * cue, since display and storage agree and both are wrong.
 *
 * ⚠️ **This is a scan and not two component tests on purpose.** The filed issue
 * named `CopyRecodeDialog` and there were TWO dialogs doing this
 * (`CopyToEquivalentsDialog` is the crosswalk's other copy path). A test that
 * mounts the two we know about cannot fail for the third one somebody adds; a
 * scan over every caller can.
 *
 * ⚠️ **What this can and cannot see.** It asserts at FILE granularity: a module
 * that calls `recodeApi.create` must mention `source_definition_id`. That is
 * deliberate — `RecodeWorkbench` passes it CONDITIONALLY (only for a reverse
 * def, which is correct there), so a per-call-site assertion would flag correct
 * code. The cost is a false PASS if a file passes the field on one call and
 * omits it on another; the realistic regression — a new copy path that never
 * heard of provenance — is caught.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__snapshots__') continue
      walk(full, out)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Files that call `recodeApi.create`, with their text. */
function createCallers(): { path: string; text: string }[] {
  return walk(SRC)
    .map(path => ({ path, text: readFileSync(path, 'utf8') }))
    .filter(f => f.text.includes('recodeApi.create('))
}

describe('#587 — recode copies carry provenance', () => {
  it('finds the create call sites at all', () => {
    // #730: a scan whose walk resolves to nothing reports a clean bill of
    // health indistinguishable from real success. Assert the population first.
    const callers = createCallers()
    expect(callers.length).toBeGreaterThanOrEqual(2)
  })

  it('every module that creates a recode definition mentions source_definition_id', () => {
    const missing = createCallers()
      .filter(f => !f.text.includes('source_definition_id'))
      .map(f => f.path.slice(SRC.length + 1))
    expect(missing, [
      'These modules create a recode definition without recording where it came',
      'from. A copy with no `source_definition_id` is invisible to the #578',
      'startup repair chain: if it carries a flipped reverse mapping it stays',
      'silently un-reversed. Pass the source definition id, as CopyRecodeDialog',
      'and the backend `copy_to` endpoint both do.',
    ].join(' ')).toEqual([])
  })

  it('both crosswalk copy dialogs are covered', () => {
    // Named explicitly so that deleting one from the scan's reach (a rename, a
    // move) fails here rather than silently shrinking the population above.
    const covered = createCallers().map(f => f.path)
    for (const name of ['CopyRecodeDialog.tsx', 'CopyToEquivalentsDialog.tsx']) {
      expect(covered.some(p => p.endsWith(name)), `${name} no longer reaches the scan`)
        .toBe(true)
    }
  })
})
