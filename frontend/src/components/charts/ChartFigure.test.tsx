import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ChartFigure } from './ChartFigure'

/**
 * #698 — the charts were wrapped in `role="img"`, which makes children
 * PRESENTATIONAL: every axis tick, category label, value and the log-scale caveat
 * was suppressed, and the whole chart announced as a three-word label.
 *
 * These tests pin the two halves of the fix — the wrapper's own behaviour, and a
 * fail-closed scan so the anti-pattern cannot come back at a 13th chart.
 */

const CHARTS_DIR = join(__dirname)

describe('ChartFigure', () => {
  it('exposes its children to the accessibility tree', () => {
    render(
      <ChartFigure label="Horizontal bar chart">
        <span>Trust in provider</span>
        <span>4.2%</span>
      </ChartFigure>,
    )
    // The regression in one assertion: under `role="img"` these were unreachable.
    expect(screen.getByText('Trust in provider')).toBeInTheDocument()
    expect(screen.getByText('4.2%')).toBeInTheDocument()
  })

  it('is a figure, not an img — children must not be presentational', () => {
    const { container } = render(
      <ChartFigure label="Line chart">
        <span>content</span>
      </ChartFigure>,
    )
    const fig = container.querySelector('figure')
    expect(fig).not.toBeNull()
    expect(fig!.getAttribute('role')).toBeNull()
    expect(container.querySelector('[role="img"]')).toBeNull()
  })

  it('still carries an accessible name via a caption', () => {
    render(<ChartFigure label="Dumbbell comparison chart"><span>x</span></ChartFigure>)
    // Deleting role="img" without this would leave the chart unnamed — a browse-mode
    // user would land in a pile of numbers with no announcement of what they are.
    expect(screen.getByText('Dumbbell comparison chart')).toBeInTheDocument()
  })

  it('keeps the caption visually hidden so no chart gains a visible title', () => {
    const { container } = render(<ChartFigure label="Line chart"><span>x</span></ChartFigure>)
    expect(container.querySelector('figcaption')).toHaveClass('sr-only')
  })

  it('announces the mark count when given one, and pluralises it', () => {
    const { rerender } = render(
      <ChartFigure label="Horizontal bar chart" count={3} countNoun="bars"><span>x</span></ChartFigure>,
    )
    expect(screen.getByText('Horizontal bar chart, 3 bars')).toBeInTheDocument()

    rerender(<ChartFigure label="Horizontal bar chart" count={1} countNoun="bars"><span>x</span></ChartFigure>)
    expect(screen.getByText('Horizontal bar chart, 1 bar')).toBeInTheDocument()
  })

  it('omits the count entirely when it is not supplied', () => {
    // Deliberate: a wrong count is worse than none, so charts whose mark count is
    // not cheaply and accurately known pass nothing rather than guessing.
    render(<ChartFigure label="Frequency bar charts"><span>x</span></ChartFigure>)
    expect(screen.getByText('Frequency bar charts')).toBeInTheDocument()
  })

  it('renders the log-scale caveat inside the figure, where it is announced', () => {
    // The caveat sits INSIDE the wrapper at every real call site. Under role="img"
    // it was discarded along with the data — a methodological warning, silenced.
    render(
      <ChartFigure label="Horizontal bar chart">
        <div>2 values ≤ 0 excluded from log scale</div>
      </ChartFigure>,
    )
    expect(screen.getByText('2 values ≤ 0 excluded from log scale')).toBeInTheDocument()
  })
})

