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
 * ⚠️ WHICH metric is a variable group's scale score is NOT decided here: the
 * server states it as `is_scale_score` (#1177). `isUngroupedScaleScore` — any
 * `domain_aggregate` with both grouping columns null — lived here and was
 * deleted with its last caller, because a lookalike with some answers excluded
 * passes that test too.
 */

interface MetricLike {
  name: string
  input_source_label: string | null
  origin_context: string | null
}

export function isCrosswalkAuto(m: { origin_context: string | null }): boolean {
  return m.origin_context === 'crosswalk_auto'
}

export function metricDisplayLabel(m: MetricLike): string {
  const base = m.input_source_label ?? m.name
  return isCrosswalkAuto(m) ? `${base} (auto)` : base
}
