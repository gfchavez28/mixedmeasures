import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripComments } from '@/lib/strip-comments'
import { join } from 'node:path'

/**
 * The dataset workspace's toolbars group by AXIS (design note Decision F,
 * option 1) and BOTH tabs offer the same create actions (#830f).
 *
 * The row was six buttons across four unrelated axes with no separators: two
 * created a variable, one added records, one went to a project-scoped page that
 * is not about this dataset, one opened the Variables view, one jumped to
 * another workspace. `Add ▾` says the thing two differently-tinted sibling
 * buttons cannot — that creating a variable and appending records are two kinds
 * of one act, and not the same kind as each other.
 *
 * 🔴 **What #830f changed here, and why the shape of this file changed with
 * it.** The menu lived inline in `DatasetView`, so these assertions could read
 * one page's source and be done. It is `components/AddVariableMenu` now, shared
 * with the Variables view — so the menu's OWN rules are asserted once against
 * the component, and each page is asserted to RENDER it. Leaving the item list
 * pointed at `DatasetView` would have turned this guard green-and-blind on the
 * day the items left that file: the population it walks would still resolve,
 * and would no longer contain the thing it exists to check (#814's class).
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

/** The two tabs of the dataset workspace. Both must offer the create actions. */
const TOOLBAR_PAGES = ['pages/DatasetView.tsx', 'pages/RecodeWorkbench.tsx']

describe('the shared Add menu', () => {
  const menu = read('components/AddVariableMenu.tsx')

  it('read a real file (a scan that resolves to nothing passes by finding nothing)', () => {
    expect(menu.length).toBeGreaterThan(1_000)
    expect(menu).toContain('DropdownMenuTrigger')
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
      expect(menu, `the Add menu must offer "${item}"`).toContain(item)
    }
  })

  it('🔴 keeps the third kind inside the EXISTING Variables group', () => {
    // Decision F established that a Radix `Group` does NOT wire a sibling
    // `Label` — without `aria-labelledby` a reader hears one flat list. A NEW
    // group for the third kind would need its own wiring and would split a
    // set of three that belongs together; the assertion below is what stops
    // someone "tidying" it into one.
    const variablesGroup = menu.slice(
      menu.indexOf('aria-labelledby="add-menu-variables"'),
      menu.indexOf('aria-labelledby="add-menu-records"'),
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
    //
    // ⚠️ Sharper since #830f: the wiring now exists ONCE for two surfaces,
    // which is the strongest reason the menu is a component. A copied menu is
    // how one of the two loses this.
    for (const id of ['add-menu-variables', 'add-menu-records']) {
      expect(menu, `${id} must label a group`).toContain(`aria-labelledby="${id}"`)
      expect(menu, `${id} must be an id on the label itself`).toContain(`id="${id}"`)
    }
  })

  it('drops the non-semantic orange tint and keeps the meaningful violet', () => {
    // §10.4: `mm-orange` appears nowhere else in this grid, so on "Add Column"
    // it was decoration that made two same-kind actions read as different
    // kinds. Violet matches the violet `FunctionSquare` marking a computed
    // column in the grid — the one tint here that carries information.
    expect(menu, 'the orange tint must not return').not.toMatch(/mm-orange/)
    expect(menu, 'violet marks the computed kind, as it does in the grid').toMatch(/text-violet-/)
  })
})

