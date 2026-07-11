/**
 * Playback-utils invariants (V1 slab 3): the single-sourced playback gate,
 * codec-error copy per media type, and the speed range/cycle order.
 */
import { describe, it, expect } from 'vitest'
import {
  SEEK_END_GUARD_SECONDS,
  clampMediaSeek,
  isBeyondRecording,
  recordingEndsAtTimelineTime,
  scrubberPlayheadTime,
  PLAYBACK_SPEEDS,
  codecErrorMessage,
  isMediaFileMissing,
  isPlayableMedia,
  mediaInstanceKey,
  missingMediaMessage,
} from './playback-utils'
import type { Conversation } from '@/lib/api'

const conv = (fields: Partial<Conversation>) => fields as Conversation

describe('isPlayableMedia — THE playback gate', () => {
  it('is true for an audio conversation with a file attached', () => {
    expect(isPlayableMedia(conv({ media_type: 'audio', media_filename: 'a.mp3' }))).toBe(true)
  })

  it('is false without a filename (metadata rows cleared on delete)', () => {
    expect(isPlayableMedia(conv({ media_type: 'audio', media_filename: null }))).toBe(false)
  })

  it('is false with no conversation', () => {
    expect(isPlayableMedia(undefined)).toBe(false)
  })

  it('is true for video since the pane slab (V1 slab 4) flipped the predicate', () => {
    expect(isPlayableMedia(conv({ media_type: 'video', media_filename: 'v.mp4' }))).toBe(true)
  })

  it('is false for video without a filename', () => {
    expect(isPlayableMedia(conv({ media_type: 'video', media_filename: null }))).toBe(false)
  })
})

describe('codecErrorMessage — actionable per media type', () => {
  it('audio copy names audio re-encode targets', () => {
    const msg = codecErrorMessage('audio')
    expect(msg).toContain('audio')
    expect(msg).toContain('MP3')
  })

  it('video copy names the H.264 fix (the HEVC/iPhone case)', () => {
    const msg = codecErrorMessage('video')
    expect(msg).toContain('video')
    expect(msg).toContain('H.264')
  })

  it('null media type falls back to the audio copy', () => {
    expect(codecErrorMessage(null)).toContain('MP3')
  })
})

describe('mediaInstanceKey — THE media-instance identity (#549/#557)', () => {
  const base = {
    id: 7,
    media_type: 'audio',
    media_filename: 'interview.mp3',
    media_format: 'mp3',
    media_version: '100-1234',
  } as Partial<Conversation>

  it("is 'none' for no conversation or unplayable media", () => {
    expect(mediaInstanceKey(undefined)).toBe('none')
    expect(mediaInstanceKey(conv({ media_type: null, media_filename: null }))).toBe('none')
  })

  it('is stable across payload refetches with identical media fields', () => {
    expect(mediaInstanceKey(conv({ ...base }))).toBe(mediaInstanceKey(conv({ ...base })))
  })

  it('changes on a SAME-NAME replace (media_version differs, filename does not)', () => {
    // media_filename stores the user's original upload name — a re-export
    // under the same name is only detectable via the server's mtime+size token.
    const before = mediaInstanceKey(conv({ ...base }))
    const after = mediaInstanceKey(conv({ ...base, media_version: '200-5678' }))
    expect(after).not.toBe(before)
  })

  it('changes across conversations and on remove', () => {
    const a = mediaInstanceKey(conv({ ...base }))
    expect(mediaInstanceKey(conv({ ...base, id: 8 }))).not.toBe(a)
    expect(mediaInstanceKey(conv({ ...base, media_filename: null }))).toBe('none')
  })
})

describe('missing-file detection + copy (#551 player half)', () => {
  it('flags missing only when playable metadata exists but the stat came back null', () => {
    expect(
      isMediaFileMissing(conv({ media_type: 'video', media_filename: 'v.mp4', media_size_bytes: null })),
    ).toBe(true)
    expect(
      isMediaFileMissing(conv({ media_type: 'video', media_filename: 'v.mp4', media_size_bytes: 99 })),
    ).toBe(false)
    expect(isMediaFileMissing(conv({ media_type: null, media_filename: null, media_size_bytes: null }))).toBe(false)
    expect(isMediaFileMissing(undefined)).toBe(false)
  })

  it('missing-file copy points at re-attaching, never at re-encoding', () => {
    const msg = missingMediaMessage('video')
    expect(msg).toContain('video')
    expect(msg).toContain('Replace recording')
    expect(msg).not.toMatch(/codec|H\.264/)
    expect(missingMediaMessage('audio')).toContain('audio')
  })
})

