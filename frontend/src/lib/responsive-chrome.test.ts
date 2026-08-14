import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * #718 / #717 — the two ways this app's chrome assumed a wide window.
 *
 * Both defects were invisible to every existing gate: jsdom computes no layout, so
 * a unit test cannot see a horizontal overflow or an occluded column. What IS
 * checkable is the *technique* — and in both cases the defect was a specific
 * technique repeated across sites, which is the shape a scan catches and a
 * per-component test does not.
 *
 * Measured before the fix, at a 640×360 viewport:
 *   TopRail   — document 1064px (full layout) / 1017px (compact) against 625px
 *   ByTextTable — sticky columns covered 320 of a 322px scroller, so `Codes` and
 *                 `Notes` had 0px visible at EVERY scroll position
 */

const SRC = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/**
 * THE predicate for #718's defect — a label span that collapses at a breakpoint
 * with `hidden`, which drops it out of the accessibility tree.
 *
 * Declared once so the scan and its falsifier cannot diverge. ⚠️ No `/g` flag:
 * a global regex carries `lastIndex` between `.test()` calls, so sharing one
 * would silently make the scan skip every other line.
 */
const HIDDEN_AT_BREAKPOINT = /className=["'{`][^"'`}]*\bhidden\s+\w+:inline/

/**
 * Blank out comments before scanning, preserving line numbers.
 *
 * ⚠️ All three of these scans failed on their first run by matching their OWN
 * documentation — the docblock that explains why `left-[20px]` is banned contains
 * the string `left-[20px]`, and the comment explaining that the prompt moved into
 * "the sticky Text cell" contains the word `sticky`. A guard that flags the prose
 * describing it trains people to weaken the guard. Strip the prose instead.
 */
function code(rel: string): string[] {
  const raw = read(rel)
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  return stripped.split('\n')
}

/** Every source file under src/ that mentions `needle` (tests excluded). */
function srcFilesContaining(needle: string): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(rel); continue }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
      if (read(rel).includes(needle)) hits.push(rel)
    }
  }
  walk('')
  return hits
}

/**
 * The class strings a file applies to elements, with `const` class constants inlined.
 *
 * Inlining is the whole point: #718's defect lived across a constant
 * (`sr-only xl:not-sr-only`) and an element (`px-1.5 py-0.5`), so a scan that reads
 * either alone sees nothing wrong.
 */
function classStrings(rel: string): { classes: string; where: string }[] {
  const src = code(rel).join('\n')
  const consts = new Map<string, string>()
  for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']*)'/g)) consts.set(m[1], m[2])

  const inline = (s: string) =>
    s.replace(/\$\{\s*([A-Z][A-Z0-9_]*)\s*\}/g, (whole, name) => consts.get(name) ?? whole)

  const out: { classes: string; where: string }[] = []
  for (const [name, value] of consts) out.push({ classes: value, where: `const ${name}` })
  for (const m of src.matchAll(/className=\{`([\s\S]*?)`\}/g)) {
    out.push({ classes: inline(m[1]), where: `className (line ${src.slice(0, m.index).split('\n').length})` })
  }
  for (const m of src.matchAll(/className="([^"]*)"/g)) {
    out.push({ classes: m[1], where: `className (line ${src.slice(0, m.index).split('\n').length})` })
  }
  for (const m of src.matchAll(/className=\{([A-Z][A-Z0-9_]*)\}/g)) {
    const v = consts.get(m[1])
    if (v) out.push({ classes: v, where: `className={${m[1]}}` })
  }
  return out
}

/**
 * Every property `not-sr-only` resets — read from the SHIPPED stylesheet, not guessed:
 *
 *   .xl\:not-sr-only{clip-path:none;white-space:normal;width:auto;height:auto;
 *                    margin:0;padding:0;position:static;overflow:visible}
 *
 * ⚠️ The guard used to check two of these eight (#725). Padding was simply the one that
 * bit first; a bare `w-32` or `absolute` beside `xl:not-sr-only` loses in exactly the
 * same way, and would have passed. Scope a guard by the MECHANISM, not by the instance
 * that happened to be reported.
 */
const RESET_BY_NOT_SR_ONLY = [
  /^-?p[xytrbles]?-/, // padding, incl. the ps-/pe- logical pair
  /^-?m[xytrbles]?-/, // margin, incl. negative margins (-mt-2)
  /^w-/,
  /^h-/,
  /^overflow(-[xy])?-/,
  /^whitespace-/,
  /^clip-path-/,
  /^(static|fixed|absolute|relative|sticky)$/, // position
]

