import { useState, useCallback, useRef, useEffect, useMemo, type RefObject } from 'react'
import { type Segment, type Conversation } from '@/lib/api'
import {
  PLAYBACK_SPEEDS,
  SEEK_LEAD_IN_SECONDS,
  codecErrorMessage,
  findNearestSegment,
  findPlayingSegment,
  isPlayableMedia,
} from '@/lib/playback-utils'

export { PLAYBACK_SPEEDS }

interface UsePlaybackOptions {
  /** Filtered segments (after speaker/text filter) */
  segments: Segment[]
  selectedSegments: number[]
  onSelectionChange: (ids: number[]) => void
  /**
   * Media element ref (<audio> today, <video> once the pane ships) — when
   * present and the conversation has playable media, drives real playback.
   */
  mediaRef?: RefObject<HTMLMediaElement | null>
  /** Conversation with media metadata — used for offset and the playback gate */
  conversation?: Conversation
}

interface TimeSeekResult {
  segmentId: number
  segmentIndex: number
}

export interface UsePlaybackReturn {
  isPlaying: boolean
  playbackSpeed: number
  currentPlaybackTime: number | null
  segmentsWithTime: Segment[]
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
   * Stop playback, seek to time, find the nearest segment, and select it.
   * Returns the segment info so the caller can scroll to it, or null if no
   * segment was found.
   */
  handleTimeSeek: (time: number) => TimeSeekResult | null
  /** Seek media to a segment's start_time with lead-in buffer */
  seekToSegment: (segment: Segment) => void
  /** True after the media element's loadedmetadata fires */
  isMediaReady: boolean
  /** True between waiting and playing events */
  isBuffering: boolean
  /** Media error message, if any */
  mediaError: string | null
}

