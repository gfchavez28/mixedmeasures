import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ciLabel, ciCaveat, ciQualifier, isItemLevelCi, ITEM_LEVEL_CI_METHOD } from './ci-label'

/**
 * #715 — a domain aggregate's confidence interval is computed over ITEMS, not
 * respondents, and every display site labelled it a bare "95% CI".
 */

describe('ciLabel', () => {
  it('qualifies an item-level interval', () => {
    expect(ciLabel(ITEM_LEVEL_CI_METHOD)).toBe('95% CI across items')
    expect(ciCaveat(ITEM_LEVEL_CI_METHOD)).toMatch(/not across respondents/)
  })

  it('leaves respondent-level intervals alone', () => {
    for (const m of ['t_interval', 'wilson']) {
      expect(ciLabel(m)).toBe('95% CI')
      expect(ciCaveat(m)).toBeUndefined()
    }
  })

  it('treats an absent or unknown method as the ordinary kind', () => {
    // Older ComputedResult rows predate ci_method. Under-qualifying an ordinary
    // interval is harmless; over-qualifying a respondent-level one would be a NEW
    // false statement, so the default must fall this way and not the other.
    for (const m of [undefined, null, '', 'something_new']) {
      expect(ciLabel(m)).toBe('95% CI')
      expect(isItemLevelCi(m)).toBe(false)
    }
  })
})

describe('fail-closed: a CI display site may not hand-write its own label', () => {
  /**
   * The defect was one literal string repeated across five components — the shape a
   * per-component test cannot see. Sites that legitimately show a DIFFERENT kind of
   * interval (a group mean, an effect size, a Tukey mean difference) are listed with
   * their reason: those come from the comparisons/statistical-test endpoints, which
   * carry no `ci_method` and are never item-level.
   */
  const SRC = join(__dirname, '..')

  /**
   * THE predicate — declared once so the scan and its falsifier cannot diverge.
   * (No `/g`: a global regex carries `lastIndex` across `.test()` calls, which
   * would make a shared instance skip every other line.)
   */
  const HAND_WRITTEN_CI = /95%\s*CI/

  const ALLOWED = new Map<string, string>([
    ['components/ChartOptionsPanel.tsx', 'the error-bar toggle — one control for the whole chart, not a per-metric label'],
    ['components/charts/GroupComparisonTable.tsx', 'group means + effect size from comparisons.py — no ci_method, never item-level'],
    ['components/analysis/PostHocTable.tsx', 'Tukey mean-difference intervals — a different quantity entirely'],
  ])

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p)
    }
    return out
  }

  /**
   * The scanned population, proven non-trivial before use (#730).
   *
   * The scan below asserts an EMPTY offender list, which a walk that found
   * nothing satisfies just as well. `readdirSync` throws on a missing path, so
   * the risk is not a blind walk but a VALID-but-narrower one — moving this
   * file changes what `join(__dirname, '..')` resolves to. The floor detects
   * that; it is NOT a growth pin (394 `.ts`/`.tsx` files today).
   */
  function scannedFiles(): string[] {
    const files = walk(SRC)
    expect(
      files.length,
      `the scan walked ${files.length} files under ${SRC} — far fewer than expected, `
        + 'so it is reading the wrong subtree and the assertion would pass '
        + 'vacuously. Fix the root; do NOT lower this floor.',
    ).toBeGreaterThan(250)
    return files
  }

  it('scans the whole tree for a hand-written 95% CI label', () => {
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      const rel = file.replace(SRC + '/', '')
      if (rel === 'lib/ci-label.ts') continue // it defines the string
      if (ALLOWED.has(rel)) continue
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (HAND_WRITTEN_CI.test(line)) offenders.push(`${rel}:${i + 1}`)
      })
    }
    expect(
      offenders,
      'A metric\'s confidence interval must be labelled through ciLabel() from ' +
        'lib/ci-label.ts (#715). A domain aggregate\'s interval is computed across the ' +
        'ITEMS in the scale, not across respondents, so a bare "95% CI" states ' +
        'something false about it. If this site shows a different kind of interval ' +
        '(group means, effect sizes, post-hoc differences), add it to ALLOWED with the ' +
        'reason.',
    ).toEqual([])
  })

  it('the scan can actually fail', () => {
    // ⚠️ Exercises `HAND_WRITTEN_CI` — the SAME value the scan uses. This used to
    // re-type the regex as a second literal, so a typo in the scan's pattern left
    // this green: it proved *a* regex fired, not that *the* regex fired (#729).
    expect(HAND_WRITTEN_CI.test('<div>95% CI: [1, 2]</div>')).toBe(true)
    expect(HAND_WRITTEN_CI.test('{ciLabel(d.ciMethod)}: [1, 2]')).toBe(false)
  })
})

