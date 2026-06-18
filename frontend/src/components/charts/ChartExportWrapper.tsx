import { useRef, useCallback, useState } from 'react'
import { Download, Image, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { exportAsSvg, exportAsPng } from '@/lib/chart-export'
import { mergeFormatting, type ChartFormatting } from '@/lib/chart-data'

interface ChartExportWrapperProps {
  title?: string
  subtitle?: string
  footnote?: string
  supportsSvg?: boolean
  filename?: string
  chartN?: number
  showChartN?: boolean
  hasVaryingN?: boolean
  autoFootnote?: string
  formatting?: Partial<ChartFormatting>
  fillHeight?: boolean
  children: React.ReactNode
}

export default function ChartExportWrapper({
  title,
  subtitle,
  footnote,
  supportsSvg = true,
  filename = 'chart',
  chartN,
  showChartN,
  hasVaryingN,
  autoFootnote,
  fillHeight = false,
  formatting: fmtProp,
  children,
}: ChartExportWrapperProps) {
  const fmt = mergeFormatting(fmtProp)
  const chartRef = useRef<HTMLDivElement>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const handleSvgExport = useCallback(() => {
    if (chartRef.current) exportAsSvg(chartRef.current, filename)
  }, [filename])

  const handlePngExport = useCallback(async () => {
    setExportError(null)
    try {
      if (chartRef.current) await exportAsPng(chartRef.current, filename)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'PNG export failed')
    }
  }, [filename])

  return (
    <div className={`flex flex-col${fillHeight ? ' h-full' : ''}`}>
      {/* Toolbar — excluded from export */}
      <div className="flex items-center justify-end mb-2" data-exclude-export="">
        <div className="flex items-center gap-1">
          {supportsSvg && (
            <Button variant="ghost" size="sm" onClick={handleSvgExport} className="h-7 px-2 text-xs">
              <Download className="w-3 h-3 mr-1" />
              SVG
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={handlePngExport} className="h-7 px-2 text-xs">
            <Image className="w-3 h-3 mr-1" />
            PNG
          </Button>
        </div>
      </div>

      {/* Canvas-blocked warning banner */}
      {exportError && (
        <div className="mb-2 p-3 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 rounded text-sm flex items-start gap-2">
          <CircleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{exportError}</span>
        </div>
      )}

      {/* Chart container — this is what gets exported */}
      <div
        ref={chartRef}
        role="figure"
        aria-label={
          (title || 'Chart') + (showChartN && chartN != null ? `, N = ${chartN}` : '')
        }
        className={`bg-mm-surface p-4${fillHeight ? ' flex-1 min-h-0' : ''}`}
      >
        {title && (
          <div className="mb-1 text-mm-text" style={{ fontSize: fmt.titleFontSize, fontWeight: 700 }}>
            {title}
          </div>
        )}
        {subtitle && (
          <div className="text-mm-text-secondary" style={{ fontSize: fmt.titleFontSize - 3, fontWeight: 400 }}>
            {subtitle}
          </div>
        )}
        {showChartN && chartN != null && (
          <div className="text-mm-text-secondary" style={{ fontSize: fmt.labelFontSize, fontWeight: 500 }}>
            N = {chartN}{hasVaryingN ? ' *' : ''}
          </div>
        )}
        {(subtitle || (showChartN && chartN != null)) && <div className="mb-3" />}
        {children}
        {footnote && (
          <div className="mt-3 text-mm-text-muted" style={{ fontSize: 11, fontStyle: 'italic' }}>
            {footnote}
          </div>
        )}
        {autoFootnote && (
          <div className="mt-1 text-mm-text-faint" style={{ fontSize: 11, fontStyle: 'italic' }}>
            {autoFootnote}
          </div>
        )}
      </div>
    </div>
  )
}
