/**
 * Shared media (audio/video) upload constants + validation — the SINGLE source
 * for the size cap, accepted formats, and the human-readable format label.
 *
 * Mirror of the backend `routers/media.py` (MAX_MEDIA_SIZE + accepted formats).
 * Consumed by every client-side media-attach surface: the conversation-import
 * wizard's recording slot, the observation import's recording, the
 * conversations-list "Attach Recording" context menu, and the coding-workbench
 * toolbar (`upload-limits.test.ts` counts them). New media-attach surfaces MUST import
 * from here — never re-inline the size/extension check (that duplication was the
 * three-mirror drift the media-format-seam bullet in the internal design notes warned about).
 */

import { ApiError } from './api/client'
import { isRequestTimeout } from './api/error-utils'
import { checkImportFiles, fileLimitLabel } from './upload-limits'

/**
 * 4 GB — mirrors backend `MAX_MEDIA_SIZE` (routers/media.py). The streaming
 * upload path is bounded-memory, so the cap is policy. Update both together.
 */
export const MAX_MEDIA_SIZE = 4 * 1024 * 1024 * 1024

/**
 * Accepted upload extensions (lowercase, no dot). Audio: mp3/m4a/wav; video:
 * mp4/mov/webm. The backend re-validates by content (sniff + moov-walk); this
 * is only a preliminary client gate.
 */
export const MEDIA_EXTENSIONS = ['mp3', 'm4a', 'wav', 'mp4', 'mov', 'webm'] as const

/**
 * Video extensions — mirrors backend `VIDEO_FORMATS` (models/conversation.py).
 * For pre-upload UI hints only (icon, "video"/"audio" caption); the backend's
 * content sniff is the authority on the stored `media_type`.
 */
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm'] as const

