/**
 * #1423 — the Canvas comparison table in every export (Markdown; the table under the
 * image in HTML/PDF; Word's table when no image was captured; the joint display's bound
 * saved result) printed the test's wire id (`kruskal_wallis = 48.557`), the MEAN where
 * the figure shows medians, "p = 0.0000" and no effect size.
 *
 * The rule (the internal design notes): an export quotes the DISPLAYED field. So
 * the load-bearing test here renders `GroupComparisonTable` and `ComparisonTestStrip` on
 * the SAME payload and compares the exported cells with what they show, for every arm the
 * table has: two groups (Welch t, an ANOVA chosen over two), three (ANOVA, a t-test chosen
 * over three), the two rank tests, an omitted test and a group left out of the tests.
 *
 * The fixtures are REAL-SHAPED: produced 2026-11-13 by the service's own runners
 * (`comparisons._run_test`, `split_testable`, the row builder's group stats) on the data
 * named beside each — not hand-typed numbers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { CanvasTheme, GroupComparisonResponse } from '@/lib/api'

vi.mock('html-to-image', () => ({ toPng: vi.fn() }))
vi.mock('@/lib/api', () => ({
  metricsApi: { quickCompute: vi.fn(), crossTabulation: vi.fn() },
  comparisonsApi: { groupComparison: vi.fn() },
  codeAnalysisApi: {},
  codesApi: { list: vi.fn() },
  observationsApi: { list: vi.fn(), listSegments: vi.fn() },
}))

import { comparisonsApi } from '@/lib/api'
import { fetchChartTables, docxChartTables, type ExportTable } from './canvas-export'
import GroupComparisonTable from '@/components/charts/GroupComparisonTable'
import ComparisonTestStrip from '@/components/analysis/ComparisonTestStrip'

const LENS = { blind: false, self: null, machineCoderIds: new Set<number>() as ReadonlySet<number> }
const SIG = { show_05: true, show_01: true, show_001: true }

/**
 * welch  — Men [3,4,4,5,5,6,4,5] v Women [2,3,3,4,2,3,4,3,2]; Hours [10..13] v [1..3] (p
 *          rounds to 0 at the wire's 6 places); Flat: every value 4 (no_variance).
 * anova3 — Low/Mid/High, six each; Other: High holds ONE value (left out of the tests).
 * anova2 — `test_type: 'anova'` over the two welch groups.
 * t3     — `test_type: 't_test'` over the three anova3 groups (the first two are tested).
 * mw     — rank test, [1,5,8,9,12] v [2,3,4,6,7] (exact p; medians 8 and 4, means 7 and 4.4).
 * kw     — rank test, 1–20 / 15–34 / 30–49 (p rounds to 0).
 */