export function usePlayback({
  segments,
  selectedSegments,
  onSelectionChange,
  mediaRef,
  conversation,
}: UsePlaybackOptions): UsePlaybackReturn {
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
  // `onSelectionChange` / `isPlaying` directly, React would tear it down and
  // re-run it — invoking the cleanup's `media.pause()` — every time the
  // playing segment changes, halting playback at the first segment boundary
  // (bug: cuts off at segment 2). Reading these through refs keeps the
  // subscription stable for the life of the media element.
  const selectedSegmentsRef = useRef(selectedSegments)
  selectedSegmentsRef.current = selectedSegments
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying

  const hasPlayableMedia = isPlayableMedia(conversation)
  const offset = conversation?.media_offset_seconds ?? 0

  // Get segments with timestamps sorted by start_time
  const segmentsWithTime = useMemo(() =>
    segments.filter(s => s.start_time !== null && s.start_time !== undefined)
      .sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0)),
    [segments]
  )

  // Reset media ready state when conversation changes or media is removed
  useEffect(() => {
    setIsMediaReady(false)
    setMediaError(null)
    setIsBuffering(false)
  }, [conversation?.id, conversation?.media_filename])

  // ── Media element event listeners ──────────────────────────────────
  useEffect(() => {
    const media = mediaRef?.current
    if (!media || !hasPlayableMedia) return

    const handleTimeUpdate = () => {
      const mediaTime = media.currentTime
      const transcriptTime = mediaTime - offset
      currentPlaybackTimeRef.current = transcriptTime
      setCurrentPlaybackTime(transcriptTime)

      // Segment-following only while actually playing. Setting `currentTime`
      // (manual segment click / scrub) also fires `timeupdate`; following it
      // here would re-select the floor segment, which — because seeks land
      // start_time − lead-in — is the *previous* segment, re-triggering the
      // seek effect and cascading the selection backward to 0. Gating on
      // isPlaying breaks that loop while preserving live playhead-following.
      if (isPlayingRef.current && segmentsWithTime.length > 0) {
        const targetSegment = findPlayingSegment(segmentsWithTime, transcriptTime)
        if (targetSegment && targetSegment.id !== selectedSegmentsRef.current[0]) {
          onSelectionChangeRef.current([targetSegment.id])
        }
      }
    }

    const handleEnded = () => {
      setIsPlaying(false)
    }

    const handleError = () => {
      setIsPlaying(false)
      // The file uploaded fine (the server accepts by container, which is
      // broader than what browsers decode — e.g. ALAC .m4a, HEVC .mp4,
      // 24-bit WAV). Be specific so the user isn't confused why an
      // "uploaded" file won't play, and give an actionable fix.
      setMediaError(codecErrorMessage(conversation?.media_type ?? null))
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
    media.addEventListener('error', handleError)
    media.addEventListener('loadedmetadata', handleLoadedMetadata)
    media.addEventListener('waiting', handleWaiting)
    media.addEventListener('playing', handlePlaying)

    // If metadata is already loaded (e.g. cached), set ready immediately
    if (media.readyState >= 1) {
      setIsMediaReady(true)
    }

    return () => {
      media.removeEventListener('timeupdate', handleTimeUpdate)
      media.removeEventListener('ended', handleEnded)
      media.removeEventListener('error', handleError)
      media.removeEventListener('loadedmetadata', handleLoadedMetadata)
      media.removeEventListener('waiting', handleWaiting)
      media.removeEventListener('playing', handlePlaying)
      media.pause()
    }
    // selectedSegments / onSelectionChange / isPlaying are intentionally read
    // via refs (above) — keeping them out of deps keeps this media-owning
    // subscription stable so a segment change never tears it down + pauses.
  }, [hasPlayableMedia, offset, segmentsWithTime, mediaRef, conversation?.media_type])

  // ── Text-only simulated playback (interval-based fallback) ─────────
  useEffect(() => {
    // Skip interval-based playback when the media element is handling it
    if (hasPlayableMedia) return

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

    const intervalMs = 100
    const timeAdvancePerInterval = (intervalMs / 1000) * playbackSpeed

    playbackIntervalRef.current = setInterval(() => {
      if (currentPlaybackTimeRef.current === null) return

      currentPlaybackTimeRef.current += timeAdvancePerInterval
      setCurrentPlaybackTime(currentPlaybackTimeRef.current)

      if (currentPlaybackTimeRef.current > maxTime) {
        setIsPlaying(false)
        currentPlaybackTimeRef.current = null
        setCurrentPlaybackTime(null)
        return
      }

      const targetSegment = findPlayingSegment(segmentsWithTime, currentPlaybackTimeRef.current)
      if (targetSegment && targetSegment.id !== selectedSegmentsRef.current[0]) {
        onSelectionChangeRef.current([targetSegment.id])
      }
    }, intervalMs)

    return () => {
      if (playbackIntervalRef.current) {
        clearInterval(playbackIntervalRef.current)
        playbackIntervalRef.current = null
      }
    }
    // selectedSegments / onSelectionChange read via refs — see media effect.
  }, [isPlaying, playbackSpeed, segmentsWithTime, segments, hasPlayableMedia])

  // Reset playback time when selection changes manually (not during playback)
  // When media is present, also seek it to the selected segment with lead-in
  useEffect(() => {
    if (!isPlaying && selectedSegments.length > 0) {
      const selectedSeg = segments.find(s => s.id === selectedSegments[0])
      if (selectedSeg?.start_time !== undefined && selectedSeg?.start_time !== null) {
        currentPlaybackTimeRef.current = selectedSeg.start_time
        setCurrentPlaybackTime(selectedSeg.start_time)

        // Seek media with lead-in buffer
        const media = mediaRef?.current
        if (media && hasPlayableMedia) {
          const targetTime = selectedSeg.start_time + offset
          const seekTime = Math.max(0, targetTime - SEEK_LEAD_IN_SECONDS)
          media.currentTime = seekTime // eslint-disable-line react-hooks/immutability -- DOM media seek
        }
      }
    }
  }, [selectedSegments, segments, isPlaying, mediaRef, hasPlayableMedia, offset])

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

      if (media && hasPlayableMedia) {
        // If no current time set, start from selection or beginning
        if (selectedSegments.length === 0 && segmentsWithTime.length > 0) {
          onSelectionChange([segmentsWithTime[0].id])
          const startTime = (segmentsWithTime[0].start_time ?? 0) + offset
          media.currentTime = Math.max(0, startTime) // eslint-disable-line react-hooks/immutability -- DOM media seek
        }
        media.play().catch(() => {
          setMediaError(codecErrorMessage(conversation?.media_type ?? null))
        })
      } else {
        // Text-only fallback
        if (selectedSegments.length === 0 && segmentsWithTime.length > 0) {
          onSelectionChange([segmentsWithTime[0].id])
          const startTime = segmentsWithTime[0].start_time ?? 0
          currentPlaybackTimeRef.current = startTime
          setCurrentPlaybackTime(startTime)
        }
      }
      setIsPlaying(true)
    }
  }, [isPlaying, selectedSegments, segmentsWithTime, onSelectionChange, mediaRef, hasPlayableMedia, isMediaReady, offset, conversation?.media_type])

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
      media.currentTime = Math.max(0, time + offset) // eslint-disable-line react-hooks/immutability -- DOM media seek
    }
    setIsPlaying(false)
    currentPlaybackTimeRef.current = time
    setCurrentPlaybackTime(time)
  }, [mediaRef, hasPlayableMedia, offset])

  const handleTimeSeek = useCallback((time: number): TimeSeekResult | null => {
    const media = mediaRef?.current
    if (media && hasPlayableMedia) {
      media.currentTime = Math.max(0, time + offset) // eslint-disable-line react-hooks/immutability -- DOM media seek
    }
    setIsPlaying(false)
    currentPlaybackTimeRef.current = time
    setCurrentPlaybackTime(time)

    const segment = findNearestSegment(segments, time)
    if (segment) {
      onSelectionChange([segment.id])
      const index = segments.findIndex(s => s.id === segment.id)
      if (index >= 0) {
        return { segmentId: segment.id, segmentIndex: index }
      }
    }
    return null
  }, [segments, onSelectionChange, mediaRef, hasPlayableMedia, offset])

  const seekToSegment = useCallback((segment: Segment) => {
    const media = mediaRef?.current
    const targetTime = (segment.start_time ?? 0) + offset
    const seekTime = Math.max(0, targetTime - SEEK_LEAD_IN_SECONDS)

    if (media && hasPlayableMedia) {
      media.currentTime = seekTime // eslint-disable-line react-hooks/immutability -- DOM media seek
    }

    const transcriptTime = segment.start_time ?? 0
    currentPlaybackTimeRef.current = transcriptTime
    setCurrentPlaybackTime(transcriptTime)
  }, [mediaRef, hasPlayableMedia, offset])

  return {
    isPlaying,
    playbackSpeed,
    currentPlaybackTime,
    segmentsWithTime,
    hasPlayableMedia,
    togglePlayback,
    cyclePlaybackSpeed,
    seekToTime,
    handleTimeSeek,
    seekToSegment,
    isMediaReady,
    isBuffering,
    mediaError,
  }
}
