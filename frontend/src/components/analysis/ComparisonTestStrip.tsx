import type { ComparisonRow } from '@/lib/api'
import { formatPValue, getSignificanceStars } from '@/lib/chart-data'
import { pMethodShort } from '@/lib/p-method'
import { untestedGroupsNote } from '@/lib/untested-groups'
import { effectSizeText, testStatisticText } from '@/lib/group-comparison-display'
import AssumptionNote from './AssumptionNote'

interface ComparisonTestStripProps {
  rows: ComparisonRow[]
  sigLevels: { show_05: boolean; show_01: boolean; show_001: boolean }
}

// #1424 D264: no `nonparametric` prop. It gated the interval, which now follows the
// displayed number itself, and a prop that looks as if it controls the strip is a trap.
export default function ComparisonTestStrip({ rows, sigLevels }: ComparisonTestStripProps) {
  const testRows = rows.filter(r => r.test)
  if (testRows.length === 0) return null

  return (
    <div className="mt-2 border-t border-mm-border-subtle pt-2 space-y-0.5">
      {testRows.map(row => {
        const t = row.test!
        const stars = getSignificanceStars(t.p, sigLevels)
        // #1424 / #1423: the statistic and the effect size come from the resolvers
        // the table and the Canvas export read (`lib/group-comparison-display.ts`).
        // The effect size is NAMED from the wire's `effect_size_type`: this strip
        // branched on `test_type`, an unknown test printing its number as `d`, and
        // an ANOVA with no omega-squared printing eta-squared's number under the
        // omega symbol. #742 holds there: the word is classified from the number
        // shown, and the interval is that number's own (omega carries none).
        // #1326 STAT-12 (D58): the data chose this p's method.
        const method = pMethodShort(t.p_method)
        // #1329 (D51): a group shown in the chart and left out of this test.
        const untested = untestedGroupsNote(row.untested_groups)

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
            <span>{testStatisticText(t)}</span>
            <span className={t.p < 0.05 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>
              {formatPValue(t.p)}{stars}{method && <span className="font-sans text-mm-text-faint"> ({method})</span>}
            </span>
            <span>{effectSizeText(t)}</span>
            {postHocNote && <span className="text-mm-text-faint">{postHocNote}</span>}
          </div>
          {untested && <p className="px-2 text-[11px] text-mm-text-muted font-sans">{untested}</p>}
          {/* #525 — the panel offers "use the non-parametric test"; this is the
              answer to "do I need to?", beside the test it qualifies. */}
          <AssumptionNote row={row} />
          </div>
        )
      })}
    </div>
  )
}