const FIX = {
  anova2: {"bonferroni_threshold":null,"bonferroni_warning":false,"group_column_label":"g","groups":["Men","Women"],"rows":[{"full_label":"Wellbeing (baseline)","group_stats":[{"ci_lower":3.726,"ci_upper":5.274,"group":"Men","mean":4.5,"median":4.5,"n":8,"sd":0.9258,"undefined_reason":null},{"ci_lower":2.288,"ci_upper":3.4898,"group":"Women","mean":2.8889,"median":3,"n":9,"sd":0.7817,"undefined_reason":null}],"label":"Wellbeing","source_id":352,"source_type":"column","test":{"df":1.0,"df2":15.0,"effect_size":0.5024,"effect_size_ci_lower":null,"effect_size_ci_upper":null,"effect_size_label":"large","effect_size_type":"eta_squared","omega_squared":0.4541,"omega_squared_label":"large","p":0.001446,"post_hoc":{"comparisons":[{"ci_lower":-2.4935,"ci_upper":-0.7287,"group_a":"Men","group_b":"Women","mean_diff":-1.6111,"p":0.0014}],"post_hoc_method":"tukey_hsd"},"statistic":15.1441,"test_type":"one_way_anova"},"test_omitted_reason":null,"untested_groups":[]}],"stale_domain_ids":[],"unavailable_reason":null},
  anova3: {"bonferroni_threshold":null,"bonferroni_warning":false,"group_column_label":"g","groups":["Low","Mid","High"],"rows":[{"full_label":"Score","group_stats":[{"ci_lower":1.0433,"ci_upper":2.6233,"group":"Low","mean":1.8333,"median":2.0,"n":6,"sd":0.7528,"undefined_reason":null},{"ci_lower":3.0433,"ci_upper":4.6233,"group":"Mid","mean":3.8333,"median":4.0,"n":6,"sd":0.7528,"undefined_reason":null},{"ci_lower":5.0433,"ci_upper":6.6233,"group":"High","mean":5.8333,"median":6.0,"n":6,"sd":0.7528,"undefined_reason":null}],"label":"Score","source_id":89,"source_type":"column","test":{"df":2.0,"df2":15.0,"effect_size":0.8496,"effect_size_ci_lower":null,"effect_size_ci_upper":null,"effect_size_label":"large","effect_size_type":"eta_squared","omega_squared":0.8213,"omega_squared_label":"large","p":1e-06,"post_hoc":{"comparisons":[{"ci_lower":-5.1289,"ci_upper":-2.8711,"group_a":"High","group_b":"Low","mean_diff":-4.0,"p":0.0},{"ci_lower":-3.1289,"ci_upper":-0.8711,"group_a":"High","group_b":"Mid","mean_diff":-2.0,"p":0.0009},{"ci_lower":0.8711,"ci_upper":3.1289,"group_a":"Low","group_b":"Mid","mean_diff":2.0,"p":0.0009}],"post_hoc_method":"tukey_hsd"},"statistic":42.3529,"test_type":"one_way_anova"},"test_omitted_reason":null,"untested_groups":[]},{"full_label":"Other score","group_stats":[{"ci_lower":1.0433,"ci_upper":2.6233,"group":"Low","mean":1.8333,"median":2.0,"n":6,"sd":0.7528,"undefined_reason":null},{"ci_lower":3.0433,"ci_upper":4.6233,"group":"Mid","mean":3.8333,"median":4.0,"n":6,"sd":0.7528,"undefined_reason":null},{"ci_lower":null,"ci_upper":null,"group":"High","mean":6,"median":6,"n":1,"sd":null,"undefined_reason":"insufficient_n"}],"label":"Other","source_id":840,"source_type":"column","test":{"df":1.0,"df2":10.0,"effect_size":0.6792,"effect_size_ci_lower":null,"effect_size_ci_upper":null,"effect_size_label":"large","effect_size_type":"eta_squared","omega_squared":0.6271,"omega_squared_label":"large","p":0.000977,"post_hoc":{"comparisons":[{"ci_lower":1.0316,"ci_upper":2.9684,"group_a":"Low","group_b":"Mid","mean_diff":2.0,"p":0.001}],"post_hoc_method":"tukey_hsd"},"statistic":21.1765,"test_type":"one_way_anova"},"test_omitted_reason":null,"untested_groups":["High"]}],"stale_domain_ids":[],"unavailable_reason":null},
  kw: {"bonferroni_threshold":null,"bonferroni_warning":false,"group_column_label":"g","groups":["Low","Mid","High"],"rows":[{"full_label":"Score","group_stats":[{"ci_lower":null,"ci_upper":null,"group":"Low","mean":10.5,"median":10.5,"n":20,"sd":5.9161,"undefined_reason":null},{"ci_lower":null,"ci_upper":null,"group":"Mid","mean":24.5,"median":24.5,"n":20,"sd":5.9161,"undefined_reason":null},{"ci_lower":null,"ci_upper":null,"group":"High","mean":39.5,"median":39.5,"n":20,"sd":5.9161,"undefined_reason":null}],"label":"Score","source_id":89,"source_type":"column","test":{"df":2.0,"df2":null,"effect_size":0.823,"effect_size_ci_lower":null,"effect_size_ci_upper":null,"effect_size_label":"large","effect_size_type":"epsilon_squared","omega_squared":null,"omega_squared_label":null,"p":0.0,"post_hoc":null,"statistic":48.5575,"test_type":"kruskal_wallis"},"test_omitted_reason":null,"untested_groups":[]}],"stale_domain_ids":[],"unavailable_reason":null},
  mw: {"bonferroni_threshold":null,"bonferroni_warning":false,"group_column_label":"g","groups":["Men","Women"],"rows":[{"full_label":"Wellbeing (baseline)","group_stats":[{"ci_lower":null,"ci_upper":null,"group":"Men","mean":7,"median":8,"n":5,"sd":4.1833,"undefined_reason":null},{"ci_lower":null,"ci_upper":null,"group":"Women","mean":4.4,"median":4,"n":5,"sd":2.0736,"undefined_reason":null}],"label":"Wellbeing","source_id":352,"source_type":"column","test":{"df":8.0,"df2":null,"effect_size":-0.44,"effect_size_ci_lower":null,"effect_size_ci_upper":null,"effect_size_label":"medium","effect_size_type":"rank_biserial_r","omega_squared":null,"omega_squared_label":null,"p":0.309524,"p_method":"exact","post_hoc":null,"statistic":18.0,"test_type":"mann_whitney_u"},"test_omitted_reason":null,"untested_groups":[]}],"stale_domain_ids":[],"unavailable_reason":null},
  t3: {"bonferroni_threshold":null,"bonferroni_warning":false,"group_column_label":"g","groups":["Low","Mid","High"],"rows":[{"full_label":"Score","group_stats":[{"ci_lower":1.0433,"ci_upper":2.6233,"group":"Low","mean":1.8333,"median":2.0,"n":6,"sd":0.7528,"undefined_reason":null},{"ci_lower":3.0433,"ci_upper":4.6233,"group":"Mid","mean":3.8333,"median":4.0,"n":6,"sd":0.7528,"undefined_reason":null},{"ci_lower":5.0433,"ci_upper":6.6233,"group":"High","mean":5.8333,"median":6.0,"n":6,"sd":0.7528,"undefined_reason":null}],"label":"Score","source_id":89,"source_type":"column","test":{"df":10.0,"df2":null,"effect_size":-2.6568,"effect_size_ci_lower":-4.2805,"effect_size_ci_upper":-1.0332,"effect_size_label":"large","effect_size_type":"cohens_d","omega_squared":null,"omega_squared_label":null,"p":0.000977,"post_hoc":null,"statistic":-4.6018,"test_type":"independent_t_test"},"test_omitted_reason":null,"untested_groups":[]}],"stale_domain_ids":[],"unavailable_reason":null},
  welch: {"bonferroni_threshold":null,"bonferroni_warning":false,"group_column_label":"g","groups":["Men","Women"],"rows":[{"full_label":"Wellbeing (baseline)","group_stats":[{"ci_lower":3.726,"ci_upper":5.274,"group":"Men","mean":4.5,"median":4.5,"n":8,"sd":0.9258,"undefined_reason":null},{"ci_lower":2.288,"ci_upper":3.4898,"group":"Women","mean":2.8889,"median":3,"n":9,"sd":0.7817,"undefined_reason":null}],"label":"Wellbeing","source_id":352,"source_type":"column","test":{"df":13.8253,"df2":null,"effect_size":1.8909,"effect_size_ci_lower":0.7227,"effect_size_ci_upper":3.0592,"effect_size_label":"large","effect_size_type":"cohens_d","omega_squared":null,"omega_squared_label":null,"p":0.001803,"post_hoc":null,"statistic":3.8508,"test_type":"independent_t_test"},"test_omitted_reason":null,"untested_groups":[]},{"full_label":"Hours worked","group_stats":[{"ci_lower":10.6213,"ci_upper":11.9787,"group":"Men","mean":11.3,"median":11.0,"n":10,"sd":0.9487,"undefined_reason":null},{"ci_lower":1.2357,"ci_upper":2.3643,"group":"Women","mean":1.8,"median":2.0,"n":10,"sd":0.7888,"undefined_reason":null}],"label":"Hours","source_id":705,"source_type":"column","test":{"df":17.4199,"df2":null,"effect_size":10.8893,"effect_size_ci_lower":7.2258,"effect_size_ci_upper":14.5528,"effect_size_label":"large","effect_size_type":"cohens_d","omega_squared":null,"omega_squared_label":null,"p":0.0,"post_hoc":null,"statistic":24.3492,"test_type":"independent_t_test"},"test_omitted_reason":null,"untested_groups":[]},{"full_label":"Flat item","group_stats":[{"ci_lower":4.0,"ci_upper":4.0,"group":"Men","mean":4,"median":4.0,"n":4,"sd":0.0,"undefined_reason":null},{"ci_lower":4.0,"ci_upper":4.0,"group":"Women","mean":4,"median":4.0,"n":4,"sd":0.0,"undefined_reason":null}],"label":"Flat","source_id":768,"source_type":"column","test":null,"test_omitted_reason":"no_variance","untested_groups":[]}],"stale_domain_ids":[],"unavailable_reason":null},
} as unknown as Record<'welch' | 'anova3' | 'anova2' | 't3' | 'mw' | 'kw', GroupComparisonResponse>