/** Preliminary is-this-a-video check by filename extension (see VIDEO_EXTENSIONS). */
export function isVideoFilename(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  return !!ext && (VIDEO_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * Is this filename one the backend can accept as a recording?
 *
 * The name-only sibling of `validateMediaFile` (which is size-aware and takes a
 * `File`). A drop filter has only names to work with, and it must not re-derive
 * the extension list — that divergence between a page's filter and its wizard's
 * accept IS #552.
 */
export function isSupportedMediaFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  return !!ext && (MEDIA_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * `accept` attribute for a media `<input type="file">` — MIME types AND dotted
 * extensions (different OS file pickers match one or the other).
 */
export const MEDIA_ACCEPT =
  'audio/mpeg,audio/wav,audio/x-m4a,video/mp4,video/quicktime,video/webm,.mp3,.m4a,.wav,.mp4,.mov,.webm'

/** Human-readable format list for error messages. */
export const MEDIA_FORMAT_LABEL = 'MP3, M4A, WAV audio; MP4, MOV, WebM video'

export type MediaValidationResult = { ok: true } | { ok: false; error: string }

/**
 * The recording arm of #1012's one file check: its formats, its noun, its 4 GB limit.
 *
 * #1263 (a) — and its OWN sentence for the formats. Four pickers share this, and two
 * of them ATTACH a recording (the Conversations list's and the workbench's *Attach
 * Recording*): "This page imports …" was false on a page that imports transcripts,
 * or nothing. Conversation Import's recording slot attaches too. What a recording can
 * be is true at all four doors, Observation Import's included.
 */
const RECORDING_CHECK = {
  isSupported: isSupportedMediaFile,
  formatLabel: MEDIA_FORMAT_LABEL,
  noun: 'recording',
  maxBytes: MAX_MEDIA_SIZE,
  formatSentence: `A recording can be ${MEDIA_FORMAT_LABEL}.`,
}

/**
 * Preliminary client-side validation for a media file (extension, then size).
 * Returns `{ ok: true }` or `{ ok: false, error }` with a ready-to-toast
 * message. The backend is the authority on format (content sniff); this only
 * catches obvious mistakes before a potentially large upload starts.
 *
 * #1161: it is `checkImportFiles` with the recording formats, so every recording
 * picker says what the import wizards say — the file named, TYPE before size (a
 * 5 GB `.zip` is not a recording, never "too large"), and the limit as "4 GB".
 * It used to check size first and name nothing, on all four pickers.
 */
export function validateMediaFile(file: File): MediaValidationResult {
  const { message } = checkImportFiles([file], RECORDING_CHECK)
  return message ? { ok: false, error: message } : { ok: true }
}

/**
 * A drop can hand a recording slot several files, and the slot holds ONE. Every
 * dropped file goes through the check; the first accepted is the one taken, and
 * the sentence says which were left out and why — a drop used to keep the first
 * file and drop the rest in silence (#1161).
 */
export function chooseOneRecording<T extends { name: string; size: number }>(
  files: T[],
): { file: T | null; message: string } {
  const { accepted, message } = checkImportFiles(files, RECORDING_CHECK)
  const [file = null, ...extra] = accepted
  const parts = message ? [message] : []
  if (extra.length > 0) {
    const named = extra.map(f => `“${f.name}”`).join(', ')
    parts.push(`Only one recording can be added — ${named} ${extra.length === 1 ? 'was' : 'were'} not added.`)
  }
  return { file, message: parts.join(' ') }
}

/**
 * Per-upload timeout (ms), scaled to file size. The API client's 30s default
 * would abort any multi-GB upload; a flat "disabled" (0) would let a silently
 * stalled connection hang forever. This gives a large file hours while a small
 * file that stalls still fails in ~2 minutes. Assumes a pessimistic ~1.5 Mbps
 * (190 KB/s) uplink floor; bounded to [2 min, the max-size estimate (~6.3 h)].
 * The upper bound is DERIVED from MAX_MEDIA_SIZE at the same floor rate so it
 * can never undercut an in-limit file's own estimate (#544 — a fixed 6 h cap
 * sat below the ~6.28 h a 4 GiB upload implies, aborting it ~95% complete).
 */
export function mediaUploadTimeoutMs(fileSizeBytes: number): number {
  const FLOOR_BYTES_PER_SEC = 190_000
  const estimateFor = (bytes: number) => Math.ceil(bytes / FLOOR_BYTES_PER_SEC) * 1000 + 30_000
  return Math.min(estimateFor(MAX_MEDIA_SIZE), Math.max(120_000, estimateFor(fileSizeBytes)))
}

/**
 * Turn a caught media-upload error into a plain, actionable message. The
 * backend sends clear `detail` for the media-specific cases (400 unsupported /
 * empty, 413 too large, 507 out of disk) — prefer it. Network rejects and
 * timeouts aren't `ApiError`s, so map them by shape. Used by every upload
 * surface (import wizard + the workbench/list attach sites) so the reason is
 * consistent instead of a generic "Failed to upload recording".
 */
export function describeMediaUploadError(err: unknown): string {
  const FALLBACK = 'The recording couldn’t be attached. Try again, or add it later from the workbench.'
  if (err instanceof ApiError) {
    const raw = typeof err.message === 'string' ? err.message : ''
    // ApiError.message falls back to "Request failed with status N" when the
    // response carried no `detail` — treat that placeholder as "no detail".
    const detail = /^request failed with status/i.test(raw) ? '' : raw
    switch (err.status) {
      case 413: return detail || `This recording is over the ${fileLimitLabel(MAX_MEDIA_SIZE)} limit.`
      case 507: return detail || 'Not enough disk space to save the recording.'
      case 400: return detail || 'This file isn’t a supported recording format.'
      case 401: return 'Your session expired — reload the page and try attaching the recording again.'
      case 404: return 'That conversation no longer exists.'
      default: return detail || FALLBACK
    }
  }
  // Non-ApiError: a timeout abort or a network reject (a raw browser string).
  if (isRequestTimeout(err)) {
    return 'The upload timed out. Check your connection and try again, or attach the recording later from the workbench.'
  }
  const msg = err instanceof Error ? err.message : ''
  if (/network|failed to fetch|load failed/i.test(msg)) {
    return 'The upload was interrupted (connection lost). Try again, or attach the recording later from the workbench.'
  }
  return FALLBACK
}
