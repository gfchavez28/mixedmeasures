/* eslint-disable react-refresh/only-export-components */
/**
 * SVG and PNG export utilities for chart components.
 * Includes batch export-all-charts-as-ZIP functionality.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
// html-to-image and jszip are dynamically imported in export functions
// to avoid bundling them in the main chunk (only needed on user-triggered export)

import type { MetricDefinitionResponse } from './api'
import {
  shapeFrequencyBars,
  shapeScalarBars,
  shapeHeatmapRows,
  shapeDumbbellRows,
  shapeStackedBars,
  shapeSummaryStats,
} from './chart-data'
import HorizontalBarChart from '@/components/charts/HorizontalBarChart'
import HeatmapTable from '@/components/charts/HeatmapTable'
import DumbbellChart from '@/components/charts/DumbbellChart'
import StackedHorizontalBarChart from '@/components/charts/StackedHorizontalBarChart'
import SummaryStatsTable from '@/components/charts/SummaryStatsTable'

// ── Canvas extraction detection ─────────────────────────────────────────────

/**
 * Tests whether the browser allows canvas data extraction.
 * Hardened browsers (e.g. LibreWolf with privacy.resistFingerprinting)
 * block canvas.toDataURL() and getImageData(), which every DOM-to-image
 * library depends on. This draws a known red pixel and reads it back.
 */
function isCanvasExportBlocked(): boolean {
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const ctx = c.getContext('2d')
    if (!ctx) return true
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return d[0] !== 255 || d[1] !== 0 || d[2] !== 0
  } catch {
    return true
  }
}

// ── Single-chart export ──────────────────────────────────────────────────────

const EXPORT_FILTER = (node: Node) => {
  if (node instanceof HTMLElement) {
    return !node.dataset?.excludeExport
  }
  return true
}

/**
 * #385/#386: before capturing a chart figure, expand any ScrollableTable inside
 * it to its full content size so the export isn't clipped to the visible box.
 * Releases the vertical `max-height` clamp (#385) AND the horizontal width clamp
 * (#386) — the latter also requires widening the capture root, otherwise the
 * figure stays at panel width and html-to-image clips the overflowing table.
 * Explicit px widths (from scrollWidth) avoid max-content circularity with
 * `w-full` tables. No-op when the figure has no ScrollableTable (e.g. bar/SVG
 * charts), so those captures are untouched. Returns a restore fn for `finally`.
 */
function expandForCapture(root: HTMLElement): () => void {
  const tables = Array.from(root.querySelectorAll<HTMLElement>('[data-scrollable-table]'))
  if (tables.length === 0) return () => {}
  const saved = tables.map((el) => ({
    el,
    scrollWidth: el.scrollWidth,
    maxHeight: el.style.maxHeight,
    overflow: el.style.overflow,
    width: el.style.width,
  }))
  for (const t of saved) {
    t.el.style.maxHeight = 'none'
    t.el.style.overflow = 'visible'
    t.el.style.width = `${t.scrollWidth}px`
  }
  // Read root.scrollWidth AFTER expanding the tables (forces reflow) so it
  // reflects the full content width, then pin the root to it.
  const savedRoot = { width: root.style.width, maxWidth: root.style.maxWidth }
  root.style.maxWidth = 'none'
  root.style.width = `${root.scrollWidth}px`
  return () => {
    for (const t of saved) {
      t.el.style.maxHeight = t.maxHeight
      t.el.style.overflow = t.overflow
      t.el.style.width = t.width
    }
    root.style.width = savedRoot.width
    root.style.maxWidth = savedRoot.maxWidth
  }
}

export async function exportAsSvg(element: HTMLElement, filename: string) {
  const restore = expandForCapture(element)
  try {
    const { toSvg } = await import('html-to-image')
    const dataUrl = await toSvg(element, { filter: EXPORT_FILTER, skipFonts: true })
    const link = document.createElement('a')
    link.download = `${filename}.svg`
    link.href = dataUrl
    link.click()
  } catch (err) {
    console.error('SVG export failed:', err)
    throw err
  } finally {
    restore()
  }
}

