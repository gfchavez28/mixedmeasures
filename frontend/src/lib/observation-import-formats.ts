/**
 * Upload-format gates for the Observations import.
 *
 * An observation import touches TWO different file families, and they are not
 * interchangeable:
 *
 *   - the RECORDING (the material itself);
 *   - an optional CUE FILE (VTT/SRT) whose in/out points seed the first clips.
 */

/**
 * The recording gate is RE-EXPORTED, never re-declared. A second copy of the
 * media extension list is exactly the drift #552 was filed for, and the list is
 * already pinned to the backend by an agreement test
 * (`test_media.py::TestMediaConstantsMirror` <-> `media-constants.test.ts`).
 */
export {
  MEDIA_ACCEPT as OBSERVATION_MEDIA_ACCEPT,
  MEDIA_FORMAT_LABEL as OBSERVATION_MEDIA_FORMAT_LABEL,
  isSupportedMediaFile as isSupportedObservationMedia,
} from './media-constants'

/**
 * The cue gate is genuinely its OWN gate, not the transcript gate.
 *
 * It is NARROWER: the conversation importer accepts `.csv` as a transcript, but
 * a CSV carries no timed in/out points, so there is nothing to cut clips from —
 * accepting one here would let a user pick a file that can only fail. VTT/SRT
 * only.
 */
export const CUE_FILE_ACCEPT = '.vtt,.srt'

export const CUE_FILE_FORMAT_LABEL = 'WebVTT (.vtt) or SubRip (.srt)'

const CUE_EXTENSIONS = ['vtt', 'srt'] as const

/** True when a picked/dropped file can seed clips as a cue list. */
export function isSupportedCueFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  return !!ext && (CUE_EXTENSIONS as readonly string[]).includes(ext)
}
