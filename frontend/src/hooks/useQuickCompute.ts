import { useState, useRef, useCallback, useEffect } from 'react'
import { metricsApi, QuickComputeRequest, MetricDefinitionResponse } from '../lib/api'

const DEBOUNCE_MS = 300

interface UseQuickComputeReturn {
  /** Computed metrics from the latest successful quick-compute call */
  metrics: MetricDefinitionResponse[]
  /** Whether a compute request is in flight */
  isComputing: boolean
  /** Error message from the last failed request, if any */
  error: string | null
  /** Trigger a quick-compute with the given parameters */
  compute: (params: QuickComputeParams) => void
  /** Clear all metrics and reset state */
  clear: () => void
}

export interface QuickComputeParams {
  columnIds: number[]
  domainIds: number[]
  metricType: string
  config?: Record<string, unknown>
  groupingColumnId?: number | null
  groupingColumnId2?: number | null
  groupingMode?: 'column' | 'dataset' | null
  excludeValues?: string[] | null
  decompose?: boolean
}

export function useQuickCompute(projectId: number): UseQuickComputeReturn {
  const [metrics, setMetrics] = useState<MetricDefinitionResponse[]>([])
  const [isComputing, setIsComputing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track the latest request ID to ignore stale responses
  const requestIdRef = useRef(0)

  const clear = useCallback(() => {
    // Cancel any pending debounce or in-flight request
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setMetrics([])
    setIsComputing(false)
    setError(null)
  }, [])

  const compute = useCallback((params: QuickComputeParams) => {
    const { columnIds, domainIds, metricType, config, groupingColumnId, groupingColumnId2, groupingMode, excludeValues, decompose } = params

    // Nothing selected — clear
    if (columnIds.length === 0 && domainIds.length === 0) {
      clear()
      return
    }

    // Clear any pending debounce timer
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }

    // Show computing state immediately
    setIsComputing(true)
    setError(null)

    timerRef.current = setTimeout(async () => {
      // Abort previous in-flight request
      if (abortRef.current) {
        abortRef.current.abort()
      }
      const controller = new AbortController()
      abortRef.current = controller

      const currentRequestId = ++requestIdRef.current

      // Build sources
      const sources = [
        ...columnIds.map(id => ({ source_type: 'dataset_column' as const, source_id: id })),
        ...domainIds.map(id => ({ source_type: 'dataset_domain' as const, source_id: id })),
      ]

      const request: QuickComputeRequest = {
        sources,
        metric_type: metricType,
        config: config || {},
        grouping_column_id: groupingColumnId ?? null,
        grouping_column_id_2: groupingColumnId2 ?? null,
        grouping_mode: groupingMode ?? null,
        exclude_values: excludeValues ?? null,
        decompose: decompose || undefined,
      }

      try {
        const response = await metricsApi.quickCompute(projectId, request, controller.signal)

        // Only apply if this is still the latest request
        if (currentRequestId === requestIdRef.current) {
          setMetrics(response.metrics)
          setIsComputing(false)
          setError(null)
        }
      } catch (err: unknown) {
        // Ignore abort errors (user clicked again)
        const errObj = err as { name?: string; response?: { data?: { detail?: string } }; message?: string }
        if (errObj?.name === 'AbortError') {
          return
        }
        // Only apply if this is still the latest request
        if (currentRequestId === requestIdRef.current) {
          setIsComputing(false)
          setError(errObj?.response?.data?.detail || errObj?.message || 'Computation failed')
        }
      }
    }, DEBOUNCE_MS)
  }, [projectId, clear])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (abortRef.current) abortRef.current.abort()
    }
  }, [])

  return { metrics, isComputing, error, compute, clear }
}
