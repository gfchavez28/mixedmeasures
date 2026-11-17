/**
 * The quantitative GROUP COMPARISON's cells, as every surface shows them: the table
 * (`GroupComparisonTable`), the strip under every other comparison figure
 * (`ComparisonTestStrip`) and the Canvas export's table
 * (`canvas-export.ts::comparisonExportTable`, which the joint display's bound saved
 * result prints too, D165).
 *
 * 🔴 **#1423 — ONE resolver per fact, read by all three.** The export derived its own
 * cells: the test's wire id (`kruskal_wallis = 48.557`), the MEAN under a figure showing
 * medians, `p.toFixed(4)` ("0.0000") and no effect size — a third derivation of what the
 * table and the strip had already decided. An export quotes the DISPLAYED field
 * (the internal design notes).
 *
 * 🔴 **#1424 — the effect size is NAMED from the wire's `effect_size_type`**, never from
 * the test or the group count (the stated-basis rule: the server says which statistic it
 * sent; the client never infers it). The names are hand-mirrored with the four runners in
 * `backend/app/services/comparisons.py` (no codegen) and held there by
 * `backend/tests/test_effect_size_type_1424.py`. An UNKNOWN type is called "effect size",
 * never a symbol it may not be. ANOVA's ω² is the deliberate override (statistics.md §3:
 * the UI displays ω², the primary field is η²).
 */
import type { ComparisonRow, GroupStat, TestResult } from '@/lib/api'
import { formatP } from '@/lib/chart-data'
import { NO_VALUE, formatStat } from '@/lib/stat-format'
import { pMethodShort } from '@/lib/p-method'

export const EFFECT_SIZE_COHENS_D = 'cohens_d'
export const EFFECT_SIZE_ETA_SQUARED = 'eta_squared'
export const EFFECT_SIZE_RANK_BISERIAL_R = 'rank_biserial_r'
export const EFFECT_SIZE_EPSILON_SQUARED = 'epsilon_squared'

export type EffectSizeType =
  | typeof EFFECT_SIZE_COHENS_D
  | typeof EFFECT_SIZE_ETA_SQUARED
  | typeof EFFECT_SIZE_RANK_BISERIAL_R
  | typeof EFFECT_SIZE_EPSILON_SQUARED

interface EffectSizeName {
  /** The column header and the strip's symbol. */
  symbol: string
  /** What a cell's tooltip calls it. */
  name: string
}

const EFFECT_SIZE_NAMES = {
  [EFFECT_SIZE_COHENS_D]: { symbol: 'd', name: "Cohen's d" },
  [EFFECT_SIZE_ETA_SQUARED]: { symbol: 'η²', name: 'η²' },
  [EFFECT_SIZE_RANK_BISERIAL_R]: { symbol: 'r', name: 'r' },
  // Tomczak & Tomczak's (2014) E²_R (#1327).
  [EFFECT_SIZE_EPSILON_SQUARED]: { symbol: 'ε²', name: 'ε²' },
} satisfies Record<EffectSizeType, EffectSizeName>

const OMEGA_SQUARED: EffectSizeName = { symbol: 'ω²', name: 'ω²' }
const UNKNOWN_EFFECT: EffectSizeName = { symbol: 'ES', name: 'effect size' }

function knownEffect(type: string | null | undefined): type is EffectSizeType {
  return type != null && Object.prototype.hasOwnProperty.call(EFFECT_SIZE_NAMES, type)
}

/** The wire's effect size, named — "effect size" for a type this client does not know. */
export function effectSizeName(type: string | null | undefined): EffectSizeName {
  return knownEffect(type) ? EFFECT_SIZE_NAMES[type] : UNKNOWN_EFFECT
}

export interface DisplayedEffect extends EffectSizeName {
  value: number
  /** The qualitative word classified from THIS value (#742). */
  label: string | null
  /** The interval of THIS value — never η²'s beside ω². */
  ciLower: number | null
  ciUpper: number | null
  /** ANOVA's ω² shown in place of the wire's primary η² (the deliberate override). */
  omegaOverride: boolean
}

