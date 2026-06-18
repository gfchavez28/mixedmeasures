/* eslint-disable react-hooks/set-state-in-effect -- ARIA announcements via setState in response to data/config changes */
import { useState, useEffect, useRef, type MutableRefObject } from 'react'
import type { ChartType } from '@/lib/chart-data'
import type { AnalysisDemographicItem } from '@/lib/api'

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  heatmap: 'Heatmap',
  horizontal_bar: 'Horizontal Bar',
  stacked_bar: 'Stacked Bar',
  vertical_bar: 'Vertical Bar',
  dumbbell: 'Dumbbell',
  table: 'Summary Table',
  line: 'Line Chart',
  frequency_table: 'Frequency Table',
  cross_tab: 'Cross-Tabulation',
}

export function useChartAnnouncements(deps: {
  isComputing: boolean
  metricCount: number
  chartType: ChartType | null
  groupingColumnId: number | null
  groupingColumnId2: number | null
  demographics: AnalysisDemographicItem[]
  divergingMode?: boolean
  axisTransform?: string
}): string {
  const [announcement, setAnnouncement] = useState('')
  const mountedRef = useRef(false)

  // Skip all announcements on initial mount — delay so effects in the
  // same render cycle still see mountedRef.current === false
  useEffect(() => {
    const id = requestAnimationFrame(() => { mountedRef.current = true })
    return () => cancelAnimationFrame(id)
  }, [])

  // Announce on compute complete
  useEffect(() => {
    if (!mountedRef.current) return
    if (!deps.isComputing && deps.metricCount > 0) {
      setAnnouncement(`Chart updated with ${deps.metricCount} variables`)
    }
  }, [deps.isComputing, deps.metricCount])

  // Announce chart type change
  useEffect(() => {
    if (!mountedRef.current) return
    if (deps.chartType) {
      const label = CHART_TYPE_LABELS[deps.chartType] || deps.chartType.replace(/_/g, ' ')
      setAnnouncement(`Chart type changed to ${label}`)
    }
  }, [deps.chartType])

  // Announce group by change (skip first render to avoid "Grouping removed" on mount)
  const prevGroupingRef = useRef<number | null | undefined>(undefined) as MutableRefObject<number | null | undefined>
  // Ref avoids putting the demographics array in useEffect deps (unstable identity).
  // Read inside the effect to get the latest value without re-triggering on every render.
  const demographicsRef = useRef(deps.demographics)
  useEffect(() => { demographicsRef.current = deps.demographics }, [deps.demographics])

  useEffect(() => {
    if (!mountedRef.current) return
    if (prevGroupingRef.current === undefined) {
      prevGroupingRef.current = deps.groupingColumnId
      return
    }
    prevGroupingRef.current = deps.groupingColumnId
    if (deps.groupingColumnId) {
      const demo1 = demographicsRef.current.find(d => d.id === deps.groupingColumnId)
      const label1 = demo1?.column_name || demo1?.column_text || 'variable'
      if (deps.groupingColumnId2) {
        const demo2 = demographicsRef.current.find(d => d.id === deps.groupingColumnId2)
        const label2 = demo2?.column_name || demo2?.column_text || 'variable'
        setAnnouncement(`Group by: ${label1} \u00d7 ${label2} applied`)
      } else {
        setAnnouncement(`Group by: ${label1} applied`)
      }
    } else {
      setAnnouncement('Grouping removed')
    }
  }, [deps.groupingColumnId, deps.groupingColumnId2])

  // Announce diverging mode change
  useEffect(() => {
    if (!mountedRef.current) return
    if (deps.divergingMode != null) {
      setAnnouncement(deps.divergingMode ? 'Diverging layout applied' : 'Standard layout applied')
    }
  }, [deps.divergingMode])

  // Announce axis transform change
  useEffect(() => {
    if (!mountedRef.current) return
    if (deps.axisTransform) {
      setAnnouncement(deps.axisTransform === 'log' ? 'Log scale applied' : 'Linear scale applied')
    }
  }, [deps.axisTransform])

  return announcement
}
