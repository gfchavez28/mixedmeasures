import type { ComparisonRow } from '@/lib/api'
import { formatPValue, getSignificanceStars } from '@/lib/chart-data'
import AssumptionNote from './AssumptionNote'

interface ComparisonTestStripProps {
  rows: ComparisonRow[]
  sigLevels: { show_05: boolean; show_01: boolean; show_001: boolean }
  nonparametric?: boolean
}

export default function ComparisonTestStrip({ rows, sigLevels, nonparametric }: ComparisonTestStripProps) {
  const testRows = rows.filter(r => r.test)
  if (testRows.length === 0) return null

  return (
    <div className="mt-2 border-t border-mm-border-subtle pt-2 space-y-0.5">
      {testRows.map(row => {
        const t = row.test!
        const stars = getSignificanceStars(t.p, sigLevels)

        let statLabel: string
        let esLabel: string
        let esValue: string
        // The qualitative word must describe the number actually rendered.
        let esWord: string | null = t.effect_size_label

        if (t.test_type === 'mann_whitney_u') {
          statLabel = `U`
          esLabel = 'r'
          esValue = t.effect_size.toFixed(2)
        } else if (t.test_type === 'kruskal_wallis') {
          statLabel = `H(${t.df.toFixed(0)})`
          esLabel = '\u03B5\u00B2'
          esValue = t.effect_size.toFixed(2)
        } else if (t.test_type === 'one_way_anova') {
          statLabel = `F(${t.df.toFixed(0)}${t.df2 != null ? ', ' + t.df2.toFixed(0) : ''})`
          esLabel = '\u03C9\u00B2'
          // #742: when \u03C9\u00B2 is what we show, its own label is what we say. The
          // fallback keeps \u03B7\u00B2's label paired with \u03B7\u00B2's value, so the number and
          // the word stay from the same statistic in both branches.
          esValue = t.omega_squared != null ? t.omega_squared.toFixed(2) : t.effect_size.toFixed(2)
          esWord = t.omega_squared != null ? t.omega_squared_label : t.effect_size_label
        } else {
          statLabel = `t(${t.df.toFixed(1)})`
          esLabel = 'd'
          esValue = t.effect_size.toFixed(2)
        }

        const ciStr = !nonparametric && t.effect_size_ci_lower != null && t.effect_size_ci_upper != null
          ? ` [${t.effect_size_ci_lower.toFixed(2)}, ${t.effect_size_ci_upper.toFixed(2)}]`
          : ''

        const labelStr = esWord ? ` (${esWord})` : ''

        // Post-hoc summary for significant ANOVA.
        //
        // #744 settled the rule this line was breaking: a DISPLAY honours the
        // researcher's display settings. The gate below already used the most
        // lenient ENABLED level, then counted the pairs at a hardcoded .05 — so
        // with only "0.01" switched on, the strip could call the ANOVA
        // significant at .01 and report "3 of 5 pairs significant" at .05. Two
        // thresholds in one sentence, and neither was stated.
        let postHocNote = ''
        if (t.test_type === 'one_way_anova' && t.post_hoc?.comparisons) {
          const alpha = sigLevels.show_05 ? 0.05 : sigLevels.show_01 ? 0.01 : sigLevels.show_001 ? 0.001 : 0.05
          if (t.p < alpha) {
            const total = t.post_hoc.comparisons.length
            const sig = t.post_hoc.comparisons.filter((c: { p: number }) => c.p < alpha).length
            postHocNote = ` | ${sig} of ${total} pairs significant at p < ${String(alpha).replace(/^0/, '')}`
          }
        }

        return (
          <div key={`${row.source_id}-${row.source_type}`}>
          <div
            className="flex items-center gap-3 px-2 py-1 text-[11px] text-mm-text-muted font-mono tabular-nums"
          >
            {/* The name is clipped at 180px and this strip has no tooltip, so
                without a title a truncated variable is simply unreadable — the
                sibling table already titles the same label with `full_label`. */}
            <span
              className="truncate max-w-[180px] font-sans text-mm-text-secondary"
              title={row.full_label || row.label}
            >
              {row.label}
            </span>
            <span>{statLabel} = {t.statistic.toFixed(2)}</span>
            <span className={t.p < 0.05 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>
              {formatPValue(t.p)}{stars}
            </span>
            <span>{esLabel} = {esValue}{ciStr}{labelStr}</span>
            {postHocNote && <span className="text-mm-text-faint">{postHocNote}</span>}
          </div>
          {/* #525 — the panel offers "use the non-parametric test"; this is the
              answer to "do I need to?", beside the test it qualifies. */}
          <AssumptionNote row={row} />
          </div>
        )
      })}
    </div>
  )
}
