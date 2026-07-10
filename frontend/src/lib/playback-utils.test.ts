/**
 * Playback-utils invariants (V1 slab 3): the single-sourced playback gate,
 * codec-error copy per media type, and the speed range/cycle order.
 */
import { describe, it, expect } from 'vitest'
import {
  PLAYBACK_SPEEDS,
  codecErrorMessage,
  isPlayableMedia,
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
