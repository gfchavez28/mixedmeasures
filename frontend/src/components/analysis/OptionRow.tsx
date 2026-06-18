import type { ElementType, ReactNode } from 'react'

interface OptionRowProps {
  icon: ElementType
  label: string
  children: ReactNode
  fullWidth?: boolean
}

export default function OptionRow({ icon: Icon, label, children, fullWidth }: OptionRowProps) {
  if (fullWidth) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs text-mm-text-secondary">
          <Icon className="w-3.5 h-3.5 text-mm-text-faint shrink-0" />
          {label}
        </div>
        {children}
      </div>
    )
  }
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span className="flex items-center gap-1.5 text-xs text-mm-text-secondary shrink-0">
        <Icon className="w-3.5 h-3.5 text-mm-text-faint" />
        {label}
      </span>
      <div className="flex-1 min-w-0 max-w-[180px]">{children}</div>
    </label>
  )
}
