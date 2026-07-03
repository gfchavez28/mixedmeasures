import type { ReactNode } from 'react'
import { EyeOff } from 'lucide-react'
import BlindModeToggle from '@/components/BlindModeToggle'

/**
 * Inline "you're seeing your own coding only" banner for blind-scoped analysis
 * surfaces (#517). Single-sources the notice ContentByCode introduced (#454) so
 * every blind-scoped surface communicates its scope the same way — a blind coder
 * on Descriptives/Relationships otherwise sees an unexplained near-empty grid
 * while the source lists show all-coder coverage.
 */
export default function BlindScopeNotice({ blind, onReveal, className = '', children }: {
  blind: boolean
  onReveal?: () => void
  className?: string
  children: ReactNode
}) {
  if (!blind) return null
  return (
    <div className={`flex items-center gap-2 rounded-md border border-mm-surface-border bg-mm-surface-hover/50 px-3 py-2 text-xs text-mm-text-muted ${className}`}>
      <EyeOff className="w-3.5 h-3.5 flex-none" aria-hidden="true" />
      <span>{children}</span>
      {onReveal && (
        <span className="ml-auto flex-none">
          <BlindModeToggle blind={blind} onToggle={onReveal} surface="analysis" />
        </span>
      )}
    </div>
  )
}