describe('fail-closed: no chart may reintroduce role="img"', () => {
  /**
   * A scan, not per-component tests, because the defect was a REPEATED reflex
   * across many sites and files — the shape a per-variant test cannot see.
   *
   * ⚠️ **This scan was scoped to `components/charts/` and that was wrong.** A live
   * drive found `qualitative-analysis/QualBarChart.tsx` still wrapping its chart in
   * `role="img"` — outside the scanned directory, so the guard was structurally
   * blind to it. Four more sat beside it. The count went 8 (reviews) → 12 (my first
   * sweep, directory-scoped) → **17** (whole tree). Scope a guard by the OPERATION,
   * never by where you happened to find the first instances.
   *
   * The allowlist is the other half: `role="img"` is CORRECT on a single opaque
   * graphic with no children worth reading — a logo, a status glyph, a badge. Those
   * are enumerated with reasons rather than pattern-matched, so a new chart cannot
   * hide behind a loose regex.
   */
  const SRC = join(CHARTS_DIR, '..', '..')

  /**
   * THE predicate — declared once so the scan and its falsifier cannot diverge.
   *
   * ⚠️ No `/g` flag, deliberately: a global regex carries `lastIndex` between
   * `.test()` calls, so a shared one would match every OTHER line and the scan
   * would silently miss half its offenders. If this ever needs `/g`, give each
   * call site its own instance instead of sharing this one.
   */
  const ROLE_IMG = /role=["']img["']/

  /** Genuinely-opaque graphics: no children to suppress, so the role is right. */
  const ALLOWED = new Map<string, string>([
    ['components/MMLogo.tsx', 'the logo — one graphic, no inner content'],
    ['components/SegmentRow.tsx', 'segment-group bar: a decorative rule with a name'],
    ['components/qualitative-analysis/ContentByCode.tsx', 'quote glyphs (#559 named icons)'],
    ['pages/ConversationsListPage.tsx', 'media badge — name carries type+filename+size (#559)'],
    ['pages/ObservationsListPage.tsx', 'media/coded badges, same pattern'],
    ['pages/ObservationWorkbench.tsx', 'clip indicators — reasoned through at #654'],
  ])

  /**
   * Blank out comments before scanning, preserving line numbers.
   *
   * ⚠️ Added 2026-08-09, and it REPLACES a per-file skip rather than adding to one.
   * A comment cannot render a role, so prose that merely *names* `role="img"` — a
   * docblock explaining why a component deliberately avoids it — is not an offence.
   * Scanning raw lines flagged exactly that, and the only cure on offer was an
   * ALLOWED entry: a permanent exemption for a file that never used the role. That
   * is how an allowlist rots into a blind spot.
   *
   * The tell that this was already a known problem: `ChartFigure.tsx` itself had a
   * hardcoded skip "its docstring names the anti-pattern" — the same collision,
   * solved once, per-file. Stripping prose solves it for every file at once and
   * lets that skip go. Same technique and same reasoning as `responsive-chrome.
   * test.ts`, whose three scans all failed on their first run by matching their own
   * documentation: strip the prose, never weaken the assertion.
   */
  function code(raw: string): string[] {
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
      .split('\n')
  }

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
   * Both uses below assert an EMPTY set, which a walk that found nothing
   * satisfies just as well. `readdirSync` throws on a missing path, so the risk
   * is not a blind walk but a VALID-but-narrower one — and this guard has
   * already been burned by scope once: it read `components/charts/` only, and
   * five offenders sat one folder over. The floor detects the walk collapsing;
   * it is NOT a growth pin (394 `.ts`/`.tsx` files today).
   */
  function scannedFiles(): string[] {
    const files = walk(SRC)
    expect(
      files.length,
      `the scan walked ${files.length} files under ${SRC} — far fewer than expected, `
        + 'so it is reading the wrong subtree and both assertions would pass '
        + 'vacuously. Fix the root; do NOT lower this floor.',
    ).toBeGreaterThan(250)
    return files
  }

  it('scans the WHOLE tree, not just components/charts', () => {
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      const rel = file.replace(SRC + '/', '')
      // No self-skip for ChartFigure.tsx any more: `code()` blanks its docstring
      // along with everyone else's, so the file is scanned like any other.
      if (ALLOWED.has(rel)) continue
      code(readFileSync(file, 'utf8')).forEach((line, i) => {
        if (ROLE_IMG.test(line)) offenders.push(`${rel}:${i + 1}`)
      })
    }
    expect(
      offenders,
      'role="img" makes children PRESENTATIONAL — every axis label, category and ' +
        'value inside is suppressed, and recharts 3.8.1\'s accessibilityLayer (on by ' +
        'default) is buried with them (#698). Use <ChartFigure>. If this really is a ' +
        'single opaque graphic with nothing inside worth reading, add it to ALLOWED ' +
        'with a reason.',
    ).toEqual([])
  })

  it('every allowlist entry still exists — a stale exemption is a blind spot', () => {
    // Same discipline as the ownership-gate sweep: an allowlist that outlives its
    // file silently widens over time.
    const present = new Set(scannedFiles().map((f) => f.replace(SRC + '/', '')))
    for (const rel of ALLOWED.keys()) {
      expect(present.has(rel), `allowlisted file is gone: ${rel}`).toBe(true)
    }
  })

  it('the scan can actually fail', () => {
    // A scan that cannot fail is not a guard. Pins the matcher against the exact
    // string the 12 sites used, so a typo'd regex cannot make this vacuously green.
    //
    // ⚠️ This exercises `ROLE_IMG` — the SAME value the scan above uses — and that
    // is the whole point. It used to re-declare the regex as a second literal, so
    // editing the scan's pattern left this passing: it proved *a* regex fired, not
    // that *the* regex fired. A falsifier over a copy is the guard-the-guard
    // version of "the check and the defect share an assumption" (#729 review).
    const matcher = (line: string) => ROLE_IMG.test(line)
    expect(matcher('    <div ref={containerRef} role="img" aria-label="Horizontal bar chart">')).toBe(true)
    expect(matcher("      <div role='img'>")).toBe(true)
    expect(matcher('    <ChartFigure label="Horizontal bar chart">')).toBe(false)
  })
})
