/**
 * #1560 — the words in a heatmap cell take their colour FROM the cell's fill.
 *
 * #271 fixed one heatmap with `lib/utils.ts::getHslTextColor` (pure black or
 * white at the WCAG crossover, so every fill clears 4.5:1). Two other stylers
 * kept a hand-written cut — `L < 55 ? '#ffffff' : '#1a1a1a'` — which put white
 * on mid greens at 1.69:1 (amber 1.66:1) on the cross-tab, the qualitative
 * heatmap and the co-occurrence matrix, in the PNG export as well. A third, the
 * Text Coding cross-tab, set no colour at all, so the theme's near-white words
 * sat on fills as light as 95% in dark mode (1.0:1).
 *
 * The defect class is "a rule written by hand twice", so this file guards the
 * POPULATION, not the three sites: the behaviour of every styler over its whole
 * intensity range (every preset, both themes), and a source scan that every
 * intensity fill (`backgroundColor: hsl(…, ${L}%)`) picks its text through the
 * helper — a fourth hand-written copy fails here.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'

// The real ThemeProvider reads localStorage and matchMedia; the cross-tab only
// needs `useChartColors` (AnalysisCrossTabTable.test.tsx's stub).
vi.mock('@/lib/theme-context', async (orig) => {
  const { CHART_COLORS } = await import('@/lib/chart-data')
  return {
    ...(await orig<typeof import('@/lib/theme-context')>()),
    useChartColors: () => CHART_COLORS,
  }
})

import AnalysisCrossTabTable from '@/components/charts/AnalysisCrossTabTable'
import CrossTabTable from '@/components/CrossTabTable'
import { getHeatmapCellStyle, QUAL_HEATMAP_LABELS } from '@/components/qualitative-analysis/qual-chart-data'
import { HEATMAP_LABELS, getCorrCellStyle } from '@/lib/chart-data'
import { contrast, hslToRgb, AA_NORMAL, type Rgb } from './contrast'
import { sourceFiles, srcRel, SOURCE_SCAN_TIMEOUT_MS } from '@/test-support/source-tree'
import { stripComments } from './strip-comments'
import type { AnalysisCrossTabResponse, CrossTabulationResponse } from '@/lib/api'

afterEach(cleanup)

/** A CSS colour as jsdom serialises it (`rgb()`), or as written (`hsl()`, `#hex`). */
function parseColor(css: string): Rgb {
  const s = css.trim()
  let m = s.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/)
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]
  m = s.match(/^hsl\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)$/)
  if (m) return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]))
  m = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (m) return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
  throw new Error(`unparseable colour "${css}"`)
}

/** The ratio of a cell's text to its fill, or the reason there is none. */
function cellRatio(style: { backgroundColor?: string; color?: string }): number | string {
  if (!style.color) return 'no text colour set on a filled cell'
  return contrast(parseColor(style.color), parseColor(style.backgroundColor ?? ''))
}

function failures(cells: { where: string; style: { backgroundColor?: string; color?: string } }[]): string[] {
  const out: string[] = []
  for (const { where, style } of cells) {
    const r = cellRatio(style)
    if (typeof r === 'string') out.push(`${where}: ${r}`)
    else if (r < AA_NORMAL) out.push(`${where}: ${r.toFixed(2)}:1`)
  }
  return out
}

