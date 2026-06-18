import { useRef, useCallback } from 'react'
import {
  Grid3X3,
  Grid2X2,
  BarChart3,
  Layers,
  BarChart,
  GitCompareArrows,
  Table,
  TrendingUp,
  ListChecks,
} from 'lucide-react'
import type { ChartType, MetricType } from '@/lib/chart-data'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface ChartTypeToolbarProps {
  available: ChartType[]
  active: ChartType
  onSelect: (type: ChartType) => void
  requiresMetricTypeChange: Partial<Record<ChartType, MetricType[] | null>>
  hasGrouping: boolean
  disabledReasons?: Partial<Record<ChartType, string>>
}

const CHART_TYPE_META: {
  type: ChartType
  label: string
  icon: typeof Grid3X3
}[] = [
  { type: 'heatmap', label: 'Heatmap', icon: Grid3X3 },
  { type: 'horizontal_bar', label: 'Horizontal Bar', icon: BarChart3 },
  { type: 'stacked_bar', label: 'Stacked Bar', icon: Layers },
  { type: 'vertical_bar', label: 'Vertical Bar', icon: BarChart },
  { type: 'dumbbell', label: 'Dumbbell', icon: GitCompareArrows },
  { type: 'table', label: 'Summary Table', icon: Table },
  { type: 'line', label: 'Line Chart', icon: TrendingUp },
  { type: 'frequency_table', label: 'Frequency Table', icon: ListChecks },
  { type: 'cross_tab', label: 'Cross-Tab', icon: Grid2X2 },
]

export default function ChartTypeToolbar({
  available,
  active,
  onSelect,
  requiresMetricTypeChange,
  hasGrouping,
  disabledReasons = {},
}: ChartTypeToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const buttons = toolbarRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
    if (!buttons || buttons.length === 0) return

    const current = document.activeElement as HTMLButtonElement
    const idx = Array.from(buttons).indexOf(current)
    if (idx < 0) return

    if (e.key === 'ArrowRight') {
      e.preventDefault()
      buttons[(idx + 1) % buttons.length].focus()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      buttons[(idx - 1 + buttons.length) % buttons.length].focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      buttons[0].focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      buttons[buttons.length - 1].focus()
    }
  }, [])

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Chart type"
      className="flex items-center gap-0.5 p-1 bg-mm-bg rounded-lg border flex-wrap"
      onKeyDown={handleKeyDown}
    >
      {CHART_TYPE_META.map(({ type, label, icon: Icon }) => {
        const isActive = type === active
        const isAvailable = available.includes(type)
        const needsSwitch = Array.isArray(requiresMetricTypeChange[type])
        const isDisabledDumbbell = type === 'dumbbell' && !hasGrouping
        const scaleDisabledReason = disabledReasons[type]

        const disabled = isDisabledDumbbell || !!scaleDisabledReason
        const title = isDisabledDumbbell
          ? 'Add a group-by variable to enable dumbbell chart'
          : needsSwitch && !isActive
          ? `${label} (will switch metric type)`
          : label

        const btnContent = (
          <>
            <Icon className="w-3.5 h-3.5" />
            {label}
            {needsSwitch && !isActive && !disabled && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
            )}
          </>
        )

        const btnClassName = [
          'relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md transition-colors',
          isActive
            ? 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 font-medium'
            : disabled
            ? 'text-mm-text-faint cursor-not-allowed'
            : isAvailable
            ? 'text-mm-text-muted hover:bg-mm-surface-hover hover:text-mm-text-secondary'
            : 'text-mm-text-faint hover:bg-mm-surface-hover',
        ].join(' ')

        // Scale-disabled buttons get a Tooltip explaining why
        if (scaleDisabledReason) {
          return (
            <Tooltip key={type}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={btnClassName}
                  disabled
                  aria-pressed={false}
                  aria-disabled
                  tabIndex={-1}
                >
                  {btnContent}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {scaleDisabledReason}
              </TooltipContent>
            </Tooltip>
          )
        }

        return (
          <button
            key={type}
            type="button"
            className={btnClassName}
            onClick={() => !disabled && onSelect(type)}
            disabled={disabled}
            title={title}
            aria-pressed={isActive}
            aria-disabled={disabled}
            tabIndex={isActive ? 0 : -1}
          >
            {btnContent}
          </button>
        )
      })}
    </div>
  )
}
