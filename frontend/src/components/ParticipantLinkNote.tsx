import { Link } from 'react-router'
import { TriangleAlert } from 'lucide-react'
import type { ParticipantLinkReport } from '@/lib/api'

/**
 * #414: what participant linking did at import time. `compact` is the inline
 * per-dataset suffix for the multi-file list. `hadParticipants` (project had
 * participants BEFORE this import) drives the identity-pollution callout —
 * all-created/none-matched against an existing roster usually means the IDs
 * don't line up with the people already in the project.
 *
 * Moved out of `DatasetImport.tsx` when Append became its second user (#1010):
 * Append printed its own one-line version — "2 linked (2 new, 0 matched)", a zero
 * clause, no reasons for the rows left unlinked, and no warning when nothing
 * matched the people already in the project.
 */
export default function ParticipantLinkNote({
  report,
  projectId,
  hadParticipants,
  compact = false,
}: {
  report?: ParticipantLinkReport | null
  projectId?: string | number
  /** #963 — `undefined` = the participant list never answered, which is NOT
   *  the same as "the project had nobody". */
  hadParticipants?: boolean | undefined
  compact?: boolean
}) {
  if (!report) return null
  if (compact) {
    if (report.linked <= 0) return null
    return (
      <span className="text-mm-text-faint">
        {' · '}{report.linked.toLocaleString()} linked to participants
      </span>
    )
  }
  const skippedParts: string[] = []
  if (report.skipped_duplicate > 0) {
    const examples = report.duplicate_values.slice(0, 3).join(', ')
    skippedParts.push(
      `${report.skipped_duplicate} with a duplicated ID${examples ? ` (${examples})` : ''}`,
    )
  }
  if (report.skipped_missing > 0) skippedParts.push(`${report.skipped_missing} with a blank or N/A ID`)
  if (report.skipped_conflict > 0) {
    skippedParts.push(`${report.skipped_conflict} whose participant is already linked to another record`)
  }
  // #963 — `!== false`, not truthiness: `undefined` means the participant list
  // never answered, and suppressing the callout then is the unsafe direction.
  const pollution = hadParticipants !== false && report.created > 0 && report.matched === 0
  return (
    <div className="pt-1 space-y-1 text-xs text-mm-text-muted">
      <div>
        <strong className="text-mm-text">Participants:</strong>{' '}
        {report.linked === 1 ? '1 record linked' : `${report.linked.toLocaleString()} records linked`}
        {report.linked > 0 && (
          <>
            {' '}({report.created > 0 && `${report.created} new`}
            {report.created > 0 && report.matched > 0 && ', '}
            {report.matched > 0 && `${report.matched} matched to existing`})
          </>
        )}
      </div>
      {skippedParts.length > 0 && (
        <div>Not linked: {skippedParts.join(' · ')}. These records stay unlinked — you can link them by hand on the Participants page.</div>
      )}
      {pollution && (
        <div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
          <TriangleAlert className="w-3.5 h-3.5 flex-shrink-0 mt-px" aria-hidden="true" />
          <span>
            None of these IDs matched the participants already in this project, so{' '}
            {report.created === 1 ? 'a new participant was' : `${report.created} new participants were`} created.
            If these records belong to people already here, review and merge them on the{' '}
            <Link to={`/projects/${projectId}/participants`} className="underline">
              Participants page
            </Link>.
          </span>
        </div>
      )}
    </div>
  )
}