const RANK = new Set(['mw', 'kw'])
const TEST_TYPE: Record<string, string> = { anova2: 'anova', t3: 't_test' }

function theme(cfg: Record<string, unknown>): CanvasTheme[] {
  return [{
    id: 1,
    content: { type: 'doc', content: [{ type: 'chart-embed', attrs: { materialId: 1, config: JSON.stringify(cfg) } }] },
  } as unknown as CanvasTheme]
}

async function exported(name: keyof typeof FIX) {
  vi.mocked(comparisonsApi.groupComparison).mockResolvedValue(FIX[name] as never)
  const tables = await fetchChartTables(theme({
    column_ids: [1], domain_ids: [], compare_by: 9, rc_view: 'comparisons',
    test_type: TEST_TYPE[name] ?? 'auto', nonparametric: RANK.has(name),
  }), 4, LENS)
  const entry = tables.get(1)
  return { entry, table: entry?.table as ExportTable, docx: docxChartTables(tables).get(1) }
}

/** What the screen table shows for each variable row: its cells' text and titles. */
function screen(name: keyof typeof FIX) {
  const data = FIX[name]
  const { container } = render(
    <GroupComparisonTable groups={data.groups} rows={data.rows} sigLevels={SIG} nonparametric={RANK.has(name)} />,
  )
  const subHeaders = [...container.querySelectorAll('thead tr:nth-child(2) th')].map(th => th.textContent ?? '')
  const rows = [...container.querySelectorAll('tbody > tr')]
    .filter(tr => tr.querySelector('th[scope="row"]'))
    .map(tr => [...tr.querySelectorAll('td')].map(td => {
      // `text` is what is SEEN; `full` adds the screen-reader text (the p's method).
      const seen = td.cloneNode(true) as HTMLElement
      seen.querySelectorAll('.sr-only').forEach(s => s.remove())
      return { text: seen.textContent ?? '', full: td.textContent ?? '', title: td.getAttribute('title') ?? '' }
    }))
  cleanup()
  const strip = render(<ComparisonTestStrip rows={data.rows} sigLevels={SIG} />)
  const stripText = strip.container.textContent ?? ''
  cleanup()
  return { subHeaders, rows, stripText }
}

