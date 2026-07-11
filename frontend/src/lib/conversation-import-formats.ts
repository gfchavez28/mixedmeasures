/**
 * Conversation transcript upload formats — the single client-side source of truth.
 *
 * Mirror of the backend's transcript seam: CSV goes straight into the import
 * pipeline, and VTT/SRT (Zoom/Teams exports) convert to `Speaker,Text,Start,End`
 * CSV bytes via `services/subtitle_import.py::subtitles_to_csv_bytes` (#524).
 * A NEW transcript format is added at that seam AND here — nowhere else.
 *
 * This exists because the gates had ALREADY drifted (#552): the Conversations
 * list-page drop filter still tested `.endsWith('.csv')` while the wizard
 * accepted `.csv|.vtt|.srt`, so dropping a Zoom `.vtt` onto the list silently
 * no-op'd — the tool refused a format it had shipped support for. #540 swept
 * exactly this class on the DATASET gates and missed the conversation sibling;
 * `dataset-import-formats.ts` is the file this one mirrors.
 *
 * New transcript-upload surfaces MUST import from here.
 */

/** The `accept` attribute for any transcript file input. */
export const TRANSCRIPT_ACCEPT = '.csv,.vtt,.srt'

/** Human-readable format list for upload copy. Keep in step with TRANSCRIPT_ACCEPT. */
export const TRANSCRIPT_FORMAT_LABEL = 'CSV, or VTT/SRT subtitles (Zoom, Teams)'

const SUPPORTED_EXTENSIONS = /\.(csv|vtt|srt)$/

/** True when a picked/dropped file is one the backend can import as a transcript. */
export function isSupportedTranscriptFile(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.test(filename.toLowerCase())
}
