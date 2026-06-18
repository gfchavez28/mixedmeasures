import { useState, useCallback, useRef, useEffect, useMemo, type RefObject } from 'react'
import { type Segment, type Conversation } from '@/lib/api'
import { PLAYBACK_SPEEDS, SEEK_LEAD_IN_SECONDS, findPlayingSegment, findNearestSegment } from '@/lib/playback-utils'

export { PLAYBACK_SPEEDS }

interface UsePlaybackOptions {
  /** Filtered segments (after speaker/text filter) */
  segments: Segment[]
  selectedSegments: number[]
  onSelectionChange: (ids: number[]) => void
  /** Audio element ref — when present and conversation has audio, drives real playback */
  audioRef?: RefObject<HTMLAudioElement | null>
  /** Conversation with media metadata — used for offset and hasAudio detection */
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
  /** Seek audio to a segment's start_time with lead-in buffer */
  seekToSegment: (segment: Segment) => void
  /** True after audio loadedmetadata fires */
  isAudioReady: boolean
  /** True between waiting and playing events */
  isBuffering: boolean
  /** Audio error message, if any */
  audioError: string | null
}

export function usePlayback({
  segments,
  selectedSegments,
  onSelectionChange,
  audioRef,
  conversation,
}: UsePlaybackOptions): UsePlaybackReturn {
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const playbackIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const currentPlaybackTimeRef = useRef<number | null>(null)
  // State mirror of currentPlaybackTimeRef for render (ref is mutated in interval callback)
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState<number | null>(null)
  const [isAudioReady, setIsAudioReady] = useState(false)
  const [isBuffering, setIsBuffering] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)

  // Latest-value refs. The audio-element listener effect below is long-lived
  // (it owns the playing audio). If it depended on `selectedSegments` /
  // `onSelectionChange` / `isPlaying` directly, React would tear it down and
  // re-run it — invoking the cleanup's `audio.pause()` — every time the
  // playing segment changes, halting playback at the first segment boundary
  // (bug: cuts off at segment 2). Reading these through refs keeps the
  // subscription stable for the life of the audio element.
  const selectedSegmentsRef = useRef(selectedSegments)
  selectedSegmentsRef.current = selectedSegments
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying

  const hasAudio = conversation?.media_type === 'audio' && !!conversation?.media_filename
  const offset = conversation?.media_offset_seconds ?? 0

  // Get segments with timestamps sorted by start_time
  const segmentsWithTime = useMemo(() =>
    segments.filter(s => s.start_time !== null && s.start_time !== undefined)
      .sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0)),
    [segments]
  )

  // Reset audio ready state when conversation changes or audio is removed
  useEffect(() => {
    setIsAudioReady(false)
    setAudioError(null)
    setIsBuffering(false)
  }, [conversation?.id, conversation?.media_filename])

  // ── Audio element event listeners ──────────────────────────────────
  useEffect(() => {
    const audio = audioRef?.current
    if (!audio || !hasAudio) return

    const handleTimeUpdate = () => {
      const audioTime = audio.currentTime
      const transcriptTime = audioTime - offset
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
      // broader than what browsers decode — e.g. ALAC .m4a, video .mp4,
      // 24-bit WAV). Be specific so the user isn't confused why an
      // "uploaded" file won't play, and give an actionable fix.
      setAudioError(
        'This audio uploaded, but your browser can’t play this codec. ' +
        'Re-export or convert it to MP3, AAC (.m4a), or 16-bit WAV and re-attach.'
      )
    }

    const handleLoadedMetadata = () => {
      setIsAudioReady(true)
      setAudioError(null)
    }

    const handleWaiting = () => {
      setIsBuffering(true)
    }

    const handlePlaying = () => {
      setIsBuffering(false)
    }

    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('error', handleError)
    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('waiting', handleWaiting)
    audio.addEventListener('playing', handlePlaying)

    // If metadata is already loaded (e.g. cached), set ready immediately
    if (audio.readyState >= 1) {
      setIsAudioReady(true)
    }

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('error', handleError)
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('waiting', handleWaiting)
      audio.removeEventListener('playing', handlePlaying)
      audio.pause()
    }
    // selectedSegments / onSelectionChange / isPlaying are intentionally read
    // via refs (above) — keeping them out of deps keeps this audio-owning
    // subscription stable so a segment change never tears it down + pauses.
  }, [hasAudio, offset, segmentsWithTime, audioRef])

  // ── Text-only simulated playback (interval-based fallback) ─────────
  useEffect(() => {
    // Skip interval-based playback when audio element is handling it
    if (hasAudio) return

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
    // selectedSegments / onSelectionChange read via refs — see audio effect.
  }, [isPlaying, playbackSpeed, segmentsWithTime, segments, hasAudio])

  // Reset playback time when selection changes manually (not during playback)
  // When audio is present, also seek audio to the selected segment with lead-in
  useEffect(() => {
    if (!isPlaying && selectedSegments.length > 0) {
      const selectedSeg = segments.find(s => s.id === selectedSegments[0])
      if (selectedSeg?.start_time !== undefined && selectedSeg?.start_time !== null) {
        currentPlaybackTimeRef.current = selectedSeg.start_time
        setCurrentPlaybackTime(selectedSeg.start_time)

        // Seek audio with lead-in buffer
        const audio = audioRef?.current
        if (audio && hasAudio) {
          const targetTime = selectedSeg.start_time + offset
          const seekTime = Math.max(0, targetTime - SEEK_LEAD_IN_SECONDS)
          audio.currentTime = seekTime // eslint-disable-line react-hooks/immutability -- DOM audio seek
        }
      }
    }
  }, [selectedSegments, segments, isPlaying, audioRef, hasAudio, offset])

  // Sync playback speed to audio element
  useEffect(() => {
    const audio = audioRef?.current
    if (audio && hasAudio) {
      audio.playbackRate = playbackSpeed // eslint-disable-line react-hooks/immutability -- DOM audio rate
    }
  }, [playbackSpeed, hasAudio, audioRef])

  const togglePlayback = useCallback(() => {
    const audio = audioRef?.current

    if (isPlaying) {
      if (audio && hasAudio) {
        audio.pause()
      }
      setIsPlaying(false)
    } else {
      // Gate on audio ready when audio is present
      if (hasAudio && !isAudioReady) return

      if (audio && hasAudio) {
        // If no current time set, start from selection or beginning
        if (selectedSegments.length === 0 && segmentsWithTime.length > 0) {
          onSelectionChange([segmentsWithTime[0].id])
          const startTime = (segmentsWithTime[0].start_time ?? 0) + offset
          audio.currentTime = Math.max(0, startTime) // eslint-disable-line react-hooks/immutability -- DOM audio seek
        }
        audio.play().catch(() => {
          setAudioError(
            'Playback failed — your browser may not support this audio codec. ' +
            'Try converting it to MP3, AAC (.m4a), or 16-bit WAV.'
          )
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
  }, [isPlaying, selectedSegments, segmentsWithTime, onSelectionChange, audioRef, hasAudio, isAudioReady, offset])

  const cyclePlaybackSpeed = useCallback(() => {
    setPlaybackSpeed(current => {
      const currentIndex = PLAYBACK_SPEEDS.indexOf(current)
      const nextIndex = (currentIndex + 1) % PLAYBACK_SPEEDS.length
      return PLAYBACK_SPEEDS[nextIndex]
    })
  }, [])

  const seekToTime = useCallback((time: number) => {
    const audio = audioRef?.current
    if (audio && hasAudio) {
      audio.currentTime = Math.max(0, time + offset) // eslint-disable-line react-hooks/immutability -- DOM audio seek
    }
    setIsPlaying(false)
    currentPlaybackTimeRef.current = time
    setCurrentPlaybackTime(time)
  }, [audioRef, hasAudio, offset])

  const handleTimeSeek = useCallback((time: number): TimeSeekResult | null => {
    const audio = audioRef?.current
    if (audio && hasAudio) {
      audio.currentTime = Math.max(0, time + offset) // eslint-disable-line react-hooks/immutability -- DOM audio seek
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
  }, [segments, onSelectionChange, audioRef, hasAudio, offset])

  const seekToSegment = useCallback((segment: Segment) => {
    const audio = audioRef?.current
    const targetTime = (segment.start_time ?? 0) + offset
    const seekTime = Math.max(0, targetTime - SEEK_LEAD_IN_SECONDS)

    if (audio && hasAudio) {
      audio.currentTime = seekTime // eslint-disable-line react-hooks/immutability -- DOM audio seek
    }

    const transcriptTime = segment.start_time ?? 0
    currentPlaybackTimeRef.current = transcriptTime
    setCurrentPlaybackTime(transcriptTime)
  }, [audioRef, hasAudio, offset])

  return {
    isPlaying,
    playbackSpeed,
    currentPlaybackTime,
    segmentsWithTime,
    togglePlayback,
    cyclePlaybackSpeed,
    seekToTime,
    handleTimeSeek,
    seekToSegment,
    isAudioReady,
    isBuffering,
    audioError,
  }
}
