/**
 * The joint display's unavailable buttons LOOK unavailable (the 2026-11-16 drive).
 *
 * The display keeps focus on a button whose action is off by marking it `aria-disabled` rather
 * than natively `disabled` (CaseView's docstring, #954: Chrome blurs a button that becomes
 * `disabled` to `<body>`). But the shared Button styles the off state with `disabled:` variants,
 * which key on the NATIVE attribute — so in the drive an `aria-disabled` *Save rule* stayed a
 * solid primary button after saving (computed opacity 1, both themes), and so did *Previous* /
 * *Next* on a one-page list, *Add a condition* at its limit, *Add* / *Remove* at the case-list
 * limit and *Pin* while another pin saved. `lib/mode-disabled.ts::MODE_DISABLED_CLASS` restates
 * the look on the `aria-disabled` variant; every such button here carries it.
 *
 * ⚠️ What this reads is the JSX, through the TypeScript parser: an element with a literal
 * `aria-disabled` attribute must have a `className` naming `MODE_DISABLED_CLASS`. Blind spots,
 * stated: an `aria-disabled` arriving through a SPREAD (`{...modeDisabledProps(…)}`) is not an
 * attribute here, and `aria-disabled={false}` — #752's propagation stop, never shown as off — is
 * exempt. The class's EFFECT (opacity 0.5) was measured in Chrome; jsdom computes no Tailwind.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { SOURCE_SCAN_TIMEOUT_MS, sourceFiles, srcRel } from '@/test-support/source-tree'

/** Each element in `text` that is `aria-disabled` without the blocked look, by line. */
function offenders(text: string, fileName: string): { line: number; tag: string }[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: { line: number; tag: string }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
      const named = (n: string) => attrs.find(a => a.name.getText(sf) === n)
      const off = named('aria-disabled')
      const literalFalse = off?.initializer && ts.isJsxExpression(off.initializer)
        && off.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword
      if (off && !literalFalse) {
        const cls = named('className')
        if (!cls?.initializer || !/\bMODE_DISABLED_CLASS\b/.test(cls.initializer.getText(sf))) {
          out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, tag: node.tagName.getText(sf) })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** How many elements in `text` carry a literal, non-false `aria-disabled` (the population). */
function ariaDisabledCount(text: string, fileName: string): number {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let n = 0
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'aria-disabled') {
      const e = node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined
      if (e?.kind !== ts.SyntaxKind.FalseKeyword) n += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return n
}

describe('the predicate (falsifier)', () => {
  it('flags an aria-disabled element with no className, or one that does not name the class', () => {
    expect(offenders('const a = <Button aria-disabled={x} onClick={f}>Save</Button>', 'a.tsx')).toHaveLength(1)
    expect(offenders('const a = <Button className="h-6 px-2" aria-disabled={x}>Next</Button>', 'a.tsx')).toHaveLength(1)
    expect(offenders('const a = <Button className={`h-6 ${OTHER}`} aria-disabled />', 'a.tsx')).toHaveLength(1)
  })
  it('passes the class in a plain or template className, and exempts aria-disabled={false}', () => {
    expect(offenders('const a = <Button className={MODE_DISABLED_CLASS} aria-disabled={x}>Save</Button>', 'a.tsx')).toEqual([])
    expect(offenders('const a = <Button className={`h-6 ${MODE_DISABLED_CLASS}`} aria-disabled={x} />', 'a.tsx')).toEqual([])
    expect(offenders('const a = <button aria-disabled={false}>Live</button>', 'a.tsx')).toEqual([])
    expect(ariaDisabledCount('const a = <><b aria-disabled={x} /><b aria-disabled={false} /></>', 'a.tsx')).toBe(1)
  })
})

describe('the joint display: every aria-disabled button looks unavailable', () => {
  it('names MODE_DISABLED_CLASS on each, over a population that is really there', { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
    const files = [
      ...sourceFiles({
        ext: 'tsx', floor: 5, root: 'components/canvas/joint-display',
        sentinels: ['components/canvas/joint-display/CaseView.tsx', 'components/canvas/joint-display/PinPicker.tsx'],
      }),
      ...sourceFiles({
        ext: 'tsx', floor: 1, root: 'components/canvas/extensions', recursive: false,
        sentinels: ['components/canvas/extensions/JointDisplayView.tsx'],
      }).filter(f => f.endsWith('JointDisplayView.tsx')),
    ]
    let population = 0
    const bad: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      population += ariaDisabledCount(text, f)
      for (const o of offenders(text, f)) bad.push(`${srcRel(f)}:${o.line} <${o.tag}>`)
    }
    // Six on 2026-11-16 (CaseView's Add/Remove, Previous, Next, Add a condition, Save rule;
    // PinPicker's Pin). A floor, not the count: it fails a scan that stopped seeing them.
    expect(population).toBeGreaterThanOrEqual(6)
    expect(bad).toEqual([])
  })
})