/**
 * Tokens a variant `not-sr-only` on the same element will override.
 *
 * The rule the docblock states is **same variant, or it loses** — so this flags any
 * resettable utility whose variant differs from the collapsing one, not just the
 * unprefixed case. `xl:not-sr-only` + `lg:px-2` also loses at ≥xl, because Tailwind
 * emits breakpoint blocks in ascending order and `xl` comes last.
 */
function variantNotSrOnlyViolations(classes: string): string[] {
  const tokens = classes.split(/[\s`'"]+/).filter(Boolean)
  const split = (t: string) => {
    const i = t.lastIndexOf(':')
    return { variant: i === -1 ? '' : t.slice(0, i), bare: i === -1 ? t : t.slice(i + 1) }
  }
  const collapsing = new Set(
    tokens.map(split).filter(p => p.bare === 'not-sr-only' && p.variant !== '').map(p => p.variant),
  )
  if (!collapsing.size) return []
  return tokens.filter(t => {
    const { variant, bare } = split(t)
    if (!RESET_BY_NOT_SR_ONLY.some(re => re.test(bare))) return false
    return !collapsing.has(variant) // '' (base) or a different variant: emitted first, so it loses
  })
}

describe('#718 — the rail collapses labels by SCREEN, never by removal', () => {
  /**
   * `hidden` removes an element from the accessibility tree. The rail's icons are
   * `aria-hidden`, so a label hidden that way leaves the control with NO ACCESSIBLE
   * NAME — which is exactly what shipped: below 640px every workspace tab in the
   * compact rail was an unnamed link (WCAG 2.4.4 / 4.1.2). `sr-only` keeps the text
   * in the tree and only stops it painting.
   */
  it('TopRail hides no control label with `hidden`', () => {
    const offenders: string[] = []
    code('components/TopRail.tsx').forEach((line, i) => {
      // a label span collapsing at a breakpoint — `hidden sm:inline` and friends
      if (!HIDDEN_AT_BREAKPOINT.test(line)) return
      // An `aria-hidden` element is by definition NOT a label — the Ctrl+K hint on
      // the search button is decoration, and `hidden` is right for it.
      if (/aria-hidden/.test(line)) return
      offenders.push(`TopRail.tsx:${i + 1}`)
    })
    expect(
      offenders,
      'Use `sr-only <bp>:not-sr-only` (see RAIL_LABEL / TAB_LABEL), not `hidden ' +
        '<bp>:inline`. `hidden` drops the label out of the accessibility tree, and ' +
        'because the icon beside it is aria-hidden the control ends up with no ' +
        'accessible name at all (#718).',
    ).toEqual([])
  })

  it('the scan can actually fail', () => {
    // ⚠️ Exercises `HIDDEN_AT_BREAKPOINT` — the SAME value the scan uses. It used
    // to re-type the regex as a second literal, so a typo in the scan's pattern
    // left this green: it proved *a* regex fired, not *the* one (#729).
    expect(HIDDEN_AT_BREAKPOINT.test('<span className="hidden sm:inline">Label</span>')).toBe(true)
    expect(HIDDEN_AT_BREAKPOINT.test('<span className={TAB_LABEL}>Label</span>')).toBe(false)
  })

  /**
   * The #718 fix shipped with a defect of its own, and this is its guard.
   *
   * `not-sr-only` does not merely undo `sr-only`'s clipping — it declares
   * `padding: 0; margin: 0`. Tailwind emits every variant block AFTER the base
   * utilities, so `xl:not-sr-only` beats an UNPREFIXED `px-1.5` on the same element.
   * Measured in the shipped bundle: `.xl\:not-sr-only` at byte 120165 vs `.px-1\.5`
   * at 69377, and the rail's tab-count pill rendered 14.41×14 at `padding: 0px`
   * instead of 26.41×18 at every width ≥1280px.
   *
   * The mirror case proves the rule rather than the exception: `ProjectLayout`'s skip
   * link pairs `focus:not-sr-only` (110389) with `focus:px-4` (110972) — same variant,
   * emitted after, padding survives. So the rule is **same variant, or it loses**, and
   * only the unprefixed case is provably wrong.
   *
   * ⚠️ This must resolve `const` class strings before judging, because the defect
   * spanned two of them: the constant said `sr-only xl:not-sr-only` and the ELEMENT
   * carried the bare `px-1.5 py-0.5`. A per-line scan sees neither half.
   *
   * Scoped to the whole tree, not to TopRail — the trap belongs to the OPERATION
   * ("collapse a label with not-sr-only"), not to a directory.
   */
  it('no element pairs a variant `not-sr-only` with a utility it would reset', () => {
    const files = [
      'components/TopRail.tsx',
      'layouts/ProjectLayout.tsx',
      ...srcFilesContaining('not-sr-only'),
    ]
    const offenders: string[] = []
    for (const rel of new Set(files)) {
      for (const { classes, where } of classStrings(rel)) {
        offenders.push(...variantNotSrOnlyViolations(classes).map(t => `${rel}: ${where} → ${t}`))
      }
    }
    expect(
      offenders,
      'A utility that `not-sr-only` RESETS (padding · margin · width · height · ' +
        'overflow · white-space · position · clip-path) on an element that also carries ' +
        '`<v>:not-sr-only` MUST carry the SAME `<v>:` prefix — the variant block is ' +
        'emitted last, so any other variant (or none) silently loses (#718 → #725). ' +
        'Put it in the same constant, prefixed.',
    ).toEqual([])
  })

  it('the variant/padding scan can actually fail', () => {
    // the exact pre-fix class list
    expect(variantNotSrOnlyViolations('text-xs px-1.5 py-0.5 rounded-full sr-only xl:not-sr-only'))
      .toEqual(['px-1.5', 'py-0.5'])
    // the fix
    expect(variantNotSrOnlyViolations('text-xs rounded-full sr-only xl:not-sr-only xl:px-1.5 xl:py-0.5'))
      .toEqual([])
    // the skip link's shape — same variant on both, so the padding wins
    expect(variantNotSrOnlyViolations('sr-only focus:not-sr-only focus:px-4 focus:py-2')).toEqual([])
    // a BARE not-sr-only is base-layer on both sides, and padding is emitted after it
    expect(variantNotSrOnlyViolations('not-sr-only px-4')).toEqual([])
  })

  /**
   * #725 — the scan checked 2 of the 8 properties `not-sr-only` resets, and only the
   * unprefixed case. No live site was affected, which is exactly what makes it
   * next-instance debt: the guard would have waved through the next variant of the
   * same mechanism.
   */
  it('flags every property not-sr-only resets, not just padding', () => {
    const cases: [string, string][] = [
      ['sr-only xl:not-sr-only w-32', 'w-32'],
      ['sr-only xl:not-sr-only h-4', 'h-4'],
      ['sr-only xl:not-sr-only overflow-hidden', 'overflow-hidden'],
      ['sr-only xl:not-sr-only overflow-x-auto', 'overflow-x-auto'],
      ['sr-only xl:not-sr-only whitespace-nowrap', 'whitespace-nowrap'],
      ['sr-only xl:not-sr-only absolute', 'absolute'],
      ['sr-only xl:not-sr-only -mt-2', '-mt-2'],
      ['sr-only xl:not-sr-only ps-2', 'ps-2'],
    ]
    for (const [classes, expected] of cases) {
      expect(variantNotSrOnlyViolations(classes), classes).toEqual([expected])
    }
    // …and the same-variant form of each stays clean
    expect(variantNotSrOnlyViolations('sr-only xl:not-sr-only xl:w-32 xl:absolute')).toEqual([])
  })

  it('flags a sibling carrying a DIFFERENT variant, not just an unprefixed one', () => {
    // Breakpoint blocks are emitted in ascending order, so at ≥xl the xl block wins
    // and `lg:px-2` is gone — the docblock's rule is *same variant*, not *any variant*.
    expect(variantNotSrOnlyViolations('sr-only xl:not-sr-only lg:px-2')).toEqual(['lg:px-2'])
    expect(variantNotSrOnlyViolations('sr-only xl:not-sr-only hover:px-2')).toEqual(['hover:px-2'])
    // An element collapsing at two breakpoints accepts either.
    expect(variantNotSrOnlyViolations('sr-only lg:not-sr-only xl:not-sr-only lg:px-2 xl:px-3')).toEqual([])
  })

  it('does not flag utilities not-sr-only leaves alone', () => {
    expect(
      variantNotSrOnlyViolations('sr-only xl:not-sr-only text-xs font-mono rounded-full bg-white/10 min-w-0 gap-1'),
    ).toEqual([])
  })

  it('every rail row designates one element to absorb the pressure', () => {
    // Without a flexible child every item is rigid, the row cannot shrink, and the
    // DOCUMENT grows instead. `min-width: 0` alone was measured and did NOT fix it
    // (1064px → 1064px): the boxes shrink while their content spills.
    const src = read('components/TopRail.tsx')
    expect(src, 'the breadcrumb region must be the flexible child').toMatch(/min-w-0 flex-1/)
    expect(src, 'the action clusters must be rigid so the breadcrumb yields first')
      .toMatch(/ml-auto shrink-0/)
  })
})

