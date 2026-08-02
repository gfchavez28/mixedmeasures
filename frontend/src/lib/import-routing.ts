import { isSupportedTranscriptFile } from './conversation-import-formats'
import { isSupportedMediaFile } from './media-constants'
import { isSupportedDocumentFile } from './document-import-formats'

/**
 * Where does a dropped file actually belong?
 *
 * A researcher who drops an MP4 on the Conversations list is not making a
 * mistake — they are the exact person Observations exist for, and before this
 * they got SILENCE (the drop filter matched nothing and `return`ed). That is the
 * #552 shape wearing a new costume: the tool refusing a thing it fully supports.
 *
 * Extracted as a pure decision so both list pages share it and it can be tested
 * without standing up a page — the alternative is logic buried in a drop handler
 * that only exists in the empty state, which is exactly where nobody tests it.
 */
export type DropRoute =
  | { kind: 'conversation'; files: File[] }
  | { kind: 'observation'; files: File[] }
  | { kind: 'document'; files: File[] }
  | { kind: 'none' }

/**
 * `preferred` is the list the user dropped ON. It only breaks ties: a `.csv` is a
 * transcript on the Conversations list, and a recording is a recording anywhere.
 * We route by what the FILE is, not by where it landed.
 */
export function routeDroppedFiles(
  files: File[],
  preferred: 'conversation' | 'observation' | 'document',
): DropRoute {
  const transcripts = files.filter(f => isSupportedTranscriptFile(f.name))
  const media = files.filter(f => isSupportedMediaFile(f.name))
  const documents = files.filter(f => isSupportedDocumentFile(f.name))

  // Honour the destination first when the file genuinely fits it.
  if (preferred === 'conversation' && transcripts.length > 0) {
    return { kind: 'conversation', files: transcripts }
  }
  if (preferred === 'observation' && media.length > 0) {
    // Only ONE recording per observation — an observation IS its recording.
    return { kind: 'observation', files: [media[0]] }
  }
  if (preferred === 'document' && documents.length > 0) {
    return { kind: 'document', files: documents }
  }

  // Otherwise route by what the file IS, rather than refusing it.
  if (media.length > 0) return { kind: 'observation', files: [media[0]] }
  if (transcripts.length > 0) return { kind: 'conversation', files: transcripts }
  if (documents.length > 0) return { kind: 'document', files: documents }
  return { kind: 'none' }
}
