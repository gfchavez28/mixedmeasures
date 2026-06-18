/**
 * Pure helpers for turning a canvas material/block `content` config into a
 * quickCompute request. Extracted from InlineChartRenderer.tsx so they live in
 * a non-component module (consumed by both InlineChartRenderer and the canvas
 * export pipeline) — keeps Fast Refresh working for the component file.
 */
import type { QuickComputeRequest, GroupingMode } from '@/lib/api'

/** Extract quickCompute params from material config stored in block content. */
export function extractComputeParams(content: Record<string, unknown>): {
  columnIds: number[]
  domainIds: number[]
  metricType: string
  config: Record<string, unknown>
  groupingColumnId: number | null
  groupingColumnId2: number | null
  groupingMode: GroupingMode | null
  excludeValues: string[] | null
} {
  // Palette config uses column_ids/domain_ids (not selected_columns/selected_domains)
  const columnIds = (content.column_ids as number[]) ?? (content.selected_columns as number[]) ?? []
  const domainIds = (content.domain_ids as number[]) ?? (content.selected_domains as number[]) ?? []
  const metricType = (content.metric_type as string) ?? 'frequency_distribution'
  const groupingColumnId = (content.grouping_column_id as number) ?? null
  const groupingColumnId2 = (content.grouping_column_id_2 as number) ?? null
  const groupingMode = (content.grouping_mode as GroupingMode) ?? null
  const excludeValues = (content.exclude_values as string[]) ?? null

  // Build config object based on metric type
  let config: Record<string, unknown> = {}
  if (metricType === 'proportion') {
    const propConfig = content.proportion_config as Record<string, unknown> | undefined
    if (propConfig) {
      config = propConfig.mode === 'numeric'
        ? { mode: 'numeric', operator: propConfig.operator, threshold_numeric: propConfig.threshold_numeric }
        : { mode: 'values', threshold_values: propConfig.threshold_values }
    }
  } else if (metricType === 'domain_aggregate') {
    config = { child_metric_type: 'mean', child_config: {}, aggregation: 'mean' }
  }

  return { columnIds, domainIds, metricType, config, groupingColumnId, groupingColumnId2, groupingMode, excludeValues }
}

/** Build the quickCompute API request from extracted params. */
export function buildRequest(params: ReturnType<typeof extractComputeParams>): QuickComputeRequest {
  const sources = [
    ...params.columnIds.map(id => ({ source_type: 'dataset_column' as const, source_id: id })),
    ...params.domainIds.map(id => ({ source_type: 'dataset_domain' as const, source_id: id })),
  ]
  return {
    sources,
    metric_type: params.metricType,
    config: params.config,
    grouping_column_id: params.groupingColumnId,
    grouping_column_id_2: params.groupingColumnId2,
    grouping_mode: params.groupingMode,
    exclude_values: params.excludeValues,
  }
}