describe('PLAYBACK_SPEEDS — range and cycle order', () => {
  it('spans 0.5×–2× and includes 1×', () => {
    expect(Math.min(...PLAYBACK_SPEEDS)).toBe(0.5)
    expect(Math.max(...PLAYBACK_SPEEDS)).toBe(2)
    expect(PLAYBACK_SPEEDS).toContain(1)
  })

  it('locks the cycle order (array order IS the cycle; the hook starts at 1×, so the first click speeds up and the wrap after 2× reaches the slow speeds)', () => {
    expect(PLAYBACK_SPEEDS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
  })
})


// #563 — the transcript timeline and the recording are independent lengths.
describe('clampMediaSeek — never park the element at its end (#563)', () => {
  it('clamps a seek past the recording to just BEFORE the end', () => {
    const t = clampMediaSeek(1068, 113.2)
    // The exact value matters: landing ON duration makes the element `ended`,
    // and the HTML spec then makes play() seek back to zero — which is the whole
    // bug ("scrub anywhere, press play, start at 0:00").
    expect(t).toBeLessThan(113.2)
    expect(t).toBeCloseTo(113.2 - SEEK_END_GUARD_SECONDS, 5)
  })

  it('leaves an in-range seek exactly alone', () => {
    expect(clampMediaSeek(38.22, 113.2)).toBe(38.22)
    expect(clampMediaSeek(0, 113.2)).toBe(0)
  })

  it('floors a negative target at 0 (a lead-in can push before the start)', () => {
    expect(clampMediaSeek(-1.5, 113.2)).toBe(0)
  })

  it('passes through when the duration is not yet known (NaN before metadata)', () => {
    expect(clampMediaSeek(1068, NaN)).toBe(1068)
    expect(clampMediaSeek(1068, null)).toBe(1068)
    expect(clampMediaSeek(1068, undefined)).toBe(1068)
  })

  it('passes through for a live/unbounded stream (Infinity)', () => {
    expect(clampMediaSeek(1068, Infinity)).toBe(1068)
  })

  it('never returns a negative time for a degenerate duration', () => {
    expect(clampMediaSeek(5, 0.1)).toBe(0)
    expect(clampMediaSeek(5, 0)).toBe(5) // 0/unknown ⇒ no end to guard
  })
})


// #563c — the scrubber marker must show WHERE PLAYBACK IS, not where the selected
// turn begins. It used to fall back to the selected segment's start whenever
// paused; since a paused scrub selects the turn CONTAINING the scrubbed time, the
// marker snapped back to that turn's start the moment you let go.
describe('scrubberPlayheadTime — the marker follows playback, not the selection (#563c)', () => {
  const SEGMENTS = [
    { id: 1, start_time: 0, end_time: 8.215 },
    { id: 2, start_time: 8.215, end_time: 133.095 }, // one long turn
  ] as unknown as Parameters<typeof scrubberPlayheadTime>[2]

  it('shows the real playhead while PAUSED mid-turn (the reported bug)', () => {
    // Scrubbed to 1:02, which lands inside the turn that starts at 0:08.
    // Old behavior: 8.215 (the turn's start) — the marker visibly jumped back.
    expect(scrubberPlayheadTime(62, 2, SEGMENTS)).toBe(62)
  })

  it('shows the real playhead while playing', () => {
    expect(scrubberPlayheadTime(41.5, 2, SEGMENTS)).toBe(41.5)
  })

  it('falls back to the selected turn start ONLY when nothing has played or seeked', () => {
    expect(scrubberPlayheadTime(null, 2, SEGMENTS)).toBe(8.215)
  })

  it('is null when nothing is selected and nothing has played', () => {
    expect(scrubberPlayheadTime(null, null, SEGMENTS)).toBeNull()
  })

  it('is null when the selected segment has no timestamp', () => {
    const untimed = [{ id: 9 }] as unknown as Parameters<typeof scrubberPlayheadTime>[2]
    expect(scrubberPlayheadTime(null, 9, untimed)).toBeNull()
  })

  it('0 is a real playhead position, not "nothing" (falsy-zero)', () => {
    expect(scrubberPlayheadTime(0, 2, SEGMENTS)).toBe(0)
  })
})


// #564 — the timeline and the recording are two clocks. Named for the TIMELINE
// (not the transcript) because a media-only source has a timeline and no
// transcript at all — these are the primitives that track will reuse.
describe('recordingEndsAtTimelineTime / isBeyondRecording (#564)', () => {
  it('the recording covers the timeline up to duration − offset', () => {
    expect(recordingEndsAtTimelineTime(113.2, 0)).toBeCloseTo(113.2, 5)
    // A +10s sync offset means timeline t maps to media t+10, so the last
    // timeline position the recording can reach is 10s EARLIER.
    expect(recordingEndsAtTimelineTime(113.2, 10)).toBeCloseTo(103.2, 5)
    // A negative offset extends the reachable timeline.
    expect(recordingEndsAtTimelineTime(113.2, -5)).toBeCloseTo(118.2, 5)
  })

  it('is null when there is no recording, or none measured yet', () => {
    expect(recordingEndsAtTimelineTime(null)).toBeNull()
    expect(recordingEndsAtTimelineTime(undefined)).toBeNull()
    expect(recordingEndsAtTimelineTime(NaN)).toBeNull()
    expect(recordingEndsAtTimelineTime(Infinity)).toBeNull()
    expect(recordingEndsAtTimelineTime(0)).toBeNull()
  })

  it('flags a timeline position past the end of the recording', () => {
    expect(isBeyondRecording(1547, 113.2)).toBe(true)
    expect(isBeyondRecording(62, 113.2)).toBe(false)
    expect(isBeyondRecording(113.2, 113.2)).toBe(false) // exactly at the end is still ON it
  })

  it('honours the sync offset', () => {
    // Recording is 113.2s; with +20s offset it only reaches timeline 93.2s.
    expect(isBeyondRecording(100, 113.2, 20)).toBe(true)
    expect(isBeyondRecording(90, 113.2, 20)).toBe(false)
  })

  it('with NO recording, nothing is "beyond" it (a transcript-only conversation)', () => {
    expect(isBeyondRecording(9999, null)).toBe(false)
    expect(isBeyondRecording(9999, NaN)).toBe(false)
  })
})
