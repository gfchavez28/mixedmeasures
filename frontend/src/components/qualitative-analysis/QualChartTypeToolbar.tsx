import { useRef, useCallback, useMemo, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { SELECTED_SEGMENT } from '@/lib/selection'
import {
  Grid3x3,
  BarChart3,
  Layers,
  Table2,
  TrendingUp,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { QualChartType } from '@/lib/qual-analysis-types'

interface QualChartTypeToolbarProps {
  chartType: QualChartType
  onChartTypeChange: (type: QualChartType) => void
  selectedCodeCount: number
  conversationSourceCount: number
  categoryMode?: boolean
}

interface ChartTypeButton {
  type: QualChartType
  icon: typeof Grid3x3
  label: string
  applicable: boolean
  disabledReason?: string
}

export default function QualChartTypeToolbar({
  chartType,
  onChartTypeChange,
  selectedCodeCount,
  conversationSourceCount,
  categoryMode,
}: QualChartTypeToolbarProps) {
  const buttons: ChartTypeButton[] = useMemo(() => [
    { type: 'heatmap', icon: Grid3x3, label: 'Heatmap', applicable: true },
    { type: 'bar', icon: BarChart3, label: 'Horizontal Bar', applicable: true },
    { type: 'stacked_bar', icon: Layers, label: 'Stacked Bar', applicable: selectedCodeCount >= 2 && !categoryMode, disabledReason: categoryMode ? 'Not available for categories' : 'Select 2+ codes' },
    { type: 'summary', icon: Table2, label: 'Summary Table', applicable: true },
    { type: 'saturation', icon: TrendingUp, label: 'Saturation', applicable: conversationSourceCount >= 2, disabledReason: 'Needs 2+ conversations' },
  ], [selectedCodeCount, conversationSourceCount, categoryMode])

  const toolbarRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
    const applicableButtons = buttons.filter(b => b.applicable)
    const idx = applicableButtons.findIndex(b => b.type === chartType)
    if (idx === -1) return
    e.preventDefault()
    let next: ChartTypeButton
    if (e.key === 'Home') {
      next = applicableButtons[0]
    } else if (e.key === 'End') {
      next = applicableButtons[applicableButtons.length - 1]
    } else {
      next = e.key === 'ArrowRight'
        ? applicableButtons[(idx + 1) % applicableButtons.length]
        : applicableButtons[(idx - 1 + applicableButtons.length) % applicableButtons.length]
    }
    onChartTypeChange(next.type)
    const target = toolbarRef.current?.querySelector(`[data-chart-type="${next.type}"]`) as HTMLButtonElement | null
    target?.focus()
  }, [chartType, onChartTypeChange, buttons])

  return (
    <div className="flex-shrink-0">
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Chart type"
        className="flex items-center gap-0.5 p-1 bg-mm-bg rounded-lg border flex-wrap"
        onKeyDown={handleKeyDown}
      >
        {buttons.map(btn => {
          const isActive = chartType === btn.type
          const Icon = btn.icon
          return btn.applicable ? (
            <button
              key={btn.type}
              data-chart-type={btn.type}
              aria-pressed={isActive}
              tabIndex={isActive ? 0 : -1}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md transition-colors ${
                isActive
                  ? SELECTED_SEGMENT
                  : 'text-mm-text-muted hover:bg-mm-surface-hover hover:text-mm-text-secondary'
              }`}
              onClick={() => onChartTypeChange(btn.type)}
            >
              <Icon className="w-3.5 h-3.5" />
              {btn.label}
            </button>
          ) : (
            <Tooltip key={btn.type}>
              <TooltipTrigger asChild>
                <button
                  data-chart-type={btn.type}
                  aria-pressed={false}
                  disabled
                  tabIndex={-1}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md text-mm-text-faint cursor-not-allowed"
                >
                  <Icon className="w-3.5 h-3.5" />
                  {btn.label}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {btn.disabledReason}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>

    </div>
  )
}
