import { type Segment, type Conversation } from '@/lib/api'

// 0.5×–2×: sub-1× matters for dense speech / transcription checking; >1× for
// review listening. preservesPitch (default true in Chromium) keeps voices
// natural at every speed. Array order = cycle order (1× is the initial state).
export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
export const SEEK_LEAD_IN_SECONDS = 1.5

/**
 * How far before the true end a seek is allowed to land (#563).
 *
 * A media element whose `currentTime` equals its `duration` is **`ended`**, and
 * the HTML spec's play() algorithm says: *"If playback has ended... seek to the
 * earliest possible position."* So parking the playhead exactly at the end turns
 * the next Play press into a silent restart from 0:00.
 */
export const SEEK_END_GUARD_SECONDS = 0.25

/**
 * Clamp a media seek into the range the element can actually honor (#563).
 *
 * THE bug this closes: the transcript timeline and the recording are independent
 * lengths. Scrub a 47-minute transcript whose recording is only 1:53 and the
 * requested `currentTime` (e.g. 1068s) exceeds `duration` — the browser clamps
 * it to exactly `duration`, which leaves the element `ended`. The frame updates
 * (so the seek *looks* like it worked), and then Play restarts from zero and the
 * transcript auto-follow snaps back to the top. That is not exotic data: a
 * partial recording, a trimmed clip, or simply the wrong file attached (the
 * recording slot accepts any file for any transcript) all produce it.
 *
 * Every `media.currentTime = …` assignment MUST route through here. A raw
 * assignment anywhere is the bug coming back.
 */
/**
 * Where the recording ends, expressed on the TIMELINE's clock (#564).
 *
 * The timeline and the recording are two different clocks: a timeline position
 * `t` maps to media position `t + offset` (the sync offset), so a recording of
 * length D covers timeline positions up to `D − offset`. Null when there is no
 * recording, or none whose length we know yet.
 *
 * Named for the TIMELINE, not the transcript, on purpose: a media-only source
 * (the video-only coding track) has a timeline with no transcript at all, and
 * these primitives are the ones it will reuse.
 */
export function recordingEndsAtTimelineTime(
  mediaDuration?: number | null,
  offset = 0,
): number | null {
  if (mediaDuration == null || !Number.isFinite(mediaDuration) || mediaDuration <= 0) return null
  return Math.max(0, mediaDuration - offset)
}

/**
 * Is this timeline position past the end of the recording (#564)?
 *
 * True only when we KNOW the recording's length and the position lies beyond it.
 * With no media (or none measured yet) there is nothing to be beyond, so false —
 * a transcript-only conversation is not "beyond" anything, it simply has no
 * recording.
 */
export function isBeyondRecording(
  time: number,
  mediaDuration?: number | null,
  offset = 0,
): boolean {
  const end = recordingEndsAtTimelineTime(mediaDuration, offset)
  return end !== null && time > end
}

/**
 * The playhead the SCRUBBER renders, in transcript time (#563c).
 *
 * This used to show the true playhead only WHILE PLAYING, and fall back to the
 * selected segment's `start_time` whenever paused. But a paused scrub selects the
 * turn containing the scrubbed time — so the marker snapped to that turn's start
 * the moment you let go (drag to 1:02 inside a turn beginning at 0:08 and the
 * playhead visibly jumped back to 0:08). It hid behind the drag ALSO snapping the
 * media to the same place: the display and the player were wrong together, so they
 * agreed with each other.
 *
 * `currentPlaybackTime` is maintained by every seek AND by `timeupdate`, so it is
 * the playhead whether or not we are playing. The segment start is a fallback for
 * one case only: nothing has been played or seeked yet.
 */
export function scrubberPlayheadTime(
  currentPlaybackTime: number | null,
  selectedSegmentId: number | null | undefined,
  segments: Segment[],
): number | null {
  if (currentPlaybackTime !== null) return currentPlaybackTime
  if (selectedSegmentId == null) return null
  return segments.find(s => s.id === selectedSegmentId)?.start_time ?? null
}

export function clampMediaSeek(target: number, duration?: number | null): number {
  const floored = Math.max(0, target)
  // duration is NaN until metadata loads, and Infinity for a live stream —
  // in both cases we have no end to guard against, so pass the value through.
  if (duration == null || !Number.isFinite(duration) || duration <= 0) return floored
  return Math.min(floored, Math.max(0, duration - SEEK_END_GUARD_SECONDS))
}

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
 * THE media-instance identity (#549/#557): one string that changes exactly
 * when the mounted media element's backing resource changes — conversation
 * switch, attach, remove, or replace (media_version = server mtime+size, so
 * even a same-name re-export changes it). usePlayback keys its media-owning
 * effects on this instead of churning data (segments, offset), so a segments
 * refetch can never tear down the subscription and pause playback.
 */
export function mediaInstanceKey(conversation?: Conversation): string {
  if (!conversation || !isPlayableMedia(conversation)) return 'none'
  return `${conversation.id}:${conversation.media_filename}:${conversation.media_format}:${conversation.media_version ?? 'unknown'}`
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
 * Missing-file copy (#551 player half): the conversation's metadata says a
 * recording exists but the file is not on disk (media_size_bytes === null —
 * stat-derived server truth; e.g. a video-excluded backup restored on another
 * machine). Telling this user to "re-export as H.264" would be a wrong
 * diagnosis at the worst moment — point at re-attaching instead.
 */
export function missingMediaMessage(mediaType: Conversation['media_type']): string {
  const noun = mediaType === 'video' ? 'video' : 'audio'
  return (
    `The ${noun} file for this conversation isn’t on this computer — it may ` +
    'have been excluded from the backup this project was restored from. ' +
    'Use “Replace recording” in the toolbar to re-attach the original file.'
  )
}

/**
 * True when a mounted element's error should read as "file missing" rather
 * than "codec unsupported": the server stat found no file behind the attached
 * metadata. Single-sourced so the hook and any future surfaces agree.
 */
export function isMediaFileMissing(conversation?: Conversation): boolean {
  return !!conversation && isPlayableMedia(conversation) && conversation.media_size_bytes === null
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
