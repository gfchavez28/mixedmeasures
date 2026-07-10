import { type Segment, type Conversation } from '@/lib/api'

// 0.5×–2×: sub-1× matters for dense speech / transcription checking; >1× for
// review listening. preservesPitch (default true in Chromium) keeps voices
// natural at every speed. Array order = cycle order (1× is the initial state).
export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
export const SEEK_LEAD_IN_SECONDS = 1.5

/**
 * THE playback gate: does this conversation have media the workbench player
 * can mount? Single-sourced here so usePlayback and the element-mounting
 * surface can never disagree. Audio mounts the hidden <audio> element; video
 * mounts the VideoPane's <video> (V1 slab 4) — which element is the mounting
 * surface's branch, but WHETHER playback exists is decided only here.
 * (`has_media` on the wire is the separate MANAGEMENT gate — badge/attach/
 * remove — see lib/api/conversations.)
 */
export function isPlayableMedia(conversation?: Conversation): boolean {
  return (
    (conversation?.media_type === 'audio' || conversation?.media_type === 'video') &&
    !!conversation?.media_filename
  )
}

/**
 * Codec-failure copy: the server accepts by container, which is broader than
 * what the browser decodes (ALAC .m4a, HEVC .mp4, 24-bit WAV). Name the fix
 * for the media type so "uploaded but won't play" is actionable.
 */
export function codecErrorMessage(mediaType: Conversation['media_type']): string {
  if (mediaType === 'video') {
    return (
      'This video uploaded, but your browser can’t play this codec. ' +
      'Re-export it as H.264/AAC MP4 (most tools call this "MP4 (H.264)") and re-attach.'
    )
  }
  return (
    'This audio uploaded, but your browser can’t play this codec. ' +
    'Re-export or convert it to MP3, AAC (.m4a), or 16-bit WAV and re-attach.'
  )
}

/**
 * Floor semantics: find the segment with the highest start_time that is <= the
 * given time. Used during continuous playback to determine which segment the
 * playhead is currently within.
 */
export function findPlayingSegment(segments: Segment[], time: number): Segment | null {
  let best: Segment | null = null
  for (const seg of segments) {
    const segStart = seg.start_time ?? 0
    if (segStart <= time && (best === null || segStart > (best.start_time ?? 0))) {
      best = seg
    }
  }
  return best
}

/**
 * Nearest-neighbor: find the segment whose start_time is closest to a given
 * time. Used when the user clicks or drags the scrubber to a specific position.
 * Tries exact match first, then falls back to closest distance.
 */
export function findNearestSegment(segments: Segment[], time: number): Segment | null {
  // Try exact match first
  const exact = segments.find(s => s.start_time === time)
  if (exact) return exact

  let closest: Segment | null = null
  let closestDist = Infinity
  for (const seg of segments) {
    if (seg.start_time === null || seg.start_time === undefined) continue
    const dist = Math.abs(seg.start_time - time)
    if (dist < closestDist) {
      closestDist = dist
      closest = seg
    }
  }
  return closest
}
