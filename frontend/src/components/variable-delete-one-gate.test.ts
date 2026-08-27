import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { join } from 'node:path'

/**
 * Every surface that offers to DELETE a variable spends the one gate (#812).
 *
 * 🔴 **Why a population assertion.** The delete affordance already existed on
 * three triggers and they were gated three different ways — and two of the three
 * were wrong:
 *
 *   | trigger                                   | gate before this change      |
 *   |-------------------------------------------|------------------------------|
 *   | `ColumnEditorPopover`, manual branch      | `isManual \|\| imported` — 403s |
 *   | `ColumnEditorPopover`, computed branch    | `isComputed` — correct       |
 *   | `DatasetGridComponents` header menu       | none at all — 403s           |
 *
 * `delete_manual_column` refuses anything that is not `source="manual"`, so on
 * an imported corpus — every column of a real survey — two of those three opened
 * a confirm promising to *"permanently delete the column and all its data"* and
 * the server then answered 403. A confirmed destructive action that cannot
 * happen is worse than an absent one: the researcher has already decided to lose
 * the data by the time they learn they cannot.
 *
 * Writing this as "the popover is fixed" would have caught one of three. This is
 * the same shape as `variable-forms-one-home.test.ts` and for the same reason —
 * the rule has now shipped partially in this codebase often enough (#771 → #785,
 * #805 → #807) that a per-control test is not evidence.
 *
 * ⚠️ It asserts the gate is SPENT, not that it is spent correctly — a population
 * assertion pins the DECISION, never its correctness. What it makes impossible
 * is a fourth trigger arriving with no gate at all, which is exactly how the
 * third one arrived.
 */

const SRC = join(__dirname, '..')

/** The words a researcher clicks. Matched with comments stripped, because a scan
 *  that reads its own prose reports phantoms (#772, hit twice in this arc).
 *
 *  ⚠️ **`(?! group)` is load-bearing.** The crosswalk deletes *variable GROUPS*
 *  — analysis domains, an entirely different act with its own gate — and its
 *  three occurrences of "Delete variable group" matched the first draft of this
 *  detector, which would have forced a dataset-column predicate onto a domain
 *  surface. The probe was wrong before the code was. */
const DELETE_AFFORDANCE = /Delete variable(?! group)/

/**
 * The predicate every offering surface must consult.
 *
 * 🔴 **A CALL, and the import lines are stripped before matching.** The first
 * draft was a bare `/variableDeleteEndpoint/`, and mutation-testing it — swapping
 * the gate in `DatasetGridComponents` for a literal `true` — left it GREEN,
 * because the now-unused *import* still satisfied the regex. A scan for a name
 * cannot tell a use from a mention; the same lesson the `demographic_subtype`
 * guard learned when it fired on the badge that merely READS the field.
 */
const GATE = /variableDeleteEndpoint\s*\(/

/** Import statements are mentions, never uses — see `GATE`. */
function stripImports(src: string): string {
  return src.replace(/^\s*import[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
}

/**
 * Files that legitimately contain the words without gating.
 * Each needs a REASON, not just an entry — an unexplained allowlist is how a
 * guard is quietly disabled one line at a time.
 */
const ALLOWED = new Map<string, string>([
  [
    'components/DeleteVariableDialog.tsx',
    'the confirm itself — it renders DOWNSTREAM of the gate and never offers the act',
  ],
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      if (entry === 'node_modules' || entry === 'assets') continue
      walk(abs, out)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(abs)
    }
  }
  return out
}

describe('deleting a variable is gated in exactly one place', () => {
  const files = walk(SRC)
  const offering = files
    .map(abs => ({ rel: abs.slice(SRC.length + 1), src: stripComments(readFileSync(abs, 'utf8'), abs) }))
    .filter(f => DELETE_AFFORDANCE.test(f.src))

  it('found the surfaces at all (a scan resolving to nothing passes by finding nothing)', () => {
    // Positive control with an ARITY, not `length > 0`: three offering surfaces
    // (the header context menu, the column popover, the Variables view's action
    // row) plus the allowlisted confirm. If this drops, the detector stopped
    // matching and every assertion below became free.
    expect(files.length, 'walked no sources').toBeGreaterThan(200)
    expect(offering.map(f => f.rel).sort(), 'the offering set changed — is the new surface gated?')
      .toEqual([
        'components/ColumnEditorPopover.tsx',
        'components/DatasetGridComponents.tsx',
        'components/DeleteVariableDialog.tsx',
        'components/VariableActions.tsx',
      ])
  })

  it('every surface offering the words also spends the gate', () => {
    const ungated = offering
      .filter(f => !ALLOWED.has(f.rel))
      .filter(f => !GATE.test(stripImports(f.src)))
      .map(f => f.rel)
    expect(ungated, 'these offer "Delete variable" with no source gate — they will 403 on an imported column')
      .toEqual([])
  })

  it('the allowlist has no stale entries', () => {
    // An allowlist outliving its file is how a guard silently narrows.
    const offeringPaths = new Set(offering.map(f => f.rel))
    for (const [rel] of ALLOWED) {
      expect(offeringPaths.has(rel), `${rel} is allowlisted but no longer offers the words — drop the entry`)
        .toBe(true)
    }
  })
})
