import { MAX_IMPORT_FILE_BYTES, fileLimitLabel } from '@/lib/upload-limits'
import { MAX_MEDIA_SIZE } from '@/lib/media-constants'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * The one sentence every import page shows about how large a file may be (#1007).
 *
 * Shown BEFORE a file is chosen, because the refusal now happens at selection —
 * a limit learned only after picking a 1 GB file is the defect this replaced.
 * Two limits exist and a page states the ones it takes: the per-file import limit
 * (`noun`) and the recording limit (`recordings`), so nobody is told 50 MB about a
 * video that may be 4 GB. Always "each": the limit is per file, never per project.
 */
export default function UploadLimitNote({
  noun,
  recordings = false,
  maxBytes = MAX_IMPORT_FILE_BYTES,
  className,
}: {
  /** What the limit applies to on this page, e.g. "transcript files". Omit on a recording-only zone. */
  noun?: string
  recordings?: boolean
  /**
   * The page's own per-file limit, when it is not the 50 MB import limit — the merge
   * page's 500 MB `.mmproject` (#1010 f). Pass the CONSTANT the page's check uses,
   * never a literal, so the sentence and the refusal cannot disagree.
   */
  maxBytes?: number
  className?: string
}) {
  const recordingLimit = formatBytes(MAX_MEDIA_SIZE)
  const text = noun
    ? `Mixed Measures can import ${noun} of up to ${fileLimitLabel(maxBytes)} each`
      + (recordings ? `; recordings can be up to ${recordingLimit}.` : '.')
    : `Mixed Measures can import recordings of up to ${recordingLimit} each.`
  return <p className={cn('text-xs text-mm-text-muted', className)}>{text}</p>
}