describe('#1560 — the qualitative heatmap and co-occurrence styler (getHeatmapCellStyle)', () => {
  const presets = Object.keys(QUAL_HEATMAP_LABELS)

  it('every preset, both themes, every intensity: the text clears 4.5:1 on its fill', () => {
    expect(presets.length).toBeGreaterThanOrEqual(6)
    const cells = []
    for (const preset of presets) {
      for (const isDark of [false, true]) {
        for (let v = 1; v <= 100; v++) {
          const style = getHeatmapCellStyle(v, 100, isDark, preset) as { backgroundColor: string; color: string }
          cells.push({ where: `${preset} ${isDark ? 'dark' : 'light'} ${v}%`, style })
        }
      }
    }
    expect(cells).toHaveLength(presets.length * 200)
    expect(failures(cells)).toEqual([])
  })

  it('positive control: an empty cell still paints nothing (the page keeps its own text)', () => {
    expect(getHeatmapCellStyle(0, 10, false)).toEqual({})
    expect(getHeatmapCellStyle(3, 0, true)).toEqual({})
  })

  it('positive control: the correlation styler #271 already fixed passes the same predicate', () => {
    const cells = []
    for (const preset of Object.keys(HEATMAP_LABELS)) {
      for (const isDark of [false, true]) {
        for (let r = -100; r <= 100; r += 2) {
          const style = getCorrCellStyle(r / 100, isDark, preset)
          if (style.backgroundColor === 'transparent') continue
          cells.push({ where: `${preset} ${isDark ? 'dark' : 'light'} r=${r / 100}`, style })
        }
      }
    }
    expect(cells.length).toBeGreaterThan(1000)
    expect(failures(cells)).toEqual([])
  })

  it('discrimination: the old hand-written cut FAILS this predicate (so the guard can fail)', () => {
    // `L < 55 ? white : #1a1a1a` on the green preset at L 54.9 (light mode's deepest-but-one band).
    const old = { backgroundColor: 'hsl(142, 76%, 54.9%)', color: '#ffffff' }
    expect(failures([{ where: 'old rule', style: old }])).toHaveLength(1)
  })
})

/** One row whose counts run 0..20, so the cells cover the whole intensity range. */
function quantData(): AnalysisCrossTabResponse {
  const cols = Array.from({ length: 21 }, (_, i) => `c${i}`)
  return {
    row_values: ['r'],
    col_values: cols,
    matrix: [cols.map((_, i) => ({ count: i, row_pct: 0, col_pct: 0, total_pct: 0 }))],
    row_totals: [210],
    col_totals: cols.map((_, i) => i),
    n_shared: 210,
    row_column_label: 'Row',
    col_column_label: 'Col',
    chi_square: null,
  } as unknown as AnalysisCrossTabResponse
}

describe('#1560 — the Quantitative cross-tab (AnalysisCrossTabTable)', () => {
  // Every preset the Chart Options offer, the diverging sentinel included (it
  // falls back to green on this table).
  for (const preset of Object.keys(HEATMAP_LABELS)) {
    it(`${preset}: every filled cell's text clears 4.5:1`, () => {
      const { container } = render(
        <AnalysisCrossTabTable data={quantData()} formatting={{ heatmapPreset: preset }} />,
      )
      const filled = [...container.querySelectorAll('td')].filter(
        td => td.style.backgroundColor && td.style.backgroundColor !== 'transparent',
      )
      expect(filled.length).toBe(21)
      const cells = filled.map((td, i) => ({ where: `${preset} cell ${i}`, style: td.style }))
      expect(failures(cells)).toEqual([])
    })
  }

  it('an all-zero table sets no fixed text colour (a fixed #1a1a1a was 1.09:1 on the dark surface)', () => {
    const data = quantData()
    data.matrix = [data.matrix[0].map(c => ({ ...c, count: 0 }))]
    const { container } = render(<AnalysisCrossTabTable data={data} />)
    const transparent = [...container.querySelectorAll('td')].filter(
      td => td.style.backgroundColor === 'transparent',
    )
    expect(transparent.length).toBe(21)
    for (const td of transparent) expect(td.style.color).toBe('inherit')
  })
})

/** Text Coding › Cross-Analysis: one code across 21 values, 0%..100%. */
function textData(): CrossTabulationResponse {
  const rvs = Array.from({ length: 21 }, (_, i) => `v${i}`)
  return {
    cross_column_name: 'Site',
    response_values: rvs,
    matrix: [{
      code_id: 1,
      code_name: 'A theme',
      code_color: null,
      counts: Object.fromEntries(rvs.map((rv, i) => [rv, i])),
      percentages: Object.fromEntries(rvs.map((rv, i) => [rv, i * 5])),
      row_total: 210,
    }],
    column_totals: Object.fromEntries(rvs.map((rv, i) => [rv, i])),
    total_coded_texts: 210,
  }
}

