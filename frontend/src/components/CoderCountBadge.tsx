import { Users } from 'lucide-react'
import { useCoderCoverage } from '@/hooks/useCoderCoverage'

/**
 * Track J · Group A (#3) — "N coders" for the current source, shown beside the
 * blind-mode pill. Derived from CODINGS (not the instance-global roster — the #444
 * trap), so it answers "who actually coded THIS conversation/document/observation/dataset."
 * Includes archived coders, labeled "(archived)" in the tooltip.
 *
 * Renders nothing unless > 1 coder has coded the source (a solo "1 coder" is noise).
 * Pass exactly one source selector.
 */
interface CoderCountBadgeProps {
  projectId: number
  conversationId?: number
  documentId?: number
  observationId?: number
  textColumnIds?: number[]
  /** Gate on multiCoder — never render in single-coder instances. */
  enabled?: boolean
  /**
   * 🔴 #1078 — `useBlindMode`'s `withholding`, never `blind`. While colleagues'
   * work is withheld their NAMES are too: the tooltip listed every coder on the
   * source beside the blind pill, and its `title` is the badge's accessible name,
   * so a screen reader read out exactly what blind coding withholds (multi-coder
   * rule 5). `withholding` rather than `blind` because it fails CLOSED while the
   * roster is unanswered (#964).
   *
   * REQUIRED, deliberately: every mount must decide. A defaulted flag is how the
   * four workbench mounts came to pass only `enabled` in the first place.
   */
  withholding: boolean
  className?: string
}

/**
 * What the badge's tooltip says. The COUNT stays while withholding — a number of
 * coders is not an identity, and hiding it would make the badge disagree with
 * itself on reveal; the sentence says why the names are missing, so its absence
 * reads as a rule and not as a fault.
 */
function coderCountTitle(
  coders: readonly { username: string; archived: boolean }[],
  count: number,
  withholding: boolean,
): string {
  if (withholding) {
    return `${count} coders on this source. Their names are hidden while colleagues' work is hidden.`
  }
  const names = coders.map(c => (c.archived ? `${c.username} (archived)` : c.username))
  return `${count} coders on this source: ${names.join(', ')}`
}

export default function CoderCountBadge({
  projectId,
  conversationId,
  documentId,
  observationId,
  textColumnIds,
  enabled = true,
  withholding,
  className = '',
}: CoderCountBadgeProps) {
  const { coders, count } = useCoderCoverage(
    projectId,
    { conversationId, documentId, observationId, textColumnIds },
    { enabled },
  )

  if (count <= 1) return null

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs text-mm-text-muted ${className}`}
      title={coderCountTitle(coders, count, withholding)}
    >
      <Users className="w-3 h-3 flex-none" aria-hidden="true" />
      {count} coders
    </span>
  )
}