beforeEach(() => vi.mocked(comparisonsApi.groupComparison).mockReset())
afterEach(cleanup)

describe('#1423 — the exported table is the table on screen', () => {
  for (const name of ['welch', 'anova3', 'anova2', 't3', 'mw', 'kw'] as const) {
    it(`${name}: every group cell, Δ, statistic, p and effect size is the screen's`, async () => {
      const { table } = await exported(name)
      const shown = screen(name)
      const data = FIX[name]
      const perGroup = RANK.has(name) ? 2 : 3
      const delta = !RANK.has(name) && data.groups.length === 2

      // The group sub-headers ARE the screen's, group by group.
      expect(table.headers.slice(1, 1 + perGroup * data.groups.length))
        .toEqual(data.groups.flatMap((g, i) => shown.subHeaders.slice(i * perGroup, (i + 1) * perGroup).map(h => `${g} ${h}`)))

      data.rows.forEach((row, r) => {
        const cells = table.rows[r]
        const tds = shown.rows[r]
        const groupCells = perGroup * data.groups.length
        // n, M, SD (or n, Mdn): the screen's text, cell for cell.
        expect(cells.slice(1, 1 + groupCells)).toEqual(tds.slice(0, groupCells).map(t => t.text))
        let at = 1 + groupCells
        let td = groupCells
        if (delta) expect(cells[at++]).toBe(tds[td++].text)       // Δ — or the screen's dash
        if (!row.test) return                                      // (the omitted row: next test)
        // Statistic: the screen's own words for it (the p cell's title on the Δ branch,
        // the statistic cell's title elsewhere) and the strip's.
        const statTitle = delta ? tds[td].title.split(', p')[0] : tds[td++].title
        expect(cells[at]).toBe(statTitle)
        expect(shown.stripText).toContain(cells[at++])
        // p: the screen's cell without its stars (the export prints none).
        expect(cells[at++]).toBe(tds[td++].full.replace(/\*+/g, ''))
        // Effect size: the strip's words, whose number is the table's badge.
        const effect = cells[at]
        expect(shown.stripText).toContain(effect)
        expect(effect).toContain(` = ${tds[td].text}`)
        expect(effect.startsWith(`${shown.subHeaders[shown.subHeaders.length - 1]} = `)).toBe(true)
      })
    })
  }
})

