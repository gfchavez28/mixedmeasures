/**
 * The per-file upload limit for IMPORTED files — the one client-side home (#1007).
 *
 * Mirrors backend `routers/helpers.py::MAX_UPLOAD_SIZE`, which
 * `read_upload_with_limit` applies to every dataset (new and append), conversation
 * transcript, document, observation cue file and coding-import upload.
 * `test_upload_limit_mirror.py` reads this file and fails if the two disagree.
 *
 * 🔴 **PER FILE, never per project.** The server reads one `UploadFile` per request
 * and every multi-file wizard sends each file as its own request, so six 10 MB
 * files are six uploads each well inside the limit. Say "each" in any copy.
 *
 * ⚠️ **Recordings are NOT this limit** — they stream to disk under
 * `media-constants.ts::MAX_MEDIA_SIZE` (4 GB). `.mmproject` and `.mmcodebook`
 * have limits of their own as well.
 *
 * Why this exists: until #1007 the limit was declared in `dataset-import-formats.ts`
 * and read only to size a timeout and word an error, so every import page accepted
 * a 1 GB file, quoted a 52-minute estimate for it, and was refused only after Next.
 */
import { formatBytes } from './format'

export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024

/** "50 MB" — derived, so the note and the refusal cannot drift from the number. */
export const MAX_IMPORT_FILE_LABEL = `${MAX_IMPORT_FILE_BYTES / (1024 * 1024)} MB`

/** Split a selection into the files the server will accept and the ones it will refuse. */
export function partitionBySizeLimit<T extends { size: number }>(
  files: T[],
  maxBytes: number = MAX_IMPORT_FILE_BYTES,
): { accepted: T[]; refused: T[] } {
  const accepted: T[] = []
  const refused: T[] = []
  for (const f of files) (f.size > maxBytes ? refused : accepted).push(f)
  return { accepted, refused }
}

/**
 * 500 MB — the `.mmproject` limit a merge meets, mirroring backend
 * `services/project_portability.py::MAX_UPLOAD_SIZE` (`test_upload_limit_mirror.py`
 * reads both). Separate from the 50 MB import limit on purpose: a project file
 * carries its recordings.
 */
export const MAX_PROJECT_FILE_BYTES = 500 * 1024 * 1024

/** A limit as the pages state it (`50 MB`, `500 MB`) — one spelling for the note and the refusal. */
export const fileLimitLabel = (maxBytes: number) => `${maxBytes / (1024 * 1024)} MB`
const labelFor = fileLimitLabel

/**
 * The sentence for files turned away at selection. It names each file and its size,
 * because "a file was too large" leaves the researcher to work out which one.
 */
export function oversizeFilesMessage(
  refused: { name: string; size: number }[],
  maxBytes: number = MAX_IMPORT_FILE_BYTES,
): string {
  if (refused.length === 0) return ''
  const named = refused.map(f => `“${f.name}” (${formatBytes(f.size)})`).join(', ')
  const verb = refused.length === 1 ? 'was' : 'were'
  return `${named} ${verb} not added. Mixed Measures can only import files of ${labelFor(maxBytes)} or smaller.`
}

/**
 * The ONE check every import wizard runs on the files it is handed — picked,
 * dropped, or passed on from a list page (#1012, 2026-09-23).
 *
 * Before it, a file of the wrong type met four behaviours across seven wizards:
 * three ignored it in silence, Append sent it to the server and reported an
 * ENCODING problem, Merge said "could not be read", two toasted. Both refusals
 * are now decided here, before anything is uploaded, and said in one sentence that
 * names each file and why — the page decides only WHERE the sentence appears.
 *
 * ⚠️ Type is checked before size: a 900 MB video dropped on a dataset page is the
 * wrong kind of file, and "too large" would send the researcher to trim it.
 */
export function checkImportFiles<T extends { name: string; size: number }>(
  files: T[],
  opts: {
    isSupported: (name: string) => boolean
    /** "CSV, Excel (.xlsx), or SPSS (.sav)" — the family's own `*_FORMAT_LABEL`. */
    formatLabel: string
    /** What this page imports, for the sentence: "dataset", "transcript", "document". */
    noun: string
    maxBytes?: number
  },
): { accepted: T[]; message: string } {
  const wrongType = files.filter(f => !opts.isSupported(f.name))
  const { accepted, refused: oversize } = partitionBySizeLimit(
    files.filter(f => opts.isSupported(f.name)),
    opts.maxBytes,
  )
  const parts: string[] = []
  if (wrongType.length > 0) {
    const named = wrongType.map(f => `“${f.name}”`).join(', ')
    const isAre = wrongType.length === 1 ? 'is not a' : 'are not'
    const noun = wrongType.length === 1 ? `${opts.noun} file` : `${opts.noun} files`
    parts.push(`${named} ${isAre} ${noun}. This page imports ${opts.formatLabel}.`)
  }
  if (oversize.length > 0) parts.push(oversizeFilesMessage(oversize, opts.maxBytes))
  return { accepted, message: parts.join(' ') }
}
