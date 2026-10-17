import { useMemo } from 'react'
import { Plus, AlertTriangle, HelpCircle } from 'lucide-react'
import { resolveBracketColor, BRACKET_DOT_CLASS } from '@/components/crosswalk/bracket-color'
import { metricDisplayLabel } from '@/lib/metric-label'
import { MODE_DISABLED_CLASS } from '@/lib/mode-disabled'
import { compareScales } from '@/lib/scale-comparison'
import type { AnalysisDomainResponse, MetricDefinitionSummaryResponse } from '@/lib/api'

/**
 * Inline detail content rendered below a selected row in
 * ColumnPicker.DomainsView. Visual-only expansion — useListKeyboardNav stays
 * at domains.length so focus management on the parent row isn't disturbed.
 *
 * Behavior:
 *   - Member preview: groups members by dataset name, truncates long lists
 *   - Scale-score state, from the metric the server flags `is_scale_score`:
 *       none → "Create scale score" button
 *       one  → label preview (with `(auto)` suffix when applicable)
 *
 * #1177: a group has ONE scale score. This used to list every ungrouped
 * aggregate of the group as a radio group named "Scale-score metric for …" —
 * a lookalike with some answers excluded among them, under the same label —
 * and the choice changed nothing but the `?metric_id=` URL parameter, which
 * no chart reads. With only a lookalike it showed "Scale score:" and hid the
 * button, while Correlations and Comparisons (rightly) said there was none.
 */

export interface DomainPickerDetailProps {
  domain: AnalysisDomainResponse
  /** Pre-filtered to metrics whose `input_source_id === domain.id` and
   * `input_source_type === 'dataset_domain'`. Caller does the filter once
   * to keep this component cheap to mount/unmount on row toggle. */
  domainMetrics: MetricDefinitionSummaryResponse[]
  /** Fires when the user clicks "Create scale score". Caller invokes the
   * domains/{id}/create-score-metric mutation. */
  onCreateScoreMetric: (domainId: number) => void
  /** Holds the create button busy while the mutation is in flight. */
  isCreatingMetric: boolean
}

export default function DomainPickerDetail({
  domain,
  domainMetrics,
  onCreateScoreMetric,
  isCreatingMetric,
}: DomainPickerDetailProps) {
  const swatchColor = resolveBracketColor(domain.color)

  // Group members by dataset name for the preview block
  const membersByDataset = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const m of domain.members) {
      const ds = m.dataset_name ?? '(unknown dataset)'
      const label = m.column_code || m.label
      const arr = map.get(ds)
      if (arr) arr.push(label)
      else map.set(ds, [label])
    }
    return Array.from(map.entries())
  }, [domain.members])

  const scaleScore = domainMetrics.find(m => m.is_scale_score)

  /**
   * #693 — do these items share a scale?
   *
   * The score this panel creates is an unweighted mean of the members' means,
   * so a 1–5 item averaged with a 1–7 item lands on neither scale. The
   * detection existed on the crosswalk grid, which is a screen the researcher
   * has already left by the time they get here. `scale_points` / `scale_labels`
   * ride on `DomainMemberInfo` already — no wire change was needed, only a
   * shared comparator.
   */
  const scaleAgreement = useMemo(
    () => compareScales(domain.members),
    [domain.members],
  )

  const renderMembers = () => {
    if (membersByDataset.length === 0) {
      return <div className="text-[11px] text-mm-text-faint italic">No members</div>
    }
    return (
      <div className="space-y-0.5">
        {membersByDataset.map(([dsName, labels]) => {
          const preview = labels.slice(0, 4).join(', ')
          const more = labels.length > 4 ? `, +${labels.length - 4}` : ''
          return (
            <div key={dsName} className="text-[11px] text-mm-text-muted leading-tight">
              <span className="font-medium text-mm-text">{dsName}</span>
              <span className="text-mm-text-faint">: {preview}{more}</span>
            </div>
          )
        })}
      </div>
    )
  }

  /**
   * The scale disclosure — #693(i) + (iii).
   *
   * Two states speak and one stays quiet:
   *   `mismatch` — the members demonstrably measure on different scales.
   *   `unknown`  — fewer than two members record a scale, so nothing was
   *                checked. It used to be silent, which reads exactly like a
   *                passed check; that hole is how the flagship 1–5 vs 1–7 case
   *                escaped whenever either side lacked labels.
   *   `match`    — say nothing. A notice on every well-formed group is noise,
   *                and noise is what gets ignored when it matters.
   *
   * ⚠️ Not an `<Alert>` or a toast: this is reference text under a picker row,
   * and an assertive announcement would interrupt keyboard navigation through
   * the domain list. The icon is `aria-hidden`; the sentence carries the meaning.
   */
  const renderScaleNotice = () => {
    if (scaleAgreement === 'match') return null
    const mismatch = scaleAgreement === 'mismatch'
    const Icon = mismatch ? AlertTriangle : HelpCircle
    return (
      <div
        className={`flex items-start gap-1.5 text-[11px] leading-snug ${
          mismatch ? 'text-amber-700 dark:text-amber-400' : 'text-mm-text-muted'
        }`}
      >
        <Icon className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          {mismatch
            ? 'These variables use different response scales. A scale score averages their '
              + 'item means without rescaling, so the result sits on none of them.'
            : 'Response scales aren’t recorded for these variables, so Mixed Measures can’t '
              + 'check whether they match. A scale score averages their item means without '
              + 'rescaling.'}
        </span>
      </div>
    )
  }

  const renderMetricSection = () => {
    if (!scaleScore) {
      // Busy is `aria-disabled` + a guard, never `disabled`: Chrome blurs a
      // focused button that becomes disabled (#959).
      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            if (isCreatingMetric) return
            onCreateScoreMetric(domain.id)
          }}
          aria-disabled={isCreatingMetric || undefined}
          className={`flex items-center gap-1 text-[11px] text-primary hover:underline aria-disabled:no-underline ${MODE_DISABLED_CLASS}`}
        >
          <Plus className="w-3 h-3" aria-hidden="true" />
          {isCreatingMetric ? 'Creating scale score…' : 'Create scale score'}
        </button>
      )
    }
    return (
      <div className="text-[11px] text-mm-text-muted">
        Scale score: <span className="text-mm-text">{metricDisplayLabel(scaleScore)}</span>
      </div>
    )
  }

  // #1180: the indent was `pl-8 … ml-3` — 58 px of chrome in a sidebar that can be
  // 200 px wide, where *Create scale score* needs 113 and got 111. `pl-4 … ml-2`
  // gives back 20 px; the coloured rule still marks the detail as the group's.
  return (
    <div
      data-testid={`domain-picker-detail-${domain.id}`}
      className="pl-4 pr-3 pb-2 pt-1 border-l-2 ml-2 space-y-1.5"
      style={{ borderColor: swatchColor }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={BRACKET_DOT_CLASS}
          style={{ backgroundColor: swatchColor }}
          aria-hidden="true"
        />
        <span className="text-[11px] font-medium text-mm-text-muted">
          {domain.member_count} {domain.member_count === 1 ? 'variable' : 'variables'}
          {' · '}
          {membersByDataset.length} {membersByDataset.length === 1 ? 'dataset' : 'datasets'}
        </span>
      </div>
      {renderMembers()}
      {renderScaleNotice()}
      <div className="pt-0.5">{renderMetricSection()}</div>
    </div>
  )
}
