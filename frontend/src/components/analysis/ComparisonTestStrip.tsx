import type { ComparisonRow } from '@/lib/api'
import { formatPValue, getSignificanceStars } from '@/lib/chart-data'

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
          esValue = t.omega_squared != null ? t.omega_squared.toFixed(2) : t.effect_size.toFixed(2)
        } else {
          statLabel = `t(${t.df.toFixed(1)})`
          esLabel = 'd'
          esValue = t.effect_size.toFixed(2)
        }

        const ciStr = !nonparametric && t.effect_size_ci_lower != null && t.effect_size_ci_upper != null
          ? ` [${t.effect_size_ci_lower.toFixed(2)}, ${t.effect_size_ci_upper.toFixed(2)}]`
          : ''

        const labelStr = t.effect_size_label ? ` (${t.effect_size_label})` : ''

        // Post-hoc summary for significant ANOVA
        let postHocNote = ''
        if (t.test_type === 'one_way_anova' && t.post_hoc?.comparisons) {
          const mostLenient = sigLevels.show_05 ? 0.05 : sigLevels.show_01 ? 0.01 : sigLevels.show_001 ? 0.001 : 0.05
          if (t.p < mostLenient) {
            const total = t.post_hoc.comparisons.length
            const sig = t.post_hoc.comparisons.filter((c: { p: number }) => c.p < 0.05).length
            postHocNote = ` | ${sig} of ${total} pairs significant`
          }
        }

        return (
          <div
            key={`${row.source_id}-${row.source_type}`}
            className="flex items-center gap-3 px-2 py-1 text-[11px] text-mm-text-muted font-mono tabular-nums"
          >
            <span className="truncate max-w-[180px] font-sans text-mm-text-secondary">{row.label}</span>
            <span>{statLabel} = {t.statistic.toFixed(2)}</span>
            <span className={t.p < 0.05 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>
              {formatPValue(t.p)}{stars}
            </span>
            <span>{esLabel} = {esValue}{ciStr}{labelStr}</span>
            {postHocNote && <span className="text-mm-text-faint">{postHocNote}</span>}
          </div>
        )
      })}
    </div>
  )
}
