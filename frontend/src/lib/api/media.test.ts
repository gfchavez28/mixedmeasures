/**
 * The media seam's client half.
 *
 * Conversation ids and observation ids are BOTH bare `number`s drawn from
 * independent sequences, so a mis-wired media call would hit a valid but WRONG
 * source — silently streaming, replacing, or deleting the recording of an
 * unrelated row. That is the same collision the on-disk layout prefixes `obs-`
 * to prevent. The owner kind is therefore an explicit argument, and these pin
 * that it actually reaches the URL.
 */
import { describe, it, expect } from 'vitest'
import { mediaApi } from './media'

describe('mediaApi owner-kind routing', () => {
  it('routes a conversation stream to the conversations path', () => {
    expect(mediaApi.getStreamUrl(3, 'conversation', 7)).toBe(
      '/api/projects/3/conversations/7/media/stream',
    )
  })

  it('routes an observation stream to the observations path', () => {
    expect(mediaApi.getStreamUrl(3, 'observation', 7)).toBe(
      '/api/projects/3/observations/7/media/stream',
    )
  })

  it('the SAME id on different kinds resolves to different sources', () => {
    // The whole reason the kind is explicit rather than inferred.
    expect(mediaApi.getStreamUrl(1, 'conversation', 5))
      .not.toBe(mediaApi.getStreamUrl(1, 'observation', 5))
  })

  it('carries the media_version cache token (#549)', () => {
    expect(mediaApi.getStreamUrl(1, 'observation', 5, '123-456')).toBe(
      '/api/projects/1/observations/5/media/stream?v=123-456',
    )
    // No version -> no query string at all (not `?v=undefined`).
    expect(mediaApi.getStreamUrl(1, 'observation', 5)).not.toContain('?')
  })
})
