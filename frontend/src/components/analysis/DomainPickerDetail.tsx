import { useMemo } from 'react'
import { Plus } from 'lucide-react'
import { resolveBracketColor, BRACKET_DOT_CLASS } from '@/components/crosswalk/bracket-color'
import { isCrosswalkAuto, isUngroupedScaleScore, metricDisplayLabel } from '@/lib/metric-label'
import type { AnalysisDomainResponse, MetricDefinitionSummaryResponse } from '@/lib/api'

/**
 * Inline detail content rendered below a selected row in
 * ColumnPicker.DomainsView. Visual-only expansion — useListKeyboardNav stays
 * at domains.length so focus management on the parent row isn't disturbed.
 *
 * Behavior:
 *   - Member preview: groups members by dataset name, truncates long lists
 *   - Scale-score state:
 *       no ungrouped domain_aggregate metric → "Create scale score" button
 *       exactly one → label preview (with `(auto)` suffix when applicable)
 *       multiple → radio list, ungrouped variant pre-selected
 *           (overridden by `selectedMetricIdHint` from `?metric_id=` URL)
 *
 * Foot-gun: filter requires BOTH grouping_column_id AND grouping_column_id_2
 * to be null. See `isUngroupedScaleScore` in lib/metric-label.ts.
 */

export interface DomainPickerDetailProps {
  domain: AnalysisDomainResponse
  /** Pre-filtered to metrics whose `input_source_id === domain.id` and
   * `input_source_type === 'dataset_domain'`. Caller does the filter once
   * to keep this component cheap to mount/unmount on row toggle. */
  domainMetrics: MetricDefinitionSummaryResponse[]
  /** Optional URL-driven pre-selection of a specific metric variant. */
  selectedMetricIdHint?: number | null
  /** Fires when the user clicks "Create scale score". Caller invokes the
   * domains/{id}/create-score-metric mutation. */
  onCreateScoreMetric: (domainId: number) => void
  /** Disables the create button while the mutation is in flight. */
  isCreatingMetric: boolean
  /** Optional: writing the chosen metric's id to `?metric_id=` URL param. */
  onPickMetric?: (metricId: number) => void
}

export default function DomainPickerDetail({
  domain,
  domainMetrics,
  selectedMetricIdHint,
  onCreateScoreMetric,
  isCreatingMetric,
  onPickMetric,
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

  // Foot-gun: ungrouped scale-score metrics require BOTH grouping columns null
  const ungroupedMetrics = useMemo(
    () => domainMetrics.filter(isUngroupedScaleScore),
    [domainMetrics],
  )

  // Pre-select: hint > the auto-origin ungrouped variant > first ungrouped
  const activeMetricId = useMemo(() => {
    if (selectedMetricIdHint && ungroupedMetrics.some(m => m.id === selectedMetricIdHint)) {
      return selectedMetricIdHint
    }
    const auto = ungroupedMetrics.find(isCrosswalkAuto)
    if (auto) return auto.id
    return ungroupedMetrics[0]?.id ?? null
  }, [selectedMetricIdHint, ungroupedMetrics])

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

  const renderMetricSection = () => {
    if (ungroupedMetrics.length === 0) {
      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onCreateScoreMetric(domain.id)
          }}
          disabled={isCreatingMetric}
          className="flex items-center gap-1 text-[11px] text-primary hover:underline disabled:text-mm-text-faint disabled:no-underline disabled:cursor-not-allowed"
        >
          <Plus className="w-3 h-3" />
          {isCreatingMetric ? 'Creating scale score...' : 'Create scale score'}
        </button>
      )
    }
    if (ungroupedMetrics.length === 1) {
      const m = ungroupedMetrics[0]
      return (
        <div className="text-[11px] text-mm-text-muted">
          Scale score: <span className="text-mm-text">{metricDisplayLabel(m)}</span>
        </div>
      )
    }
    // Multi-metric radio list
    return (
      <div role="radiogroup" aria-label={`Scale-score metric for ${domain.name}`} className="space-y-0.5">
        {ungroupedMetrics.map(m => (
          <label
            key={m.id}
            className="flex items-center gap-1.5 text-[11px] text-mm-text cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="radio"
              name={`domain-metric-${domain.id}`}
              value={m.id}
              checked={activeMetricId === m.id}
              onChange={() => onPickMetric?.(m.id)}
              className="shrink-0"
            />
            <span className="truncate" title={metricDisplayLabel(m)}>
              {metricDisplayLabel(m)}
            </span>
          </label>
        ))}
      </div>
    )
  }

  return (
    <div
      data-testid={`domain-picker-detail-${domain.id}`}
      className="pl-8 pr-3 pb-2 pt-1 border-l-2 ml-3 space-y-1.5"
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
      <div className="pt-0.5">{renderMetricSection()}</div>
    </div>
  )
}