describe('fail-closed: ciMethod travels wherever ciLower does', () => {
  /**
   * The label is only as good as its delivery. Every place `chart-data.ts` reads
   * `ci_lower` off a `result_data` blob must read `ci_method` in the same object
   * literal — otherwise the component receives `undefined` and silently falls back
   * to the unqualified label, which looks exactly like a correct ordinary interval.
   */
  /**
   * Shapers fed by the GROUP-COMPARISON endpoint, not by a metric's `result_data`.
   * `comparisons.py` returns per-group means whose interval is a t-interval over the
   * respondents in that group; the payload has no `ci_method` field at all and can
   * never be item-level, so the plain label is the correct one. Listed by function
   * name rather than line number so the exemption survives edits above it.
   *
   * ⚠️ This scan found both of these on its first run, when I had threaded `ciMethod`
   * through the six `result_data` mappings I got by grepping. Six was not all of them,
   * and the two it added were the two that must NOT be threaded — so the guard's value
   * was forcing the distinction to be stated, not just counted.
   */
  const COMPARISON_SHAPERS = new Set(['shapeComparisonDumbbell', 'shapeComparisonGroupedBars'])

  it('every result_data ci_lower read in chart-data.ts also reads ci_method', () => {
    const lines = readFileSync(join(__dirname, 'chart-data.ts'), 'utf8').split('\n')
    const missing: string[] = []
    let fn = ''
    lines.forEach((line, i) => {
      const decl = /^export function (\w+)/.exec(line)
      if (decl) fn = decl[1]
      if (!/ciLower:\s*\w+\.ci_lower/.test(line)) return
      if (COMPARISON_SHAPERS.has(fn)) return
      // ci_method must appear in the same object literal — allow a few lines.
      if (!/ci_method/.test(lines.slice(i, i + 4).join('\n'))) {
        missing.push(`chart-data.ts:${i + 1} (in ${fn})`)
      }
    })
    expect(
      missing,
      'This mapping reads ci_lower but not ci_method, so the display site cannot ' +
        'tell an item-level interval from a respondent-level one and will silently ' +
        'fall back to the unqualified label (#715). If the source is the group-' +
        'comparison payload rather than a metric result_data blob, add the function ' +
        'to COMPARISON_SHAPERS with the reason.',
    ).toEqual([])
  })
})

/**
 * queue #42 — a per-category interval is a different CLAIM, so it takes its own
 * `ci_method` and its own qualifier. The previous shape was a ternary on
 * `isItemLevelCi`, which meant any method it did not know rendered as the
 * ordinary respondent-level case: silently, and in the one module whose whole
 * job is to stop exactly that.
 */
describe('ciLabel — per-category intervals', () => {
  it('qualifies a per-category Wilson interval', () => {
    expect(ciLabel('wilson_per_category')).toBe('95% CI per category')
  })

  it('says the intervals are not simultaneous', () => {
    // The one thing a reader is most likely to assume and most likely to be
    // wrong about: seven categories' intervals do NOT jointly cover at 95%.
    expect(ciCaveat('wilson_per_category')).toMatch(/not a simultaneous set/)
  })

  it('does not confuse it with the single-proportion Wilson interval', () => {
    // Both are Wilson; only one is a statement about a category against the
    // rest. Reusing `wilson` would have made them indistinguishable downstream.
    expect(ciLabel('wilson')).toBe('95% CI')
    expect(ciLabel('wilson_per_category')).not.toBe(ciLabel('wilson'))
  })
})

describe('ciQualifier', () => {
  it('returns the qualifier with a leading space, for bare-range tooltips', () => {
    expect(ciQualifier('item_level_t')).toBe(' across items')
    expect(ciQualifier('wilson_per_category')).toBe(' per category')
  })

  it('returns an empty string for the ordinary kind and the unknown', () => {
    for (const m of ['t_interval', 'wilson', undefined, null, 'something_new']) {
      expect(ciQualifier(m)).toBe('')
    }
  })
})

describe('ciLabel — the confidence level', () => {
  it('reads the level the payload states', () => {
    expect(ciLabel('wilson', 0.9)).toBe('90% CI')
    expect(ciLabel('item_level_t', 0.99)).toBe('99% CI across items')
  })

  it('falls back to 95 for an absent or impossible level', () => {
    // Every stored row holds 0.95; the level has been hard-wired in six places
    // while `ci_level` rode the payload unread. Reading it costs nothing and is
    // one of the two ends that must move together when it becomes configurable.
    for (const lvl of [undefined, null, 0, 1, -0.5, NaN, Infinity]) {
      expect(ciLabel('wilson', lvl)).toBe('95% CI')
    }
  })

  it('does not print a trailing zero for a whole-number level', () => {
    expect(ciLabel('wilson', 0.9)).toBe('90% CI')
    expect(ciLabel('wilson', 0.995)).toBe('99.5% CI')
  })
})