describe('#1423 — what the filing saw, measured', () => {
  it('no cell carries a test id from the wire', async () => {
    for (const name of Object.keys(FIX) as (keyof typeof FIX)[]) {
      const { table } = await exported(name)
      expect(JSON.stringify(table)).not.toMatch(/kruskal_wallis|mann_whitney_u|one_way_anova|independent_t_test/)
    }
  })

  it('a rank test prints each group’s MEDIAN, under Mdn', async () => {
    const { table } = await exported('mw')
    expect(table.headers).toEqual(['Variable', 'Men n', 'Men Mdn', 'Women n', 'Women Mdn', 'Test', 'p', 'Effect size'])
    // Means 7.00 and 4.40; medians 8 and 4.
    expect(table.rows[0]).toEqual(['Wellbeing (baseline)', '5', '8.00', '5', '4.00', 'U = 18.00', '.310 (exact p)', 'r = -0.44 (medium)'])
  })

  it('a p the wire rounds to 0 prints <.001, never 0.0000', async () => {
    const { table } = await exported('kw')
    expect(table.rows[0]).toEqual(['Score', '20', '10.50', '20', '24.50', '20', '39.50', 'H(2) = 48.56', '<.001', 'ε² = 0.82 (large)'])
  })

  it('two groups: n, M, SD, the difference, the t with its df, and d with its interval', async () => {
    const { table, docx } = await exported('welch')
    expect(table.headers).toEqual([
      'Variable', 'Men n', 'Men M', 'Men SD', 'Women n', 'Women M', 'Women SD',
      'Δ (Men − Women)', 'Test', 'p', 'Effect size',
    ])
    expect(table.rows[0]).toEqual([
      'Wellbeing (baseline)', '8', '4.50', '0.93', '9', '2.89', '0.78',
      '1.61', 't(13.8) = 3.85', '.002', 'd = 1.89 [0.72, 3.06] (large)',
    ])
    expect(table.rows[1][9]).toBe('<.001')
    // The omitted test: the reason where the statistic would be, dashes elsewhere (#566).
    expect(table.rows[2].slice(7)).toEqual(['—', 'Every value here is identical, so this cannot be computed.', '—', '—'])
    // Word's table is the same one (#1406 D5).
    expect(docx?.headers).toEqual(table.headers)
    expect(docx?.rows).toEqual(table.rows)
  })

  it('an ANOVA prints ω² — the displayed field — with its own word, and F with both df', async () => {
    const { table, entry } = await exported('anova3')
    expect(table.rows[0].slice(-3)).toEqual(['F(2, 15) = 42.35', '<.001', 'ω² = 0.82 (large)'])
    expect(entry?.html).toContain('ω² = 0.82 (large)')
    expect(entry?.html).toContain('&lt;.001')
  })

  it('the one-value group prints its n and mean and a dash for its SD, as on screen', async () => {
    const { entry } = await exported('anova3')
    expect(entry?.md).toContain('| Other score | 6 | 1.83 | 0.75 | 6 | 3.83 | 0.75 | 1 | 6.00 | — |')
  })

  it('positive control (passes before and after): the left-out group is said under the table', async () => {
    // #1329 (D51) — unchanged by #1423; a fixture or harness that reached no
    // comparison would fail here too.
    const { table } = await exported('anova3')
    expect(table.note).toBe('Other score: High has only one value, so it is shown without an SD and left out of the tests.')
  })
})
