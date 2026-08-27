import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { join } from 'node:path'

/**
 * A variable-property FORM has exactly one home: the Variables view.
 *
 * 🔴 **Why this is a POPULATION assertion and not a per-control test.** Every
 * one of these forms shipped on several surfaces at once, and the copies then
 * drifted — which is how two of the three "Column details…" entry points ended
 * up saving through the manual-only PATCH with the WRONG gate or NO gate:
 *
 *   | surface                          | gate before this change     |
 *   |----------------------------------|-----------------------------|
 *   | `ColumnEditorPopover`            | `isManual` — correct (#575) |
 *   | `DatasetGridComponents` menu     | `manual \|\| imported` — 403s |
 *   | `ColumnPicker` (analysis) menu   | none at all — 403s          |
 *
 * The corpus this was found on has ZERO manual columns, so the third one failed
 * for every column it was shown on. Writing this as "the popover no longer has
 * it" would have caught one of the three; asserting over the POPULATION is what
 * catches the next one. The same rule has now shipped partially four times in
 * this codebase (#771 → #785), which is why it is written this way.
 *
 * ⚠️ `Recompute` is deliberately NOT in this list. It is a VERB acting on state
 * the Data view renders (the amber pulse on a stale computed column), not a
 * form that changes what the variable IS — so it lives on both surfaces by
 * design. Adding it here would be the inverse error.
 */

const SRC = join(__dirname, '..')

/** Surfaces that must NOT offer a variable-property form. */
const THINNED = [
  'components/ColumnEditorPopover.tsx',
  'components/DatasetGridComponents.tsx',
  'components/ColumnPicker.tsx',
  'pages/DatasetView.tsx',
  'pages/AnalysisView.tsx',
]

/** The one surface that must. */
const HOME = 'components/VariableActions.tsx'

/**
 * The forms, by the string a researcher would click. Matched against source
 * with comments stripped — a scan that reads its own prose reports phantoms
 * (#772, hit twice in this arc already).
 *
 * `home` overrides where the form's words live. The swap's are in `lib/`
 * because its arithmetic went there beside `columnDisplayLabel`: the two are
 * halves of one relationship, and a component file exporting non-components
 * trips the lint ceiling — the call this project has now made four times.
 */
const FORMS = [
  { name: 'Variable details', pattern: /Variable details\.\.\./ },
  { name: 'Edit formula', pattern: /Edit formula\.\.\./ },
  { name: 'Swap name ↔ label', pattern: /Swap name ↔ label/, home: 'lib/dataset-column-label.ts' },
  // The EDITOR, keyed on the mutation callback rather than the field name.
  // ⚠️ The first draft matched `demographic_subtype` and failed on the Data
  // view's type badge, which READS the subtype to display it (and marks an
  // unset one with an amber `?`). That read is not a form — it is the
  // discovery affordance that sends a researcher to the Variables view to set
  // it. A guard over a field name cannot tell a read from a write.
  { name: 'Demographic subtype', pattern: /onSubtypeChange/ },
]

const read = (rel: string) => {
  const abs = join(SRC, rel)
  return stripComments(readFileSync(abs, 'utf8'), abs)
}

describe('a variable-property form has one home', () => {
  it('read real files (a scan that resolves to nothing passes by finding nothing)', () => {
    // #729: the self-check. Without it a renamed path makes every assertion
    // below vacuously true.
    for (const rel of [...THINNED, HOME]) {
      expect(read(rel).length, `${rel} should be real source`).toBeGreaterThan(2_000)
    }
  })

  it.each(FORMS)('the Variables view offers $name', ({ pattern, home }) => {
    expect(read(home ?? HOME)).toMatch(pattern)
  })

  it.each(FORMS)('no thinned surface still offers $name', ({ pattern, name }) => {
    for (const rel of THINNED) {
      expect(read(rel), `${rel} must not carry the "${name}" form`).not.toMatch(pattern)
    }
  })

  it('keeps Recompute on the Data view — a verb, not a form', () => {
    // The positive control. Without it this file would pass just as well after
    // someone stripped the Data view of everything, which is the failure mode a
    // removal-only guard cannot see.
    //
    // ⚠️ The lookbehind is load-bearing and was found by MUTATING this test: a
    // bare /Recompute/ matches the `onRecompute` PROP, so renaming the visible
    // label to "Refresh" left both assertions green. A guard that matches the
    // wiring instead of the control certifies the wrong thing.
    for (const rel of ['components/ColumnEditorPopover.tsx', 'components/DatasetGridComponents.tsx']) {
      expect(read(rel), `${rel} must still OFFER Recompute, not merely accept the prop`)
        .toMatch(/(?<!on)Recompute/)
    }
  })

  it('the Variables view MOUNTS the home, and gates on the shared predicate', () => {
    // "The component exists" and "the component is reached" are two claims, and
    // this arc has been bitten by the gap between them twice — a rule badge
    // rendered off a field the payload never carried, and a pre-flight that
    // silently died when its component moved surfaces. The forms above could
    // all live in `VariableActions.tsx` and be reachable by nobody.
    const page = read('pages/RecodeWorkbench.tsx')
    for (const mounted of ['<VariableActions', '<ComputedVariablePanel', '<VariableRulesUnavailable']) {
      expect(page, `the Variables view must render ${mounted}`).toContain(mounted)
    }
    // 🔴 The gate asks TWO questions — type AND source. The page carried a
    // type-only `RECODE_DISALLOWED_TYPES` set, which is how a computed variable
    // was offered a value-label dictionary, a missing-value tri-state and a
    // rule editor that all 403. Both questions live in one predicate so no
    // surface can ask only one.
    expect(page).toMatch(/variableRulesRefusal/)
    expect(page, 'the type-only gate must not come back').not.toMatch(/RECODE_DISALLOWED_TYPES/)
  })

  it('no thinned surface still calls the manual-only PATCH', () => {
    // The DEFECT, not just the label: two of the three copies reached
    // `updateManualColumn` for columns it 403s on. The button text could be
    // renamed; this is the call that actually failed.
    for (const rel of THINNED) {
      expect(read(rel), `${rel} must not call updateManualColumn`)
        .not.toMatch(/updateManualColumn/)
    }
  })
})