describe('#1560 — the Text Coding cross-tab (CrossTabTable)', () => {
  it('every filled cell sets its own text colour, and it clears 4.5:1 on the fill', () => {
    const { container } = render(<CrossTabTable data={textData()} />)
    const filled = [...container.querySelectorAll('td')].filter(td => td.style.backgroundColor)
    expect(filled.length).toBe(20)
    const cells = filled.map((td, i) => ({ where: `cell ${i + 1}`, style: td.style }))
    expect(failures(cells)).toEqual([])
  })

  it('no word inside a filled cell carries a theme text token (it would override the cell colour)', () => {
    const { container } = render(<CrossTabTable data={textData()} />)
    const filled = [...container.querySelectorAll('td')].filter(td => td.style.backgroundColor)
    const tokened = filled.flatMap(td =>
      [...td.querySelectorAll('[class]')].filter(el => /(^|\s)text-mm-/.test(el.getAttribute('class') ?? '')),
    )
    expect(tokened.map(el => el.outerHTML)).toEqual([])
  })

  it('positive control: an empty cell is unfilled and keeps its faint dash', () => {
    const { container } = render(<CrossTabTable data={textData()} />)
    const empty = [...container.querySelectorAll('td')].filter(td => !td.style.backgroundColor && td.textContent === '–')
    expect(empty.length).toBe(1)
  })
})

/**
 * The population: every intensity fill in `src/` — an inline
 * `backgroundColor: hsl(…, ${…}%)` whose LIGHTNESS is computed — takes its text
 * from `getHslTextColor` in the same style object. A site that legitimately does
 * otherwise is listed with its measurement, never silently.
 */
const INTENSITY_FILL = /backgroundColor:\s*`hsl\([^`]*,\s*\$\{[^}]+\}%\)`/g

const MEASURED_EXCEPTIONS: Record<string, string> = {
  'components/EditableCell.tsx':
    "the Data grid's ordinal gradient (#424), a DELIBERATE gradient with its own pairs, measured for #1560 " +
    '(2026-11-07b review): light --mm-text on L 65–95 ≥ 4.92:1; dark white / #e2e8f0 on L 15–40 ≥ 6.83:1',
}

/** Every file that held an intensity fill when this guard was written — the scan must still see them. */
const KNOWN_SITES = [
  'components/CrossTabTable.tsx',
  'components/EditableCell.tsx',
  'components/charts/AnalysisCrossTabTable.tsx',
  'components/charts/HeatmapTable.tsx',
  'components/qualitative-analysis/qual-chart-data.ts',
  'lib/chart-data.ts',
]

/** The flat style object the fill sits in: from its `{` to the first `}` after the template literal. */
function styleObject(src: string, at: number, end: number): string {
  const open = src.lastIndexOf('{', at)
  const close = src.indexOf('}', end)
  return src.slice(open, close + 1)
}

describe('#1560 — no hand-written text pick on an intensity fill, anywhere in src/', () => {
  it('every intensity fill picks its text through getHslTextColor (or is a listed, measured exception)',
    { timeout: SOURCE_SCAN_TIMEOUT_MS }, () => {
      const sites = new Set<string>()
      const offenders: string[] = []
      for (const file of sourceFiles({ ext: 'both', floor: 250 })) {
        const rel = srcRel(file)
        const src = stripComments(readFileSync(file, 'utf8'), file)
        for (const m of src.matchAll(INTENSITY_FILL)) {
          sites.add(rel)
          const obj = styleObject(src, m.index, m.index + m[0].length)
          if (!/getHslTextColor\(/.test(obj) && !(rel in MEASURED_EXCEPTIONS)) {
            offenders.push(`${rel}: ${obj.replace(/\s+/g, ' ').slice(0, 160)}`)
          }
        }
      }
      // Population self-check: a broken pattern finds nothing and passes, so the
      // scan must still reach every site it was written against.
      expect([...sites].sort()).toEqual(expect.arrayContaining(KNOWN_SITES))
      expect(offenders).toEqual([])
    })
})