export async function exportAsPng(element: HTMLElement, filename: string, pixelRatio = 2) {
  if (isCanvasExportBlocked()) {
    throw new Error(
      'PNG export is blocked by your browser\'s privacy settings. ' +
      'Try SVG export, or allow canvas data extraction for this site.'
    )
  }

  const restore = expandForCapture(element)
  try {
    const { toPng } = await import('html-to-image')
    const dataUrl = await toPng(element, {
      pixelRatio,
      filter: EXPORT_FILTER,
      skipFonts: true,
    })
    const link = document.createElement('a')
    link.download = `${filename}.png`
    link.href = dataUrl
    link.click()
  } catch (err) {
    console.error('PNG export failed:', err)
    throw err
  } finally {
    restore()
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
}

// ── Chart grouping for batch export ──────────────────────────────────────────

interface ChartGroup {
  metrics: MetricDefinitionResponse[]
  chartType: 'horizontal_bar' | 'heatmap' | 'dumbbell' | 'stacked_bar' | 'table' | 'vertical_bar' | 'line' | 'frequency_table' | 'cross_tab'
  title: string
  filenameBase: string
  isFrequencyBar: boolean
}

export function groupMetricsForBatchExport(
  metrics: MetricDefinitionResponse[],
  columnLookup: Map<number, string>,
  domainLookup: Map<number, string>,
): ChartGroup[] {
  const groups: ChartGroup[] = []

  // Partition metrics
  const freqDists = metrics.filter(m => m.metric_type === 'frequency_distribution' && !m.grouping_column_id)
  const ungroupedScalars = metrics.filter(
    m => (m.metric_type === 'proportion' || m.metric_type === 'mean' || m.metric_type === 'domain_aggregate')
      && !m.grouping_column_id
  )
  const grouped = metrics.filter(m => m.grouping_column_id != null)

  // Frequency distributions: 1 → bar, 2+ → heatmap
  if (freqDists.length === 1) {
    const m = freqDists[0]
    const domainName = domainLookup.get(m.input_source_id)
    groups.push({
      metrics: [m],
      chartType: 'horizontal_bar',
      title: m.name,
      filenameBase: sanitizeFilename(domainName ? `${domainName}_${m.name}` : m.name),
      isFrequencyBar: true,
    })
  } else if (freqDists.length >= 2) {
    const domainNames = new Set(freqDists.map(m => domainLookup.get(m.input_source_id)).filter(Boolean))
    const domainPart = domainNames.size === 1 ? [...domainNames][0] : undefined
    groups.push({
      metrics: freqDists,
      chartType: 'heatmap',
      title: 'Response Distributions',
      filenameBase: sanitizeFilename(domainPart ? `${domainPart}_Response_Distributions` : 'Response_Distributions'),
      isFrequencyBar: false,
    })
  }

  // Ungrouped scalars → one combined bar chart
  if (ungroupedScalars.length > 0) {
    const types = new Set(ungroupedScalars.map(m => m.metric_type))
    let title: string
    if (types.size === 1) {
      if (types.has('proportion')) title = 'Proportions — % Meeting Threshold'
      else if (types.has('mean')) title = 'Means'
      else title = 'Domain Aggregates'
    } else {
      title = 'Metric Comparison'
    }

    const domainNames = new Set(
      ungroupedScalars.map(m => domainLookup.get(m.input_source_id)).filter(Boolean),
    )
    const domainPart = domainNames.size === 1 ? [...domainNames][0] : undefined

    groups.push({
      metrics: ungroupedScalars,
      chartType: 'horizontal_bar',
      title,
      filenameBase: sanitizeFilename(domainPart ? `${domainPart}_${title}` : title),
      isFrequencyBar: false,
    })
  }

  // Grouped metrics → one dumbbell per grouping_column_id
  const groupedByCol = new Map<number, MetricDefinitionResponse[]>()
  for (const m of grouped) {
    const colId = m.grouping_column_id!
    const list = groupedByCol.get(colId) || []
    list.push(m)
    groupedByCol.set(colId, list)
  }

  for (const [colId, colMetrics] of groupedByCol) {
    const colLabel = columnLookup.get(colId) || `Column ${colId}`
    const domainNames = new Set(colMetrics.map(m => domainLookup.get(m.input_source_id)).filter(Boolean))
    const domainPart = domainNames.size === 1 ? [...domainNames][0] : undefined

    groups.push({
      metrics: colMetrics,
      chartType: 'dumbbell',
      title: `Group Comparison — ${colLabel}`,
      filenameBase: sanitizeFilename(
        domainPart
          ? `${domainPart}_Group_Comparison_${colLabel}`
          : `Group_Comparison_${colLabel}`,
      ),
      isFrequencyBar: false,
    })
  }

  return groups
}

// ── Batch export as ZIP ──────────────────────────────────────────────────────

function waitForPaint(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      // Allow extra time for recharts SVG layout and reflow
      setTimeout(resolve, 150)
    })
  })
}

