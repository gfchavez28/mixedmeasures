import { useState, useCallback, useRef, useEffect, useMemo, type RefObject } from 'react'
import {
  type PlayableSource,
  type TimelineUnit,
  PLAYBACK_SPEEDS,
  SEEK_LEAD_IN_SECONDS,
  clampMediaSeek,
  codecErrorMessage,
  isBeyondRecording,
  findNearestSegment,
  findPlayingSegment,
  isMediaFileMissing,
  isPlayableMedia,
  mediaInstanceKey,
  missingMediaMessage,
} from '@/lib/playback-utils'

export { PLAYBACK_SPEEDS }

interface UsePlaybackOptions<S extends TimelineUnit> {
  /** Filtered timeline units (transcript segments / observation clips). */
  segments: S[]
  selectedSegments: number[]
  onSelectionChange: (ids: number[]) => void
  /**
   * Media element ref (<audio> today, <video> once the pane ships) — when
   * present and the source has playable media, drives real playback.
   */
  mediaRef?: RefObject<HTMLMediaElement | null>
  /** The playable source (Conversation or Observation) — offset + playback gate. */
  source?: PlayableSource
  /**
   * Should PLAYBACK drive the SELECTION (slab 3c / D14)? Default true — the
   * conversation workbenches' always-on follow, unchanged. The observation
   * workbench passes false: its selection is an EDITING target (boundary
   * nudges, F2 label), and an advancing playhead must not stomp it. Slab 4's
   * Follow toggle drives it per-surface. Gates ONLY the playback→selection
   * direction; a manual selection still seeks the media (selection→playback).
   */
  followPlayhead?: boolean
  /**
   * D27 (Observations Follow): which units the playhead is "in" right now.
   * When supplied, BOTH clock drivers write the FULL returned array as the
   * selection — all overlapping clips select together, and a GAP yields []
   * (the selection honestly empties; chords then no-op via the selection
   * gate). Default = the floor-single behavior (`findPlayingSegment`, one id,
   * never empties) — conversations byte-identical without it.
   */
  findUnitsAtTime?: (units: S[], time: number) => number[]
}

/** Order-sensitive id equality — the follow drivers' write-skip guard. */
function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

interface TimeSeekResult {
  segmentId: number
  segmentIndex: number
}

export interface UsePlaybackReturn<S extends TimelineUnit> {
  isPlaying: boolean
  playbackSpeed: number
  currentPlaybackTime: number | null
  segmentsWithTime: S[]
  /**
   * The playback gate (lib/playback-utils::isPlayableMedia) — true when the
   * conversation has media the player can mount. Consumers must use THIS to
   * gate the media element and player chrome rather than re-deriving from
   * conversation fields, so the hook and the mounting surface always agree.
   */
  hasPlayableMedia: boolean
  togglePlayback: () => void
  cyclePlaybackSpeed: () => void
  /** Stop playback and update the current time (e.g. from a scrubber drag). */
  seekToTime: (time: number) => void
  /**
   * Seek WITHOUT stopping playback (slab 3d — J-K-L transport, timeline
   * clicks). Within the recording a playing element keeps playing from the new
   * position; a seek BEYOND the recording parks the element and pauses honestly
   * (the interval driver's baseline cannot absorb a live seek, and rolling the
   * parked tail would be the #564 bug). Still routed through clampMediaSeek.
   */
  seekWithoutPausing: (time: number) => void
  /**
   * Stop playback, seek to time, find the nearest segment, and select it.
   * Returns the segment info so the caller can scroll to it, or null if no
   * segment was found.
   */
  handleTimeSeek: (time: number) => TimeSeekResult | null
  /** Seek media to a segment's start_time with lead-in buffer */
  seekToSegment: (segment: S) => void
  /** True after the media element's loadedmetadata fires */
  isMediaReady: boolean
  /** True between waiting and playing events */
  isBuffering: boolean
  /** Media error message, if any */
  mediaError: string | null
  /**
   * The playhead is past the end of the recording (#564): the media element is
   * parked and the timeline clock runs on its own. Consumers use this to SAY so —
   * an amber playhead, a "(transcript only)" label, the pane's chip.
   */
  isTranscriptOnly: boolean
}

