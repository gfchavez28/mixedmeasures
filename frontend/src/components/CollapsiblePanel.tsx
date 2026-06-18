import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CollapsiblePanelProps {
  title: string
  isCollapsed: boolean
  onToggle: () => void
  children: React.ReactNode
  className?: string
  headerExtra?: React.ReactNode
}

export default function CollapsiblePanel({
  title,
  isCollapsed,
  onToggle,
  children,
  className,
  headerExtra,
}: CollapsiblePanelProps) {
  return (
    <div className={cn('flex flex-col min-h-[36px]', className)}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-mm-bg border-b">
        <button
          onClick={onToggle}
          aria-expanded={!isCollapsed}
          className="flex items-center gap-2 hover:bg-mm-surface-hover transition-colors text-left rounded px-1 -ml-1"
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 text-mm-text-muted" />
          ) : (
            <ChevronDown className="w-4 h-4 text-mm-text-muted" />
          )}
          <span className="text-sm font-medium text-mm-text">{title}</span>
        </button>
        {headerExtra}
      </div>
      {!isCollapsed && (
        <div className="flex-1 overflow-hidden">
          {children}
        </div>
      )}
    </div>
  )
}
