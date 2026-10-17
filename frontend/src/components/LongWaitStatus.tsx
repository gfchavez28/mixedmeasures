import type { ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useElapsedSeconds } from '@/hooks/useElapsedSeconds'
import { ANNOUNCE_EVERY_SECONDS, elapsedOnlyNote, stillWorkingMessage } from '@/lib/elapsed-progress'

/**
 * A long single request, said while it runs — with NO estimate (#796b's rule, one
 * component since #1054 review §4 #9).
 *
 * The restore (#1037) and the withdrawal had near-copies of this; the project
 * delete, the overwrite import and Link by column each held the app for seconds to
 * minutes with nothing but a button label. No estimate, deliberately: none of these
 * has been timed across real projects, and an uncalibrated "usually about N s" is a
 * claim about a corpus nobody looked at (`lib/elapsed-progress.ts`).
 *
 * MOUNT IT ONLY WHILE THE REQUEST RUNS — each mount starts its clock at zero.
 *
 * - The visible line says what is happening; the elapsed seconds tick beside it,
 *   hidden from readers (they would be re-read every half second).
 * - The spoken line is `firstAnnouncement`, then every `ANNOUNCE_EVERY_SECONDS`
 *   the shared "Still working — N seconds elapsed." Nothing in between.
 */
export default function LongWaitStatus({
  label,
  firstAnnouncement,
  children,
  compact = false,
}: {
  /** What is happening, ending in "…" — the visible heading of the wait. */
  label: string
  /** The first spoken line: what is happening and what to do meanwhile. */
  firstAnnouncement: string
  /** An explanation shown under the label (visible; the spoken lines carry it). */
  children?: ReactNode
  /** Smaller type, for a wait inside a dense dialog. */
  compact?: boolean
}) {
  const elapsed = useElapsedSeconds(true)
  const bucket = Math.floor(elapsed / ANNOUNCE_EVERY_SECONDS)
  // The spoken line changes only when a 30-second bucket is crossed.
  const spoken = bucket === 0
    ? firstAnnouncement
    : stillWorkingMessage(bucket * ANNOUNCE_EVERY_SECONDS, false)
  return (
    <div className={`rounded-md border border-mm-border-subtle bg-mm-bg p-3 ${
      compact ? 'space-y-1 text-xs' : 'space-y-1.5 text-sm'
    }`}>
      <p className="flex items-center gap-2 font-medium text-mm-text">
        <LoaderCircle className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} animate-spin`} aria-hidden="true" /> {label}
      </p>
      {children && <p className="text-mm-text-muted">{children}</p>}
      <p className={`${compact ? '' : 'text-xs '}text-mm-text-muted`} aria-hidden="true">{elapsedOnlyNote(elapsed)}</p>
      <p role="status" className="sr-only">{spoken}</p>
    </div>
  )
}
