import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { join } from 'node:path'

/**
 * The dataset toolbar groups by AXIS (design note Decision F, option 1).
 *
 * The row was six buttons across four unrelated axes with no separators: two
 * created a variable, one added records, one went to a project-scoped page that
 * is not about this dataset, one opened the Variables view, one jumped to
 * another workspace. `Add ▾` says the thing two differently-tinted sibling
 * buttons cannot — that creating a variable and appending records are two kinds
 * of one act, and not the same kind as each other.
 *
 * A source scan rather than a mount: `DatasetView` is ~1,500 lines behind six
 * queries and a `DndContext`, so a render test would exercise the harness more
 * than the rule. What is asserted here is STRUCTURE — which control exists,
 * which tint is gone, and whether the group headings are wired to their groups
 * — all of which a scan can see. The behaviour of the menu itself is Radix's.
 */

const SRC = join(__dirname, '..')

const read = (rel: string) => {
  const abs = join(SRC, rel)
  return stripComments(readFileSync(abs, 'utf8'), abs)
}

describe('the dataset toolbar groups by axis', () => {
  const view = read('pages/DatasetView.tsx')

  it('read a real file (a scan that resolves to nothing passes by finding nothing)', () => {
    expect(view.length).toBeGreaterThan(20_000)
    expect(view).toContain('DropdownMenuTrigger')
  })

  it('offers ALL THREE variable kinds and the records action inside ONE menu', () => {
    // ⚠️ This assertion's TITLE said "both variable kinds" until Decision B
    // Stage 3 added the third — a count rotting inside a test name, which is
    // the class the internal design notes warns about: the wrong number reads as a complete
    // answer. The list below is the count; keep the title matching it.
    //
    // The three are jamovi's `Add` → Data / Computed / Transformed. MM had
    // BUILT the third kind (Decision B) and listed only two, so a researcher
    // looking where jamovi taught them to look found nothing (design note §11).
    for (const item of ['Variable', 'Computed variable', 'Recoded variable...', 'Append from file...']) {
      expect(view, `the Add menu must offer "${item}"`).toContain(item)
    }
  })

  it('🔴 keeps the third kind inside the EXISTING Variables group', () => {
    // Decision F established that a Radix `Group` does NOT wire a sibling
    // `Label` — without `aria-labelledby` a reader hears one flat list. A NEW
    // group for the third kind would need its own wiring and would split a
    // set of three that belongs together; the assertion below is what stops
    // someone "tidying" it into one.
    const variablesGroup = view.slice(
      view.indexOf('aria-labelledby="add-menu-variables"'),
      view.indexOf('aria-labelledby="add-menu-records"'),
    )
    expect(variablesGroup.length, 'the Variables group should be real source')
      .toBeGreaterThan(200)
    for (const item of ['Variable', 'Computed variable', 'Recoded variable...']) {
      expect(variablesGroup, `"${item}" belongs in the Variables group`).toContain(item)
    }
  })

  it('🔴 associates each group heading with its group', () => {
    // Radix's `Group` renders `role="group"` but does NOT wire a sibling
    // `Label` to it. Without `aria-labelledby` the two headings are loose text
    // inside the menu and a screen reader hears four items in one flat list —
    // which is precisely the reading this control exists to replace. The
    // grouping is the whole point of Decision F, so it has to survive the
    // accessibility tree, not just the visual one.
    for (const id of ['add-menu-variables', 'add-menu-records']) {
      expect(view, `${id} must label a group`).toContain(`aria-labelledby="${id}"`)
      expect(view, `${id} must be an id on the label itself`).toContain(`id="${id}"`)
    }
  })

  it('drops the non-semantic orange tint and keeps the meaningful violet', () => {
    // §10.4: `mm-orange` appears nowhere else in this grid, so on "Add Column"
    // it was decoration that made two same-kind actions read as different
    // kinds. Violet matches the violet `FunctionSquare` marking a computed
    // column in the grid — the one tint here that carries information.
    expect(view, 'the orange tint must not return').not.toMatch(/mm-orange/)
    expect(view, 'violet marks the computed kind, as it does in the grid').toMatch(/text-violet-/)
  })

  it('no longer routes to the project-scoped variable-groups page', () => {
    // Its route carries no `:datasetId`, so it never belonged to a dataset's
    // action row. ⚠️ This asserts the TOOLBAR, not the app: the page is reached
    // from TopRail's Datasets menu and six other places, and the removal was
    // checked against that list first — a removal with no other entry point is
    // a deletion, which is the trap the E4 slab backed out of.
    for (const rel of ['pages/DatasetView.tsx', 'pages/RecodeWorkbench.tsx']) {
      expect(read(rel), `${rel}'s toolbar must not link variable-groups`)
        .not.toMatch(/datasets\/variable-groups/)
    }
    expect(read('components/TopRail.tsx'), 'TopRail keeps the project-level way in')
      .toMatch(/datasets\/variable-groups/)
  })

  it('keeps the row to ONE control plus the cross-workspace jump', () => {
    // ⚠️ A COUNT, because the narrow-viewport cost is what the count buys and
    // no unit test can measure layout (jsdom computes none). MEASURED live in
    // the real toolbar at the 640x360 CSS viewport a 1280x720 window has at
    // 200% zoom: the pre-F row was **879px against a 640px container**, and the
    // page root is `overflow-hidden` — so the last buttons were CLIPPED, not
    // scrollable, i.e. unreachable at 200% zoom (WCAG 1.4.4). Adding another
    // control here would silently reintroduce that.
    //
    // 🔴 **THIS ASSERTION MEASURED NOTHING FROM THE DAY IT SHIPPED (found
    // 2026-08-24).** Its start marker was `{/* Toolbar */}` — a JSX comment,
    // which `stripComments` above replaces with spaces before this line runs.
    // `indexOf` therefore returned **-1**, `slice(-1, end)` produced an EMPTY
    // string, and `''.match(/<Button\b/g)` is `null` → 0 buttons → passes. The
    // file-level positive control two tests up proves the FILE was read; nothing
    // proved the SLICE resolved. **A scan needs a self-check per NARROWING, not
    // one per file** — that is the same lesson #772 recorded, one narrowing
    // deeper. Anchored on the row's own className now, which survives stripping.
    const start = view.indexOf('flex items-center gap-2 px-4 py-2 border-b')
    const end = view.indexOf('flex-1 min-h-0 p-4')
    expect(start, 'toolbar start marker no longer resolves — re-anchor this scan')
      .toBeGreaterThan(-1)
    expect(end, 'toolbar end marker no longer resolves — re-anchor this scan')
      .toBeGreaterThan(start)
    const toolbar = view.slice(start, end)
    // Self-check: the slice must actually contain the row, or the count below
    // is measuring nothing again.
    expect(toolbar, 'the toolbar slice lost its controls — the scan is vacuous')
      .toContain('Code Text')

    // ⚠️ Count what can render AT ONCE, not `<Button` tags. "Code Text" is a
    // ternary — an enabled anchor-as-button and a disabled real button — so two
    // source tags are one control on screen (2026-08-24). Counting tags would
    // make every future disabled state look like toolbar growth.
    const codeTextArms = (toolbar.match(/Code Text/g) ?? []).length
    expect(codeTextArms, 'Code Text should be exactly two arms of one ternary').toBe(2)
    const tags = (toolbar.match(/<Button\b/g) ?? []).length
    const simultaneous = tags - (codeTextArms - 1)
    // Add ▾, Undo, Redo, Code Text — four, and the undo pair is conditional.
    expect(simultaneous, 'the toolbar grew a control; check it at 640x360 first')
      .toBeLessThanOrEqual(4)
  })

  it('keeps Code Text, separated from the dataset\'s own actions', () => {
    // It is a jump to a DIFFERENT workspace, not an action on this table, so it
    // stays outside the Add menu and behind a divider.
    expect(view).toContain('Code Text')
    expect(view).toMatch(/text-coding\?columns=/)
  })
})
