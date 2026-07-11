/**
 * Regression tests for usePlayback audio sync.
 *
 * Bug A — playback halted at the first segment boundary: the audio-listener
 * effect listed `selectedSegments`/`onSelectionChange` in its deps, so the
 * cleanup's `audio.pause()` ran every time the playing segment changed.
 *
 * Bug B — clicking a far segment while paused walked the selection back to 0:
 * the manual-selection seek lands `start_time − lead-in`, the resulting
 * `timeupdate` re-selected the (floor) previous segment, re-seeking and
 * cascading. Following is now gated on isPlaying.
 *
 * jsdom has no real HTMLMediaElement, so a minimal fake audio element drives
 * the events the hook listens to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePlayback } from './usePlayback'
import type { Segment, Conversation } from '@/lib/api'

function makeFakeAudio({ duration = NaN }: { duration?: number } = {}) {
  const handlers: Record<string, Set<() => void>> = {}
  return {
    currentTime: 0,
    // Real elements report NaN until metadata loads — the default mirrors that,
    // so the #563 clamp is a no-op for every test that doesn't opt into a length.
    duration,
    playbackRate: 1,
    preservesPitch: false, // hook must set true explicitly
    readyState: 1, // metadata available -> hook marks media ready
    ended: false,
    paused: true,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    addEventListener: (t: string, h: () => void) => {
      ;(handlers[t] ??= new Set()).add(h)
    },
    removeEventListener: (t: string, h: () => void) => {
      handlers[t]?.delete(h)
    },
    emit(t: string) {
      handlers[t]?.forEach((h) => h())
    },
  }
}

const seg = (id: number, start: number, end: number) =>
  ({ id, start_time: start, end_time: end }) as unknown as Segment

const SEGMENTS = [
  seg(1, 0, 8),
  seg(2, 8.5, 17),
  seg(3, 18, 30),
  seg(4, 100, 160), // far segment for Bug B
]

const CONVERSATION = {
  id: 1,
  media_type: 'audio',
  media_filename: 'arellano.mp3',
  media_format: 'mp3',
  media_offset_seconds: 0,
  media_size_bytes: 1234,
  media_version: 'v1-1234',
} as unknown as Conversation

let audio: ReturnType<typeof makeFakeAudio>
beforeEach(() => {
  audio = makeFakeAudio()
})

interface HookProps {
  sel: number[]
  segs: Segment[]
  conv: Conversation
}

function setup(
  selectedSegments: number[],
  opts: { conversation?: Conversation; segments?: Segment[] } = {},
) {
  const onSelectionChange = vi.fn()
  const mediaRef = { current: audio as unknown as HTMLMediaElement }
  let props: HookProps = {
    sel: selectedSegments,
    segs: opts.segments ?? SEGMENTS,
    conv: opts.conversation ?? CONVERSATION,
  }
  const view = renderHook(
    ({ sel, segs, conv }: HookProps) =>
      usePlayback({
        segments: segs,
        selectedSegments: sel,
        onSelectionChange,
        mediaRef,
        conversation: conv,
      }),
    { initialProps: props },
  )
  // Merging rerender: partial prop updates so tests can churn one input
  // (a segments refetch, a conversation payload refetch) in isolation.
  const rerender = (partial: Partial<HookProps>) => {
    props = { ...props, ...partial }
    view.rerender(props)
  }
  return { result: view.result, rerender, onSelectionChange }
}

describe('usePlayback — Bug A: segment boundary must not pause audio', () => {
  it('does not call audio.pause() when the playing segment changes', () => {
    const { result, rerender, onSelectionChange } = setup([1])

    act(() => result.current.togglePlayback())
    expect(audio.play).toHaveBeenCalledTimes(1)
    expect(result.current.isPlaying).toBe(true)

    // Playhead crosses into segment 2 -> hook re-selects seg 2
    act(() => {
      audio.currentTime = 9
      audio.emit('timeupdate')
    })
    expect(onSelectionChange).toHaveBeenLastCalledWith([2])

    // Parent commits the new selection
    act(() => rerender({ sel: [2] }))

    // The audio-owning effect must NOT have been torn down -> no pause()
    expect(audio.pause).not.toHaveBeenCalled()
    expect(result.current.isPlaying).toBe(true)
  })

  it('keeps following the playhead forward across segments', () => {
    const { result, rerender, onSelectionChange } = setup([1])
    act(() => result.current.togglePlayback())

    act(() => {
      audio.currentTime = 9
      audio.emit('timeupdate')
    })
    expect(onSelectionChange).toHaveBeenLastCalledWith([2])
    act(() => rerender({ sel: [2] }))

    act(() => {
      audio.currentTime = 20
      audio.emit('timeupdate')
    })
    expect(onSelectionChange).toHaveBeenLastCalledWith([3])
    expect(audio.pause).not.toHaveBeenCalled()
  })
})

describe('usePlayback — Bug B: paused seek must not cascade selection backward', () => {
  it('does not re-select on the timeupdate caused by a manual seek while paused', () => {
    const { rerender, onSelectionChange } = setup([1])

    // User clicks a far segment (id 4, start 100) while NOT playing
    act(() => rerender({ sel: [4] }))

    // Manual-selection effect seeks audio to start_time − lead-in (1.5)
    expect(audio.currentTime).toBeCloseTo(98.5, 3)

    // That seek fires a timeupdate. While paused it must NOT drag selection.
    act(() => audio.emit('timeupdate'))

    expect(onSelectionChange).not.toHaveBeenCalled()
    // currentTime not walked backward toward 0
    expect(audio.currentTime).toBeCloseTo(98.5, 3)
  })
})

describe('usePlayback — #557: refetch churn must not tear down the media subscription', () => {
  it('a segments refetch (new array identity, same data) never pauses playback', () => {
    const { result, rerender } = setup([1])
    act(() => result.current.togglePlayback())
    expect(result.current.isPlaying).toBe(true)

    // Every code apply invalidates ['segments', cid]; the refetch returns
    // structurally-changed rows -> a brand-new array identity.
    act(() => rerender({ segs: SEGMENTS.map(s => ({ ...(s as object) })) as unknown as Segment[] }))

    expect(audio.pause).not.toHaveBeenCalled()
    expect(result.current.isPlaying).toBe(true)

    // The (single, still-alive) subscription keeps following the playhead.
    act(() => {
      audio.currentTime = 9
      audio.emit('timeupdate')
    })
    expect(result.current.currentPlaybackTime).toBeCloseTo(9, 3)
  })

  it('a sync-offset nudge mid-play never pauses, and timeupdate uses the fresh offset', () => {
    const { result, rerender } = setup([1])
    act(() => result.current.togglePlayback())

    act(() => rerender({ conv: { ...(CONVERSATION as object), media_offset_seconds: 2 } as Conversation }))
    expect(audio.pause).not.toHaveBeenCalled()
    expect(result.current.isPlaying).toBe(true)

    act(() => {
      audio.currentTime = 10
      audio.emit('timeupdate')
    })
    // transcript time = media time - offset, read through the ref
    expect(result.current.currentPlaybackTime).toBeCloseTo(8, 3)
  })
})

describe('usePlayback — #558: pausing must not rewind to the segment start', () => {
  it('pause keeps the intra-segment position after auto-follow', () => {
    const { result, rerender } = setup([1])
    act(() => result.current.togglePlayback())

    // Playhead follows into segment 2 (8.5–17); parent commits the selection.
    act(() => {
      audio.currentTime = 12
      audio.emit('timeupdate')
    })
    act(() => rerender({ sel: [2] }))

    act(() => result.current.togglePlayback()) // pause
    expect(result.current.isPlaying).toBe(false)
    expect(audio.pause).toHaveBeenCalled()
    // Position preserved — NOT seg2.start − lead-in (7.0)
    expect(audio.currentTime).toBeCloseTo(12, 3)
  })

  it('a segments refetch while paused does not re-seek to the selected segment start', () => {
    const { rerender } = setup([2])
    audio.currentTime = 12 // paused mid-segment
    act(() => rerender({ segs: SEGMENTS.map(s => ({ ...(s as object) })) as unknown as Segment[] }))
    expect(audio.currentTime).toBeCloseTo(12, 3)
  })

  it('a manual selection change while paused still seeks with lead-in', () => {
    const { rerender } = setup([1])
    act(() => rerender({ sel: [4] }))
    expect(audio.currentTime).toBeCloseTo(98.5, 3)
  })

  it('a scrub commit stops the element and keeps the precise position', () => {
    const { result, rerender, onSelectionChange } = setup([1])
    act(() => {
      result.current.handleTimeSeek(50)
    })
    // The element actually stops (state alone would desync the button)
    expect(audio.pause).toHaveBeenCalled()
    expect(audio.currentTime).toBeCloseTo(50, 3)
    expect(onSelectionChange).toHaveBeenLastCalledWith([3]) // nearest segment

    // The selection commit must NOT override the scrub with seg3.start − lead-in
    act(() => rerender({ sel: [3] }))
    expect(audio.currentTime).toBeCloseTo(50, 3)
  })
})

describe('usePlayback — element/state sync', () => {
  it('external element pause/play (OS media keys) keeps isPlaying truthful', () => {
    const { result } = setup([1])
    act(() => result.current.togglePlayback())
    expect(result.current.isPlaying).toBe(true)

    act(() => audio.emit('pause'))
    expect(result.current.isPlaying).toBe(false)

    act(() => audio.emit('play'))
    expect(result.current.isPlaying).toBe(true)
  })
})

describe('usePlayback — #549: a replaced recording resets readiness', () => {
  it('a media_version change (same conversation, same filename) drops isMediaReady until the reload', () => {
    const { result, rerender } = setup([1])
    expect(result.current.isMediaReady).toBe(true) // readyState 1 at mount

    // Replace: the element is reloading (src changed via the version param)
    audio.readyState = 0
    act(() =>
      rerender({
        conv: { ...(CONVERSATION as object), media_version: 'v2-999', media_size_bytes: 999 } as Conversation,
      }),
    )
    expect(result.current.isMediaReady).toBe(false)

    act(() => audio.emit('loadedmetadata'))
    expect(result.current.isMediaReady).toBe(true)
  })
})

describe('usePlayback — #551 player half: missing file ≠ codec failure', () => {
  it('element error with media_size_bytes null reports the missing-file message', () => {
    const { result } = setup([1], {
      conversation: { ...(CONVERSATION as object), media_size_bytes: null } as Conversation,
    })
    act(() => audio.emit('error'))
    expect(result.current.mediaError).toMatch(/isn’t on this computer/)
    expect(result.current.mediaError).toMatch(/Replace recording/)
    expect(result.current.mediaError).not.toMatch(/codec/)
  })

  it('element error with the file present keeps the codec message', () => {
    const { result } = setup([1])
    act(() => audio.emit('error'))
    expect(result.current.mediaError).toMatch(/codec/)
  })
})

describe('usePlayback — playback speed (V1 slab 3: 0.5×–2×, natural pitch)', () => {
  it('gates the playback surface via the shared predicate', () => {
    const { result } = setup([1])
    expect(result.current.hasPlayableMedia).toBe(true)
  })

  it('syncs playbackRate to the media element and pins preservesPitch true', () => {
    const { result } = setup([1])
    // Effect ran on mount: rate synced to initial 1×, pitch pinned
    expect(audio.preservesPitch).toBe(true)
    expect(audio.playbackRate).toBe(1)

    act(() => result.current.cyclePlaybackSpeed())
    expect(result.current.playbackSpeed).toBe(1.25)
    expect(audio.playbackRate).toBe(1.25)
  })

  it('cycles through the full range: past 2× wraps to the sub-1× speeds', () => {
    const { result } = setup([1])
    const seen: number[] = [result.current.playbackSpeed]
    for (let i = 0; i < 7; i++) {
      act(() => result.current.cyclePlaybackSpeed())
      seen.push(result.current.playbackSpeed)
    }
    // 1 → 1.25 → 1.5 → 1.75 → 2 → 0.5 → 0.75 → back to 1
    expect(seen).toEqual([1, 1.25, 1.5, 1.75, 2, 0.5, 0.75, 1])
  })
})


// ── #563: a scrub past the end of the recording must not restart at 0:00 ────
//
// The reported bug, exactly: the transcript timeline and the recording are
// INDEPENDENT lengths (a 47-min transcript can carry a 1:53 clip — a partial
// capture, a trimmed file, or the wrong recording attached). Seeking past the
// recording's end asked the element for a time the browser clamps straight to
// `duration`, which leaves it `ended` — and the HTML spec says play() on an
// ended element "seeks to the earliest possible position", i.e. 0:00. The frame
// updated, so the seek LOOKED right, and then Play silently rewound to the top
// and dragged the transcript with it.
describe('usePlayback — #563: seeking past the end of the recording', () => {
  const SHORT_MEDIA = 113.2 // the recording…
  const LONG_TRANSCRIPT = [seg(1, 0, 8), seg(2, 8.5, 17), seg(3, 1060, 1120)] // …vs the transcript

  beforeEach(() => {
    audio = makeFakeAudio({ duration: SHORT_MEDIA })
  })

  it('a scrub beyond the recording never parks the element AT its duration', () => {
    const { result } = setup([], { segments: LONG_TRANSCRIPT })

    act(() => { result.current.seekToTime(1068) }) // deep past the recording's end

    // Parked exactly at duration ⇒ `ended` ⇒ the next play() rewinds to zero.
    expect(audio.currentTime).toBeLessThan(SHORT_MEDIA)
    expect(audio.currentTime).toBeGreaterThan(SHORT_MEDIA - 1)
  })

  it('handleTimeSeek (the scrubber commit) clamps the same way', () => {
    const { result } = setup([], { segments: LONG_TRANSCRIPT })
    act(() => { result.current.handleTimeSeek(1068) })
    expect(audio.currentTime).toBeLessThan(SHORT_MEDIA)
  })

  it('selecting a segment that starts after the recording ends clamps too', () => {
    // Segment 3 starts at 1060s — past the end of a 113s recording.
    const { rerender } = setup([], { segments: LONG_TRANSCRIPT })
    act(() => { rerender({ sel: [3] }) })
    expect(audio.currentTime).toBeLessThan(SHORT_MEDIA)
  })

  it('an IN-RANGE seek is untouched — the clamp must be surgical', () => {
    const { result } = setup([], { segments: LONG_TRANSCRIPT })
    act(() => { result.current.seekToTime(38) })
    expect(audio.currentTime).toBeCloseTo(38, 5)
  })

  it('the offset is applied BEFORE the clamp (a positive offset can push past the end)', () => {
    const conv = { ...CONVERSATION, media_offset_seconds: 10 } as unknown as Conversation
    const { result } = setup([], { segments: LONG_TRANSCRIPT, conversation: conv })
    act(() => { result.current.seekToTime(110) }) // 110 + 10 = 120 > 113.2
    expect(audio.currentTime).toBeLessThan(SHORT_MEDIA)
  })

  it('a media with no known duration yet (NaN) seeks unclamped', () => {
    audio = makeFakeAudio() // duration NaN, as before loadedmetadata
    const { result } = setup([], { segments: LONG_TRANSCRIPT })
    act(() => { result.current.seekToTime(1068) })
    expect(audio.currentTime).toBe(1068)
  })
})


// ── #564: the timeline clock has two drivers ───────────────────────────────
//
// Slice 1 — the playhead STAYS where the researcher put it, past the end of the
// recording (the element, parked at its clamped end, used to keep firing
// `timeupdate` and drag it back).
// Slice 2 — and Play still works out there: the transcript rolls on under an
// interval driver while the video sits parked. A partial recording (the recorder
// died, part of the session wasn't taped, the wrong file got attached) must not
// mean the researcher can't read along in time.
describe('usePlayback — #564: past the end of the recording', () => {
  const SHORT_MEDIA = 113.2
  const LONG_TRANSCRIPT = [seg(1, 0, 8), seg(2, 8.5, 100), seg(3, 1060, 1120)]

  beforeEach(() => {
    audio = makeFakeAudio({ duration: SHORT_MEDIA })
  })

  it('a scrub past the recording detaches the clock', () => {
    const { result } = setup([], { segments: LONG_TRANSCRIPT })
    expect(result.current.isTranscriptOnly).toBe(false)

    act(() => { result.current.handleTimeSeek(1068) })
    expect(result.current.isTranscriptOnly).toBe(true)
  })

  it('the parked element can no longer drag the playhead back (the reported bug)', () => {
    const { result } = setup([], { segments: LONG_TRANSCRIPT })
    act(() => { result.current.handleTimeSeek(1068) })
    expect(result.current.currentPlaybackTime).toBeCloseTo(1068, 5)

    // The element is parked at its clamped end and keeps emitting timeupdate.
    audio.currentTime = SHORT_MEDIA - 0.25
    act(() => { audio.emit('timeupdate') })

    // It must NOT pull the playhead back to the end of the recording.
    expect(result.current.currentPlaybackTime).toBeCloseTo(1068, 5)
  })

  it('scrubbing back INSIDE the recording re-attaches the clock', () => {
    const { result } = setup([], { segments: LONG_TRANSCRIPT })
    act(() => { result.current.handleTimeSeek(1068) })
    expect(result.current.isTranscriptOnly).toBe(true)

    act(() => { result.current.handleTimeSeek(42) })
    expect(result.current.isTranscriptOnly).toBe(false)

    // ...and the element drives the clock again.
    audio.currentTime = 43
    act(() => { audio.emit('timeupdate') })
    expect(result.current.currentPlaybackTime).toBeCloseTo(43, 5)
  })

  it('Play past the recording does NOT roll the parked video', () => {
    const { result } = setup([], { segments: LONG_TRANSCRIPT })
    act(() => { result.current.handleTimeSeek(1068) })
    audio.play.mockClear()

    act(() => { result.current.togglePlayback() })

    expect(result.current.isPlaying).toBe(true)
    expect(audio.play).not.toHaveBeenCalled() // the element stays parked
  })

  it('Play past the recording advances the transcript on its own clock', async () => {
    vi.useFakeTimers()
    try {
      const { result } = setup([], { segments: LONG_TRANSCRIPT })
      act(() => { result.current.handleTimeSeek(1065) })
      act(() => { result.current.togglePlayback() })

      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

      // ~2s of wall clock at 1× ⇒ the timeline moved ~2s. (Timestamp-based, so
      // this also proves it isn't accumulating fixed ticks.)
      expect(result.current.currentPlaybackTime).toBeGreaterThan(1066)
      expect(result.current.currentPlaybackTime).toBeLessThan(1070)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reaching the end of the recording HANDS OVER instead of stopping', () => {
    const { result } = setup([1], { segments: LONG_TRANSCRIPT })
    act(() => { result.current.togglePlayback() })
    expect(result.current.isPlaying).toBe(true)

    // Real playback runs out of recording: the spec fires `pause`, then `ended`.
    audio.ended = true
    act(() => { audio.emit('pause'); audio.emit('ended') })

    // The transcript runs to 1120s, far past the 113s recording — keep going.
    expect(result.current.isPlaying).toBe(true)
    expect(result.current.isTranscriptOnly).toBe(true)
  })

  it('reaching the end STOPS when the transcript ends with the recording', () => {
    // Recording covers the whole transcript — the normal case. Nothing changes.
    const covered = [seg(1, 0, 8), seg(2, 8.5, 100)]
    const { result } = setup([1], { segments: covered })
    act(() => { result.current.togglePlayback() })

    audio.ended = true
    act(() => { audio.emit('pause'); audio.emit('ended') })

    expect(result.current.isPlaying).toBe(false)
    expect(result.current.isTranscriptOnly).toBe(false)
  })

  it('a new media instance re-attaches the clock', () => {
    const { result, rerender } = setup([], { segments: LONG_TRANSCRIPT })
    act(() => { result.current.handleTimeSeek(1068) })
    expect(result.current.isTranscriptOnly).toBe(true)

    const replaced = { ...CONVERSATION, media_version: 'v2-9999' } as unknown as Conversation
    act(() => { rerender({ conv: replaced }) })

    expect(result.current.isTranscriptOnly).toBe(false)
  })
})