/**
 * THE effect size a row shows: the number, the word that belongs to that number, its
 * interval, and what to call it — one resolver, so a cell cannot render one statistic's
 * value beside another's verdict (#742), under another's header (#746) or another's
 * name (#1424).
 *
 * The ω² override is keyed on the wire too: where the server's effect size is η² AND it
 * sends ω² beside it (the one-way ANOVA), the screen shows ω². With no ω², η² is named
 * η² — the strip used to print η²'s number as "ω²".
 */
export function displayedEffect(test: TestResult): DisplayedEffect {
  if (test.effect_size_type === EFFECT_SIZE_ETA_SQUARED && test.omega_squared != null) {
    return {
      ...OMEGA_SQUARED, value: test.omega_squared, label: test.omega_squared_label,
      ciLower: null, ciUpper: null, omegaOverride: true,
    }
  }
  return {
    ...effectSizeName(test.effect_size_type),
    value: test.effect_size,
    label: test.effect_size_label,
    ciLower: test.effect_size_ci_lower,
    ciUpper: test.effect_size_ci_upper,
    omegaOverride: false,
  }
}

/** The strip's effect: `d = 1.89 [0.72, 3.06] (large)`, `ω² = 0.82 (large)`. */
export function effectSizeText(test: TestResult): string {
  const es = displayedEffect(test)
  const ci = es.ciLower != null && es.ciUpper != null
    ? ` [${es.ciLower.toFixed(2)}, ${es.ciUpper.toFixed(2)}]`
    : ''
  return `${es.symbol} = ${es.value.toFixed(2)}${ci}${es.label ? ` (${es.label})` : ''}`
}

/**
 * The test statistic's symbol with its degrees of freedom — `t(13.8)`, `F(2, 15)`, `U`,
 * `H(2)` — from the wire's `test_type`, the test the server states it ran. Never from the
 * group count: the sidebar runs ANOVA over two groups and the t-test over three.
 */
export function testStatisticLabel(test: TestResult): string {
  switch (test.test_type) {
    case 'mann_whitney_u': return 'U'
    case 'kruskal_wallis': return `H(${test.df.toFixed(0)})`
    case 'one_way_anova':
      return `F(${test.df.toFixed(0)}${test.df2 != null ? ', ' + test.df2.toFixed(0) : ''})`
    case 'independent_t_test': return `t(${test.df.toFixed(1)})`
    default: return 'Statistic'
  }
}

/** The strip's statistic: `F(2, 15) = 42.35`. */
export function testStatisticText(test: TestResult): string {
  return `${testStatisticLabel(test)} = ${test.statistic.toFixed(2)}`
}

/** A p as the table's cell prints it — `.002`, `<.001` — with the method the data chose. */
export function pCellText(test: TestResult): string {
  const method = pMethodShort(test.p_method)
  return `${formatP(test.p)}${method ? ` (${method})` : ''}`
}

/** Each group's columns: n and the median under a rank test, else n, mean and SD. */
export function groupStatHeaders(nonparametric: boolean | undefined): string[] {
  return nonparametric ? ['n', 'Mdn'] : ['n', 'M', 'SD']
}

/** One group's cells under `groupStatHeaders` — a dash for each when it has nobody. */
export function groupStatTexts(stat: GroupStat | undefined, nonparametric: boolean | undefined): string[] {
  if (!stat || stat.n === 0) return groupStatHeaders(nonparametric).map(() => NO_VALUE)
  if (nonparametric) {
    return [String(stat.n), stat.median != null ? stat.median.toFixed(2) : NO_VALUE]
  }
  return [String(stat.n), formatStat(stat.mean), formatStat(stat.sd)]
}

/** Whether the table shows the two-group Difference column (Δ) instead of the statistic. */
export function hasDifferenceColumn(groups: string[], nonparametric: boolean | undefined): boolean {
  return !nonparametric && groups.length === 2
}

/**
 * The first group's mean minus the second's — `null` when either has none (#689: `0`
 * would read as "the groups are identical").
 */
export function meanDifference(row: ComparisonRow, groups: string[]): number | null {
  const g1 = row.group_stats.find(s => s.group === groups[0])
  const g2 = row.group_stats.find(s => s.group === groups[1])
  return g1?.mean != null && g2?.mean != null ? g1.mean - g2.mean : null
}
