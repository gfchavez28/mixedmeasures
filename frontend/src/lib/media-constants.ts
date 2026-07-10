/**
 * Shared media (audio/video) upload constants + validation — the SINGLE source
 * for the size cap, accepted formats, and the human-readable format label.
 *
 * Mirror of the backend `routers/media.py` (MAX_MEDIA_SIZE + accepted formats).
 * Consumed by every client-side media-attach surface: the conversation-import
 * wizard's recording slot, the conversations-list "Attach Recording" context
 * menu, and the coding-workbench toolbar. New media-attach surfaces MUST import
 * from here — never re-inline the size/extension check (that duplication was the
 * three-mirror drift the media-format-seam bullet in CLAUDE.md warned about).
 */

import { ApiError } from './api/client'

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
 * `accept` attribute for a media `<input type="file">` — MIME types AND dotted
 * extensions (different OS file pickers match one or the other).
 */
export const MEDIA_ACCEPT =
  'audio/mpeg,audio/wav,audio/x-m4a,video/mp4,video/quicktime,video/webm,.mp3,.m4a,.wav,.mp4,.mov,.webm'

/** Human-readable format list for error messages. */
export const MEDIA_FORMAT_LABEL = 'MP3, M4A, WAV audio; MP4, MOV, WebM video'

export type MediaValidationResult = { ok: true } | { ok: false; error: string }

/**
 * Preliminary client-side validation for a media file (size + extension).
 * Returns `{ ok: true }` or `{ ok: false, error }` with a ready-to-toast
 * message. The backend is the authority on format (content sniff); this only
 * catches obvious mistakes before a potentially large upload starts.
 */
export function validateMediaFile(file: File): MediaValidationResult {
  if (file.size > MAX_MEDIA_SIZE) {
    return { ok: false, error: 'Recording exceeds 4GB limit' }
  }
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (!ext || !(MEDIA_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, error: `Accepted formats: ${MEDIA_FORMAT_LABEL}` }
  }
  return { ok: true }
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
      case 413: return detail || 'This recording is over the 4 GB limit.'
      case 507: return detail || 'Not enough disk space to save the recording.'
      case 400: return detail || 'This file isn’t a supported recording format.'
      case 401: return 'Your session expired — reload the page and try attaching the recording again.'
      case 404: return 'That conversation no longer exists.'
      default: return detail || FALLBACK
    }
  }
  // Non-ApiError: a timeout abort or a network reject (a raw browser string).
  const name = (err as { name?: string } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'The upload timed out. Check your connection and try again, or attach the recording later from the workbench.'
  }
  const msg = err instanceof Error ? err.message : ''
  if (/network|failed to fetch|load failed/i.test(msg)) {
    return 'The upload was interrupted (connection lost). Try again, or attach the recording later from the workbench.'
  }
  return FALLBACK
}