export function usePlayback<S extends TimelineUnit>({
  segments,
  selectedSegments,
  onSelectionChange,
  mediaRef,
  source,
  followPlayhead = true,
  findUnitsAtTime,
}: UsePlaybackOptions<S>): UsePlaybackReturn<S> {
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const playbackIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const currentPlaybackTimeRef = useRef<number | null>(null)
  // State mirror of currentPlaybackTimeRef for render (ref is mutated in interval callback)
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState<number | null>(null)
  const [isMediaReady, setIsMediaReady] = useState(false)
  const [isBuffering, setIsBuffering] = useState(false)
  const [mediaError, setMediaError] = useState<string | null>(null)

  // Latest-value refs. The media-element listener effect below is long-lived
  // (it owns the playing media). If it depended on `selectedSegments` /
  // `onSelectionChange` / `isPlaying` — or on refetch-churning data like
  // `segmentsWithTime` (every code apply refetches segments — #557), the
  // conversation payload, or `offset` (nudging the sync offset mid-listen) —
  // React would tear it down and re-run it, invoking the cleanup's
  // `media.pause()`, halting playback. Reading everything volatile through
  // refs keeps the subscription stable for the life of the media INSTANCE.
  const selectedSegmentsRef = useRef(selectedSegments)
  selectedSegmentsRef.current = selectedSegments
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying
  const sourceRef = useRef(source)
  sourceRef.current = source
  // Read via ref inside the long-lived drivers, like every volatile input.
  const followPlayheadRef = useRef(followPlayhead)
  followPlayheadRef.current = followPlayhead
  const findUnitsAtTimeRef = useRef(findUnitsAtTime)
  findUnitsAtTimeRef.current = findUnitsAtTime

  // The follow write, shared by both clock drivers (D27): the multi-unit
  // finder writes the FULL array (including an honest []); the floor-single
  // default keeps the conversation behavior byte-identical.
  const followSelection = useCallback((segs: S[], time: number) => {
    const finder = findUnitsAtTimeRef.current
    if (finder) {
      const ids = finder(segs, time)
      if (!sameIds(ids, selectedSegmentsRef.current)) {
        onSelectionChangeRef.current(ids)
      }
      return
    }
    const targetSegment = findPlayingSegment(segs, time)
    if (targetSegment && targetSegment.id !== selectedSegmentsRef.current[0]) {
      onSelectionChangeRef.current([targetSegment.id])
    }
  }, [])

  const hasPlayableMedia = isPlayableMedia(source)

  /**
   * THE media seek (#563). Every `currentTime` write in this hook goes through
   * here so a seek can never park the element at its `duration` — an element at
   * its end is `ended`, and the HTML spec makes play() on an ended element seek
   * back to ZERO. That is how "scrub anywhere, press play, and it starts at
   * 0:00" happened: the transcript can be far longer than the recording (partial
   * capture, trimmed clip, wrong file attached), so a scrub past the recording's
   * end asked for a time the browser clamped straight to `duration`.
   *
   * `media.duration` is read at seek time (not from `conversation`), so it is the
   * element's own truth even before the server's metadata agrees.
   */
  const seekMedia = useCallback((media: HTMLMediaElement, target: number) => {
    // Returns where the element ACTUALLY landed, which is not always `target`:
    // the clamp both floors at 0 and holds back from `duration` (#563). A
    // caller that also maintains the clock must write THIS, never its own
    // request, or the two disagree (#770).
    const landed = clampMediaSeek(target, media.duration)
    media.currentTime = landed
    return landed
  }, [])

  const offset = source?.media_offset_seconds ?? 0
  const offsetRef = useRef(offset)
  offsetRef.current = offset

  // ── The timeline clock has TWO drivers (#564) ──────────────────────────────
  //
  // `currentPlaybackTime` is the TIMELINE's clock, not the media element's. While
  // the playhead sits inside the recording the element drives it (`timeupdate`);
  // once the playhead moves PAST the end of the recording the element is parked
  // and an interval drives it instead, so the transcript keeps rolling with no
  // video behind it. `isTranscriptOnly` is which driver is live.
  //
  // This is what stops the marker snapping back: the element, clamped to its own
  // end, kept firing `timeupdate` and dragging the playhead back to the end of
  // the recording. Beyond the recording, `timeupdate` is not the truth.
  //
  // It is EXPLICIT state, not derived from the clock, because of the boundary:
  // at the instant the recording ends, the playhead equals the recording's end
  // and a derived flag would read "not beyond" — the exact moment we need to
  // hand over to the other driver.
  const [isTranscriptOnly, setIsTranscriptOnlyState] = useState(false)
  const transcriptOnlyRef = useRef(false)
  const setTranscriptOnly = useCallback((next: boolean) => {
    // The ref is written SYNCHRONOUSLY: the media-element listeners below live in
    // an instance-keyed effect and read this without re-subscribing (#557).
    transcriptOnlyRef.current = next
    setIsTranscriptOnlyState(next)
  }, [])

  /** Does the timeline run past the end of the recording at all? */
  const timelineOutrunsRecording = useCallback(
    (media: HTMLMediaElement | null | undefined, timelineTime: number) => {
      const duration = media && Number.isFinite(media.duration) && media.duration > 0
        ? media.duration
        : sourceRef.current?.media_duration_seconds ?? null
      return isBeyondRecording(timelineTime, duration, offsetRef.current)
    },
    [],
  )

  // THE media-instance identity (#549/#557): changes exactly when the mounted
  // element's backing resource changes (conversation switch, attach, remove,
  // replace — media_version catches same-name re-exports). The media-owning
  // effects key on this, never on churning data.
  const mediaKey = mediaInstanceKey(source)

  // Get segments with timestamps sorted by start_time
  const segmentsWithTime = useMemo(() =>
    segments.filter(s => s.start_time !== null && s.start_time !== undefined)
      .sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0)),
    [segments]
  )
  const segmentsWithTimeRef = useRef(segmentsWithTime)
  segmentsWithTimeRef.current = segmentsWithTime

  // Element-failure copy: missing file ≠ codec failure (#551 player half).
  // media_size_bytes === null is the server saying "metadata exists, file
  // doesn't" (e.g. a video-excluded backup restored on another machine) —
  // telling that user to re-encode a file they don't have would be a wrong
  // diagnosis at the worst moment. Reads the conversation via ref so the
  // listener effect stays instance-keyed.
  const reportPlaybackError = useCallback(() => {
    const conv = sourceRef.current
    setMediaError(
      isMediaFileMissing(conv)
        ? missingMediaMessage(conv?.media_type ?? null)
        : codecErrorMessage(conv?.media_type ?? null)
    )
  }, [])

  // Reset media ready state when the media instance changes (conversation
  // switch, attach/remove, replace — mediaKey covers all of these, including
  // the same-name replace that media_filename alone can't detect).
  useEffect(() => {
    setIsMediaReady(false)
    setMediaError(null)
    setIsBuffering(false)
    setTranscriptOnly(false) // #564: a new media instance re-attaches the clock
  }, [source?.id, mediaKey, setTranscriptOnly])

  // ── Media element event listeners ──────────────────────────────────
  useEffect(() => {
    const media = mediaRef?.current
    if (!media || !hasPlayableMedia) return

    const handleTimeUpdate = () => {
      // #564: beyond the recording the element is PARKED at its clamped end and
      // still emits timeupdate — letting it write the clock is exactly what
      // dragged the playhead back to the end of the recording after a scrub.
      // Out there the interval driver owns the clock.
      if (transcriptOnlyRef.current) return

      const mediaTime = media.currentTime
      const transcriptTime = mediaTime - offsetRef.current
      currentPlaybackTimeRef.current = transcriptTime
      setCurrentPlaybackTime(transcriptTime)

      // Segment-following only while actually playing. Setting `currentTime`
      // (manual segment click / scrub) also fires `timeupdate`; following it
      // here would re-select the floor segment, which — because seeks land
      // start_time − lead-in — is the *previous* segment, re-triggering the
      // seek effect and cascading the selection backward to 0. Gating on
      // isPlaying breaks that loop while preserving live playhead-following.
      const segs = segmentsWithTimeRef.current
      if (followPlayheadRef.current && isPlayingRef.current && segs.length > 0) {
        followSelection(segs, transcriptTime)
      }
    }

    const handleEnded = () => {
      // #564: the RECORDING is over — the TIMELINE may not be. If there is
      // transcript past the end of the recording, hand the clock to the interval
      // driver and keep playing; the researcher asked to read along in time, and
      // a partial recording shouldn't end the session.
      //
      // `ended` only fires from real playback reaching the end (our seek clamp
      // guarantees a seek never lands ON `duration`), so we know we were playing.
      const segs = segmentsWithTimeRef.current
      const last = segs.length > 0 ? segs[segs.length - 1] : null
      const timelineEnd = last ? (last.end_time ?? last.start_time ?? null) : null
      const recordingEnd = media.duration - offsetRef.current

      if (timelineEnd !== null && timelineEnd > recordingEnd + 0.5) {
        setTranscriptOnly(true)
        currentPlaybackTimeRef.current = recordingEnd
        setCurrentPlaybackTime(recordingEnd)
        setIsPlaying(true) // re-assert: the spec fires `pause` BEFORE `ended`
        return
      }
      setIsPlaying(false)
    }

    // Keep isPlaying truthful when something other than togglePlayback drives
    // the element (OS media keys / MediaSession, a rejected play()) — the
    // play button and the auto-follow gate both read this state.
    const handlePlay = () => {
      setIsPlaying(true)
    }

    const handlePause = () => {
      // #564: two pauses are NOT the user pausing.
      //   - The end-of-playback pause: the spec fires `pause` then `ended`, and
      //     `ended` may hand the clock to the interval driver. Letting this stop
      //     playback would kill the handover before it happened.
      //   - Our own detach pause (parking the element past the recording).
      if (media.ended || transcriptOnlyRef.current) return
      setIsPlaying(false)
    }

    const handleError = () => {
      setIsPlaying(false)
      // The file uploaded fine (the server accepts by container, which is
      // broader than what browsers decode — e.g. ALAC .m4a, HEVC .mp4,
      // 24-bit WAV) — OR the file is missing behind the metadata. The shared
      // helper picks the actionable copy for each case.
      reportPlaybackError()
    }

    const handleLoadedMetadata = () => {
      setIsMediaReady(true)
      setMediaError(null)
    }

    const handleWaiting = () => {
      setIsBuffering(true)
    }

    const handlePlaying = () => {
      setIsBuffering(false)
    }

    media.addEventListener('timeupdate', handleTimeUpdate)
    media.addEventListener('ended', handleEnded)
    media.addEventListener('play', handlePlay)
    media.addEventListener('pause', handlePause)
    media.addEventListener('error', handleError)
    media.addEventListener('loadedmetadata', handleLoadedMetadata)
    media.addEventListener('waiting', handleWaiting)
    media.addEventListener('playing', handlePlaying)

    // If metadata is already loaded (e.g. cached), set ready immediately
    if (media.readyState >= 1) {
      setIsMediaReady(true)
    }

    return () => {
      // Ordering is load-bearing: remove listeners BEFORE the teardown pause
      // so handlePause never fires from our own cleanup.
      media.removeEventListener('timeupdate', handleTimeUpdate)
      media.removeEventListener('ended', handleEnded)
      media.removeEventListener('play', handlePlay)
      media.removeEventListener('pause', handlePause)
      media.removeEventListener('error', handleError)
      media.removeEventListener('loadedmetadata', handleLoadedMetadata)
      media.removeEventListener('waiting', handleWaiting)
      media.removeEventListener('playing', handlePlaying)
      // A teardown here means the media INSTANCE is going away (conversation
      // switch, replace, unmount) — stop it and keep the button truthful.
      media.pause()
      setIsPlaying(false)
    }
    // This effect OWNS the playing element (its cleanup pauses it), so its
    // deps are the media-instance identity ONLY. selectedSegments /
    // onSelectionChange / isPlaying / offset / segmentsWithTime / the
    // conversation payload are all read via refs — listing any of them would
    // re-run this effect on refetch churn and pause playback (#557: every
    // code apply refetches segments; the offset popover refetches the
    // conversation).
  }, [hasPlayableMedia, mediaRef, mediaKey, reportPlaybackError, setTranscriptOnly, followSelection])

  // ── The interval driver: the timeline clock without a media element ───────
  //
  // Runs in two cases (#564):
  //   1. No media at all — a transcript-only conversation (the original use).
  //   2. The playhead is PAST THE END of the recording, so the element is parked
  //      and cannot drive the clock. The transcript keeps rolling on its own.
  //
  // Timestamp-based, NOT accumulated. The old version added `+100ms × speed` per
  // tick, which drifts — and browsers throttle background-tab intervals to ~1/s,
  // so a backgrounded transcript would fall minutes behind. Reading the elapsed
  // wall time each tick means a throttled tick jumps to the RIGHT place instead
  // of losing the time it never got to count.
  useEffect(() => {
    const clockDriven = !hasPlayableMedia || isTranscriptOnly
    if (!clockDriven) return

    if (!isPlaying) {
      if (playbackIntervalRef.current) {
        clearInterval(playbackIntervalRef.current)
        playbackIntervalRef.current = null
      }
      return
    }

    if (segmentsWithTime.length === 0) {
      setIsPlaying(false)
      return
    }

    // Initialize playback time from current selection or start
    if (currentPlaybackTimeRef.current === null) {
      const selectedSeg = segments.find(s => s.id === selectedSegmentsRef.current[0])
      const initTime = selectedSeg?.start_time ?? segmentsWithTime[0].start_time ?? 0
      currentPlaybackTimeRef.current = initTime
      setCurrentPlaybackTime(initTime)
    }

    const maxTime = segmentsWithTime[segmentsWithTime.length - 1].end_time ??
                    segmentsWithTime[segmentsWithTime.length - 1].start_time ?? 0

    const startedAtWallClock = performance.now()
    const startedAtTimelineTime = currentPlaybackTimeRef.current ?? 0

    playbackIntervalRef.current = setInterval(() => {
      const elapsed = ((performance.now() - startedAtWallClock) / 1000) * playbackSpeed
      const t = startedAtTimelineTime + elapsed

      if (t > maxTime) {
        // The timeline is over (not just the recording).
        currentPlaybackTimeRef.current = maxTime
        setCurrentPlaybackTime(maxTime)
        setIsPlaying(false)
        return
      }

      currentPlaybackTimeRef.current = t
      setCurrentPlaybackTime(t)

      if (followPlayheadRef.current) {
        followSelection(segmentsWithTime, t)
      }
    }, 100)

    return () => {
      if (playbackIntervalRef.current) {
        clearInterval(playbackIntervalRef.current)
        playbackIntervalRef.current = null
      }
    }
    // selectedSegments / onSelectionChange read via refs — see media effect.
    // followSelection is a stable [] useCallback — listing it adds no churn.
  }, [isPlaying, playbackSpeed, segmentsWithTime, segments, hasPlayableMedia, isTranscriptOnly, followSelection])

  // Seek when the PRIMARY selection actually changes to a different segment
  // while paused (a manual segment click). Guarded by a previous-id ref so it
  // never fires from anything else that re-runs this effect (#558 family):
  //   - the pause TRANSITION (isPlaying is read via ref, NOT a dep — pausing
  //     used to seek back to the followed segment's start, losing up to a
  //     full multi-minute turn of position);
  //   - a segments refetch while paused (identity churn, same id);
  //   - a shift-extension of the selection (same primary id);
  //   - a scrub commit (handleTimeSeek pre-seeds the ref so its precise
  //     position isn't overridden by segment-start − lead-in).
  // During playback the auto-follow's selection changes are RECORDED (so the
  // eventual pause sees "no change") but never seeked.
  const prevSelectedIdRef = useRef<number | null>(null)
  useEffect(() => {
    const selId = selectedSegments.length > 0 ? selectedSegments[0] : null
    const prevId = prevSelectedIdRef.current
    prevSelectedIdRef.current = selId
    if (selId === null || selId === prevId) return
    if (isPlayingRef.current) return

    const selectedSeg = segments.find(s => s.id === selId)
    if (selectedSeg?.start_time !== undefined && selectedSeg?.start_time !== null) {
      // Seek media with lead-in buffer
      const media = mediaRef?.current
      if (media && hasPlayableMedia) {
        const targetTime = selectedSeg.start_time + offset
        const seekTime = Math.max(0, targetTime - SEEK_LEAD_IN_SECONDS)
        const landed = seekMedia(media, seekTime)
        // Clicking a turn that begins past the end of the recording detaches the
        // clock, exactly like scrubbing there (#564).
        const beyond = timelineOutrunsRecording(media, selectedSeg.start_time)
        setTranscriptOnly(beyond)

        // #770: the clock names WHERE THE MEDIA IS, never where the selection
        // is. This used to write `selectedSeg.start_time` — three lines above
        // the seek that deliberately lands `− SEEK_LEAD_IN_SECONDS` earlier —
        // so for one commit the clock claimed a position the element never
        // occupies, and `timeupdate` then corrected it ~100ms later.
        //
        // No human can see that frame. A SCREEN READER can: the Observations
        // clip row folds "— now playing" (derived from this clock) into its
        // accessible NAME, and a name that changes while the row is the active
        // descendant is re-read. Every clip was announced twice — measured on
        // three consecutive ArrowDown presses, and reported from a real NVDA
        // pass before it was understood here.
        //
        // BEYOND the recording the element is parked and the transcript rolls
        // on its own clock (#564), so there the SEGMENT is the truth and the
        // clamped element position would drag the playhead back to the end of
        // the recording — the exact snap-back #564 exists to prevent.
        const clock = beyond ? selectedSeg.start_time : landed - offset
        currentPlaybackTimeRef.current = clock
        setCurrentPlaybackTime(clock)
      } else {
        // No playable media: nothing else will ever drive the clock, so the
        // segment start IS the playhead. This is the branch the old
        // unconditional write was right for, which is why it survived.
        currentPlaybackTimeRef.current = selectedSeg.start_time
        setCurrentPlaybackTime(selectedSeg.start_time)
      }
    }
  }, [selectedSegments, segments, mediaRef, hasPlayableMedia, offset, seekMedia, setTranscriptOnly, timelineOutrunsRecording])

  // Sync playback speed to the media element. preservesPitch is the Chromium
  // default but set explicitly: natural-pitch speed listening is the feature.
  useEffect(() => {
    const media = mediaRef?.current
    if (media && hasPlayableMedia) {
      media.preservesPitch = true // eslint-disable-line react-hooks/immutability -- DOM media rate/pitch
      media.playbackRate = playbackSpeed
    }
  }, [playbackSpeed, hasPlayableMedia, mediaRef])

  const togglePlayback = useCallback(() => {
    const media = mediaRef?.current

    if (isPlaying) {
      if (media && hasPlayableMedia) {
        media.pause()
      }
      setIsPlaying(false)
    } else {
      // Gate on media ready when media is present
      if (hasPlayableMedia && !isMediaReady) return

      // #564: when the playhead is past the end of the recording the element stays
      // PARKED — calling play() there would roll the last frames of a video the
      // researcher has already left behind. The interval driver rolls the
      // transcript on instead.
      if (media && hasPlayableMedia && !transcriptOnlyRef.current) {
        // If no current time set, start from selection or beginning. Gated on
        // followPlayhead: with follow off (observations) Play must simply roll
        // from the current position — auto-selecting the first clip and seeking
        // to it is the same playback→selection coupling D14 makes opt-in.
        if (followPlayhead && selectedSegments.length === 0 && segmentsWithTime.length > 0) {
          onSelectionChange([segmentsWithTime[0].id])
          const startTime = (segmentsWithTime[0].start_time ?? 0) + offset
          seekMedia(media, startTime)
        }
        media.play().catch(() => {
          // Keep the button truthful — the optimistic setIsPlaying(true)
          // below already ran by the time a rejection lands.
          setIsPlaying(false)
          reportPlaybackError()
        })
      } else {
        // Clock-driven playback: no media at all, or the playhead is beyond the
        // recording. Seed a start position ONLY if we have none — a transcript-only
        // resume must continue from where the researcher scrubbed to, not jump back
        // to the first segment.
        if (
          followPlayhead
          && selectedSegments.length === 0
          && segmentsWithTime.length > 0
          && currentPlaybackTimeRef.current === null
        ) {
          onSelectionChange([segmentsWithTime[0].id])
          const startTime = segmentsWithTime[0].start_time ?? 0
          currentPlaybackTimeRef.current = startTime
          setCurrentPlaybackTime(startTime)
        }
      }
      setIsPlaying(true)
    }
  }, [isPlaying, selectedSegments, segmentsWithTime, onSelectionChange, mediaRef, hasPlayableMedia, isMediaReady, offset, reportPlaybackError, seekMedia, followPlayhead])

  const cyclePlaybackSpeed = useCallback(() => {
    setPlaybackSpeed(current => {
      const currentIndex = PLAYBACK_SPEEDS.indexOf(current)
      const nextIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length
      return PLAYBACK_SPEEDS[nextIndex]
    })
  }, [])

  const seekToTime = useCallback((time: number) => {
    const media = mediaRef?.current
    if (media && hasPlayableMedia) {
      // The element must actually stop — setting isPlaying alone leaves it
      // playing while the button reads "Play" (state/element desync).
      media.pause()
      // Parked at its clamped end when the target is past the recording; from
      // there the clock is OURS, not the element's (#564).
      seekMedia(media, time + offset)
      setTranscriptOnly(timelineOutrunsRecording(media, time))
    }
    setIsPlaying(false)
    currentPlaybackTimeRef.current = time
    setCurrentPlaybackTime(time)
  }, [mediaRef, hasPlayableMedia, offset, seekMedia, setTranscriptOnly, timelineOutrunsRecording])

  const seekWithoutPausing = useCallback((time: number) => {
    const t = Math.max(0, time)
    const media = mediaRef?.current
    if (media && hasPlayableMedia) {
      const beyond = timelineOutrunsRecording(media, t)
      // Flip the driver flag BEFORE touching the element, so the pause below is
      // recognized as OUR parking pause (handlePause ignores it) and a resumed
      // element's timeupdate is trusted again immediately.
      setTranscriptOnly(beyond)
      seekMedia(media, t + offsetRef.current)
      if (beyond) {
        // Park + pause honestly: the interval driver captures its wall-clock
        // baseline when it starts and cannot absorb a mid-flight seek, so a
        // "non-pausing" overhang seek would snap back on the next tick.
        media.pause()
        setIsPlaying(false)
      } else if (isPlayingRef.current && media.paused) {
        // The element was parked (or the clock was interval-driven) and the
        // seek came back INSIDE the recording — re-attach it. Guarded play():
        // this is the one legal wake-up, a position the element can honor.
        media.play().catch(() => {
          setIsPlaying(false)
          reportPlaybackError()
        })
      }
    }
    currentPlaybackTimeRef.current = t
    setCurrentPlaybackTime(t)
  }, [mediaRef, hasPlayableMedia, seekMedia, setTranscriptOnly, timelineOutrunsRecording, reportPlaybackError])

  const handleTimeSeek = useCallback((time: number): TimeSeekResult | null => {
    const media = mediaRef?.current
    if (media && hasPlayableMedia) {
      // Same as seekToTime: stop the element, not just the state.
      media.pause()
      seekMedia(media, time + offset)
      setTranscriptOnly(timelineOutrunsRecording(media, time))
    }
    setIsPlaying(false)
    currentPlaybackTimeRef.current = time
    setCurrentPlaybackTime(time)

    const segment = findNearestSegment(segments, time)
    if (segment) {
      // Pre-seed the manual-seek guard: this selection change rides a PRECISE
      // scrub — the selection effect must not override the scrubbed position
      // with segment-start − lead-in.
      prevSelectedIdRef.current = segment.id
      onSelectionChange([segment.id])
      const index = segments.findIndex(s => s.id === segment.id)
      if (index >= 0) {
        return { segmentId: segment.id, segmentIndex: index }
      }
    }
    return null
  }, [segments, onSelectionChange, mediaRef, hasPlayableMedia, offset, seekMedia, setTranscriptOnly, timelineOutrunsRecording])

  const seekToSegment = useCallback((segment: S) => {
    const media = mediaRef?.current
    const targetTime = (segment.start_time ?? 0) + offset
    const seekTime = Math.max(0, targetTime - SEEK_LEAD_IN_SECONDS)

    if (media && hasPlayableMedia) {
      seekMedia(media, seekTime)
      setTranscriptOnly(timelineOutrunsRecording(media, segment.start_time ?? 0))
    }

    const transcriptTime = segment.start_time ?? 0
    currentPlaybackTimeRef.current = transcriptTime
    setCurrentPlaybackTime(transcriptTime)
  }, [mediaRef, hasPlayableMedia, offset, seekMedia, setTranscriptOnly, timelineOutrunsRecording])

  return {
    isPlaying,
    playbackSpeed,
    currentPlaybackTime,
    segmentsWithTime,
    hasPlayableMedia,
    togglePlayback,
    cyclePlaybackSpeed,
    seekToTime,
    seekWithoutPausing,
    handleTimeSeek,
    seekToSegment,
    isMediaReady,
    isBuffering,
    mediaError,
    isTranscriptOnly,
  }
}
