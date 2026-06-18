/**
 * Display-label helper for MetricDefinition rows. The `(auto)` suffix marks
 * metrics auto-created by the Tier 3 crosswalk's "Create scale score" path
 * (services/metrics.py::create_scale_score_metric → origin_context="crosswalk_auto").
 *
 * Foot-gun: the suffix keys off `origin_context`, NOT `origin`. Crosswalk
 * metrics are persisted with `origin="human"` so they survive the 7-day auto
 * cleanup and remain in R-export filters; `origin_context="crosswalk_auto"`
 * is the UI marker.
 *
 * Foot-gun: ungrouped scale-score metrics require BOTH `grouping_column_id`
 * AND `grouping_column_id_2` to be null. A single-field check would silently
 * match grouped variants and pre-select the wrong row in DomainPickerDetail.
 */

interface MetricLike {
  name: string
  input_source_label: string | null
  origin_context: string | null
}

interface MetricGroupingLike {
  metric_type: string
  grouping_column_id: number | null
  grouping_column_id_2: number | null
}

export function isCrosswalkAuto(m: { origin_context: string | null }): boolean {
  return m.origin_context === 'crosswalk_auto'
}

export function isUngroupedScaleScore(m: MetricGroupingLike): boolean {
  return (
    m.metric_type === 'domain_aggregate' &&
    m.grouping_column_id == null &&
    m.grouping_column_id_2 == null
  )
}

export function metricDisplayLabel(m: MetricLike): string {
  const base = m.input_source_label ?? m.name
  return isCrosswalkAuto(m) ? `${base} (auto)` : base
}