describe('#717 — the frozen band yields when it would occlude', () => {
  const src = () => read('components/ByTextTable.tsx')

  it('no hard-coded sticky offset — the geometry comes from one value', () => {
    // `w-5` + `left-[20px]` were two literals in four places. Worse, `width` alone
    // is not authoritative on a table cell: measured, the 20px quote column
    // computed to 22px (the table layout widened it), so the sticky edge sat 2px
    // off. The value is single-sourced AND the cell is clamped.
    expect(
      code('components/ByTextTable.tsx').filter(l => /left-\[\d+px\]/.test(l)),
      'sticky offsets must derive from QUOTE_COL_W',
    ).toEqual([])
    expect(src()).toMatch(/QUOTE_COL_CLAMP/)
  })

  it('every sticky cell carries the relax variant', () => {
    const missing: string[] = []
    code('components/ByTextTable.tsx').forEach((line, i) => {
      if (!/\bsticky\b/.test(line)) return
      if (/STICKY_RELAX_AT/.test(line)) return
      if (/const STICKY_RELAX_AT/.test(line)) return // the declaration, not a use
      // Vertical stickiness is a different affordance and must NOT relax: the
      // header row pinning to the top costs no horizontal room.
      if (/sticky top-|top-0/.test(line)) return
      missing.push(`ByTextTable.tsx:${i + 1}`)
    })
    expect(
      missing,
      'A sticky cell without STICKY_RELAX_AT keeps pinning at container widths ' +
        'where the frozen band covers the whole viewport — measured, that left ' +
        'Codes and Notes at 0px visible at every scroll position (#717).',
    ).toEqual([])
  })

  it('the container context is NOT on the virtualized scroller', () => {
    // container-type: inline-size applies size containment, and #697 already found
    // CSS perturbing the getBoundingClientRect react-virtuoso measures. The context
    // belongs to an ancestor of the scroller.
    expect(src(), 'ByTextTable must not declare its own container context')
      .not.toMatch(/@container/)
    expect(read('pages/TextCodingView.tsx'), 'the wrapper around ByTextTable owns it')
      .toMatch(/@container/)
  })

  /**
   * #719 — By Text pages one column at a time; By Record reads across columns.
   *
   * This replaces a guard that pinned WHERE the per-row prompt was rendered. That
   * prompt has been deleted: it was guarded on `focalColumnIds.length > 1`, the call
   * site narrows the prop to the active column, so it had never painted — and the
   * capability it duplicated already ships in `ByRecordPanel`, which is the mode
   * built for reading across columns.
   *
   * So the guard now pins the DECISION rather than the dead code's address. It fails
   * if the label creeps back into the per-row table (re-introducing the duplicate) or
   * if it disappears from By Record (losing the real one). Implementing the
   * interleaved mode deliberately SHOULD fail this test — that is a design change,
   * and it should have to say so here.
   */
  it('the per-row column label lives in By Record, not in the By Text table', () => {
    const byText = code('components/ByTextTable.tsx').join('\n')
    expect(
      byText,
      'By Text pages by column, so a per-row column label repeats the same question ' +
        'on every row. Reading across columns is ByRecordPanel\'s job (#719).',
    ).not.toMatch(/comment\.column_name \|\| comment\.column_text/)

    const byRecord = code('components/ByRecordPanel.tsx').join('\n')
    expect(
      byRecord,
      'By Record must keep naming the column each answer came from — it is the only ' +
        'view that mixes columns, so without it an answer has no question (#719).',
    ).toMatch(/comment\.column_name \|\| comment\.column_text/)
  })
})