export async function exportAllChartsAsZip(
  metrics: MetricDefinitionResponse[],
  colorMap: Map<number, string>,
  projectName: string,
  columnLookup: Map<number, string>,
  domainLookup: Map<number, string>,
  onProgress?: (current: number, total: number) => void,
): Promise<{ exported: number; failed: string[] }> {
  const groups = groupMetricsForBatchExport(metrics, columnLookup, domainLookup)
  const [{ toPng }, { default: JSZip }] = await Promise.all([
    import('html-to-image'),
    import('jszip'),
  ])
  const zip = new JSZip()
  const failed: string[] = []
  let exported = 0

  // Manifest CSV
  const manifestRows: string[] = [
    `# Project: ${projectName}, Exported: ${new Date().toISOString()}`,
    'filename,metric_names,metric_type,chart_type,stale,computed_at',
  ]

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    const seqNum = String(i + 1).padStart(2, '0')
    const filename = `${seqNum}_${group.filenameBase}.png`

    onProgress?.(i + 1, groups.length)

    let container: HTMLDivElement | null = null
    let root: ReturnType<typeof createRoot> | null = null
    try {
      let chartElement: React.ReactElement

      if (group.chartType === 'horizontal_bar' && group.isFrequencyBar) {
        const barData = shapeFrequencyBars(group.metrics[0])
        const height = Math.max(300, barData.length * 36)
        chartElement = (
          <HorizontalBarChart
            data={barData}
            fixedDimensions={{ width: 760, height }}
            isAnimationActive={false}
          />
        )
      } else if (group.chartType === 'horizontal_bar') {
        const barData = shapeScalarBars(group.metrics, colorMap)
        const height = Math.max(300, barData.length * 36)
        chartElement = (
          <HorizontalBarChart
            data={barData}
            fixedDimensions={{ width: 760, height }}
            isAnimationActive={false}
          />
        )
      } else if (group.chartType === 'stacked_bar') {
        const stackedData = shapeStackedBars(group.metrics)
        chartElement = <StackedHorizontalBarChart data={stackedData} mode="100%" />
      } else if (group.chartType === 'heatmap') {
        const heatmapData = shapeHeatmapRows(group.metrics)
        chartElement = <HeatmapTable data={heatmapData} />
      } else if (group.chartType === 'table') {
        const statsData = shapeSummaryStats(group.metrics)
        chartElement = <SummaryStatsTable data={statsData} />
      } else {
        const dumbbellData = shapeDumbbellRows(group.metrics)
        chartElement = <DumbbellChart data={dumbbellData} />
      }

      // Create render container — kept in-viewport but behind everything so
      // the browser fully computes layout (off-screen left:-9999px causes
      // zero-width content in html-to-image captures)
      container = document.createElement('div')
      container.style.cssText =
        'position:fixed;left:0;top:0;width:800px;background:white;' +
        'z-index:-9999;pointer-events:none;'
      document.body.appendChild(container)

      root = createRoot(container)
      flushSync(() => {
        root!.render(
          <div style={{ padding: 20, background: 'white' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1a1a', marginBottom: 4 }}>
              {group.title}
            </div>
            <div style={{ fontSize: 13, fontWeight: 400, color: '#6b7280', marginBottom: 12 }}>
              {group.metrics.map(m => m.name).join(', ')}
            </div>
            {chartElement}
          </div>,
        )
      })

      await waitForPaint()

      const restore = expandForCapture(container)
      let dataUrl: string
      try {
        dataUrl = await toPng(container, {
          pixelRatio: 2,
          filter: EXPORT_FILTER,
          skipFonts: true,
        })
      } finally {
        restore()
      }
      zip.file(filename, dataUrl.split(',')[1], { base64: true })
      exported++

      // Manifest entry
      const metricNames = group.metrics.map(m => m.name).join('; ')
      const metricTypes = [...new Set(group.metrics.map(m => m.metric_type))].join('; ')
      const anyStale = group.metrics.some(m => m.stale)
      const latestComputed = group.metrics
        .flatMap(m => m.results)
        .map(r => r.computed_at)
        .sort()
        .pop() || ''
      manifestRows.push(
        `"${filename}","${metricNames}","${metricTypes}","${group.chartType}",${anyStale},"${latestComputed}"`,
      )
    } catch (err) {
      console.error(`Failed to export chart: ${filename}`, err)
      failed.push(group.title)
    } finally {
      if (root) root.unmount()
      if (container && container.parentNode) document.body.removeChild(container)
    }
  }

  // Add manifest
  zip.file('manifest.csv', manifestRows.join('\n'))

  // Generate and download
  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${sanitizeFilename(projectName)}_charts.zip`
  link.click()
  URL.revokeObjectURL(url)

  return { exported, failed }
}
