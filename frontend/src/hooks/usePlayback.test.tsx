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

function makeFakeAudio() {
  const handlers: Record<string, Set<() => void>> = {}
  return {
    currentTime: 0,
    playbackRate: 1,
    preservesPitch: false, // hook must set true explicitly
    readyState: 1, // metadata available -> hook marks media ready
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
  media_offset_seconds: 0,
} as unknown as Conversation

let audio: ReturnType<typeof makeFakeAudio>
beforeEach(() => {
  audio = makeFakeAudio()
})

function setup(selectedSegments: number[]) {
  const onSelectionChange = vi.fn()
  const mediaRef = { current: audio as unknown as HTMLMediaElement }
  const view = renderHook(
    ({ sel }: { sel: number[] }) =>
      usePlayback({
        segments: SEGMENTS,
        selectedSegments: sel,
        onSelectionChange,
        mediaRef,
        conversation: CONVERSATION,
      }),
    { initialProps: { sel: selectedSegments } },
  )
  return { ...view, onSelectionChange }
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