describe('both tabs of the dataset workspace render it', () => {
  it.each(TOOLBAR_PAGES)('%s renders the shared Add menu', (rel) => {
    // 🔴 #830f. `Add ▾` was on the Data view alone, so the Variables view — the
    // screen where recode rules are authored, and the screen the rule picker's
    // own empty state sends people to — could not create a variable at all.
    // A population assertion over the two pages, so a THIRD tab arriving
    // without it fails here rather than shipping a half-enumerated workspace.
    const src = read(rel)
    expect(src.length, `${rel} should be real source`).toBeGreaterThan(20_000)
    expect(src, `${rel} must render <AddVariableMenu>`).toContain('<AddVariableMenu')
    expect(src, `${rel} must wire all four actions`).toContain('onAddRecoded')
  })

  it.each(TOOLBAR_PAGES)('%s does not re-inline the menu', (rel) => {
    // The whole point of the extraction: a second copy of the items is a second
    // copy of the `aria-labelledby` wiring, and that is the half that gets lost.
    const src = read(rel)
    expect(src, `${rel} must not hand-roll the group headings`)
      .not.toContain('add-menu-variables')
  })

  it('no longer routes to the project-scoped variable-groups page', () => {
    // Its route carries no `:datasetId`, so it never belonged to a dataset's
    // action row. ⚠️ This asserts the TOOLBAR, not the app: the page is reached
    // from TopRail's Datasets menu and six other places, and the removal was
    // checked against that list first — a removal with no other entry point is
    // a deletion, which is the trap the E4 slab backed out of.
    for (const rel of TOOLBAR_PAGES) {
      expect(read(rel), `${rel}'s toolbar must not link variable-groups`)
        .not.toMatch(/datasets\/variable-groups/)
    }
    expect(read('components/TopRail.tsx'), 'TopRail keeps the project-level way in')
      .toMatch(/datasets\/variable-groups/)
  })
})

describe('the Data view toolbar stays short', () => {
  const view = read('pages/DatasetView.tsx')

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
    expect(toolbar, 'the toolbar slice lost the Add menu — the scan is vacuous')
      .toContain('<AddVariableMenu')

    // ⚠️ Count what can render AT ONCE, not `<Button` tags. "Code Text" is a
    // ternary — an enabled anchor-as-button and a disabled real button — so two
    // source tags are one control on screen (2026-08-24). Counting tags would
    // make every future disabled state look like toolbar growth.
    //
    // ⚠️ Since #830f the `Add ▾` trigger's own `<Button>` lives in
    // `AddVariableMenu`, so it is no longer a `<Button` tag in THIS file — it
    // is counted explicitly below instead of silently dropping out of the
    // budget, which would have quietly bought room for another control.
    const codeTextArms = (toolbar.match(/Code Text/g) ?? []).length
    expect(codeTextArms, 'Code Text should be exactly two arms of one ternary').toBe(2)
    const tags = (toolbar.match(/<Button\b/g) ?? []).length
    const addMenus = (toolbar.match(/<AddVariableMenu\b/g) ?? []).length
    const simultaneous = tags - (codeTextArms - 1) + addMenus
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

describe('the Variables view toolbar stays short', () => {
  const view = read('pages/RecodeWorkbench.tsx')

  it('keeps the row to the tab strip, undo/redo and ONE Add control', () => {
    // #830f added a control to this row, so it earns the same budget the Data
    // view's has. ⚠️ Same caveat, and it is the important one: jsdom computes
    // no layout, so this is a PROXY. The row was measured live at 640×360
    // before shipping; measure again before adding to it.
    const start = view.indexOf('flex items-center gap-3 px-4 py-2 border-b')
    const end = view.indexOf('<PanelGroup')
    expect(start, 'toolbar start marker no longer resolves — re-anchor this scan')
      .toBeGreaterThan(-1)
    expect(end, 'toolbar end marker no longer resolves — re-anchor this scan')
      .toBeGreaterThan(start)
    const toolbar = view.slice(start, end)
    expect(toolbar, 'the toolbar slice lost the Add menu — the scan is vacuous')
      .toContain('<AddVariableMenu')
    expect(toolbar, 'the toolbar slice lost the tab strip — the scan is vacuous')
      .toContain('<DatasetTabs')

    const tags = (toolbar.match(/<Button\b/g) ?? []).length
    const addMenus = (toolbar.match(/<AddVariableMenu\b/g) ?? []).length
    // Undo, Redo (one conditional pair) + Add ▾ — three.
    expect(tags + addMenus, 'the toolbar grew a control; check it at 640x360 first')
      .toBeLessThanOrEqual(3)
  })
})
