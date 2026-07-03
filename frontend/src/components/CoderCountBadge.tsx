import { Users } from 'lucide-react'
import { useCoderCoverage } from '@/hooks/useCoderCoverage'

/**
 * Track J · Group A (#3) — "N coders" for the current source, shown beside the
 * blind-mode pill. Derived from CODINGS (not the instance-global roster — the #444
 * trap), so it answers "who actually coded THIS conversation/document/dataset."
 * Includes archived coders, labeled "(archived)" in the tooltip.
 *
 * Renders nothing unless > 1 coder has coded the source (a solo "1 coder" is noise).
 * Pass exactly one source selector.
 */
interface CoderCountBadgeProps {
  projectId: number
  conversationId?: number
  documentId?: number
  textColumnIds?: number[]
  /** Gate on multiCoder — never render in single-coder instances. */
  enabled?: boolean
  className?: string
}

export default function CoderCountBadge({
  projectId,
  conversationId,
  documentId,
  textColumnIds,
  enabled = true,
  className = '',
}: CoderCountBadgeProps) {
  const { coders, count } = useCoderCoverage(
    projectId,
    { conversationId, documentId, textColumnIds },
    { enabled },
  )

  if (count <= 1) return null

  const names = coders.map(c => (c.archived ? `${c.username} (archived)` : c.username))
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs text-mm-text-muted ${className}`}
      title={`${count} coders on this source: ${names.join(', ')}`}
    >
      <Users className="w-3 h-3 flex-none" aria-hidden="true" />
      {count} coders
    </span>
  )
}
