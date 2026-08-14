import { describe, expect, it } from 'vitest'

import {
  ROUTABLE_SOURCE_KINDS,
  canRouteNoteHit,
  canRouteSegmentHit,
  isRoutableSourceKind,
  noteHitPath,
  segmentHitPath,
} from './search-source'

/**
 * #569 — the deprecation beat expired at the cut after v1.3.0, so the routing
 * decision moved out of SearchPopover (1,192 lines, no test file) into a module
 * that can actually be pinned.
 *
 * What these tests are FOR, beyond the happy paths: the popover's fail-closed
 * whitelist and its click router were the same question asked twice, and the
 * whitelist was silently load-bearing for the router's safety. The pins below are
 * written so that collapsing them back into a catch-all `else` fails.
 */
describe('search hit routing (#569)', () => {
  const PID = 7

  describe('segment hits', () => {
    it('routes a conversation hit through source_id, carrying the highlight term', () => {
      const path = segmentHitPath(PID, { id: 42, source_kind: 'conversation', source_id: 9 }, 'bell')
      expect(path).toBe('/projects/7/conversations/9?segment=42&q=bell')
    })

    it('omits q when there is no search term', () => {
      const path = segmentHitPath(PID, { id: 42, source_kind: 'conversation', source_id: 9 })
      expect(path).toBe('/projects/7/conversations/9?segment=42')
    })

    it('routes a document hit to the DOCUMENT id — the #569 overload is gone', () => {
      // Pre-#569 this id arrived in `conversation_id`. A reader that still went
      // looking for it would now find nothing, which is the point of the retirement.
      const hit = { id: 42, source_kind: 'document', source_id: 5 }
      expect(segmentHitPath(PID, hit)).toBe('/projects/7/documents/5')
      expect(segmentHitPath(PID, hit)).not.toContain('conversations')
    })

    it('routes an observation hit to the clip deep-link', () => {
      const path = segmentHitPath(PID, { id: 42, source_kind: 'observation', source_id: 3 })
      expect(path).toBe('/projects/7/observations/3?clip=42')
    })
  })

  describe('note hits', () => {
    it('routes a conversation note', () => {
      expect(noteHitPath(PID, { source_kind: 'conversation', source_id: 9 }))
        .toBe('/projects/7/conversations/9')
    })

    it('routes a document note to the DOCUMENT id', () => {
      expect(noteHitPath(PID, { source_kind: 'document', source_id: 5 }))
        .toBe('/projects/7/documents/5')
    })

    it('deep-links a clip-anchored observation note, plain otherwise', () => {
      expect(noteHitPath(PID, { source_kind: 'observation', source_id: 3, segment_id: 88 }))
        .toBe('/projects/7/observations/3?clip=88')
      expect(noteHitPath(PID, { source_kind: 'observation', source_id: 3, segment_id: null }))
        .toBe('/projects/7/observations/3')
    })
  })

  describe('fails closed', () => {
    // These are the tests that would have caught the pre-#569 catch-all `else`.
    it('refuses an UNKNOWN kind rather than falling through to /conversations/', () => {
      const hit = { id: 42, source_kind: 'transcript_of_a_dream', source_id: 9 }
      expect(segmentHitPath(PID, hit)).toBeNull()
      expect(noteHitPath(PID, hit)).toBeNull()
    })

    it('refuses a MISSING kind', () => {
      expect(segmentHitPath(PID, { id: 42, source_id: 9 })).toBeNull()
      expect(noteHitPath(PID, { source_id: 9 })).toBeNull()
    })

    it('refuses a null source_id on EVERY kind — never /conversations/null', () => {
      // Pre-#569 only the observation branch checked this; the other two would
      // interpolate the null straight into the path.
      for (const kind of ROUTABLE_SOURCE_KINDS) {
        expect(segmentHitPath(PID, { id: 42, source_kind: kind, source_id: null })).toBeNull()
        expect(noteHitPath(PID, { source_kind: kind, source_id: null })).toBeNull()
      }
    })

    it('never emits the string "null" or "undefined" in a path', () => {
      const suspects = [
        { id: 1, source_kind: 'conversation', source_id: null },
        { id: 1, source_kind: 'document', source_id: undefined },
        { id: 1, source_kind: 'observation', source_id: null },
      ]
      for (const hit of suspects) {
        expect(segmentHitPath(PID, hit) ?? '').not.toMatch(/null|undefined/)
        expect(noteHitPath(PID, hit) ?? '').not.toMatch(/null|undefined/)
      }
    })
  })

  describe('renderability is defined as routability', () => {
    // The invariant the popover used to maintain by hand in a second list.
    it('agrees with the router for every kind, routable or not', () => {
      for (const kind of [...ROUTABLE_SOURCE_KINDS, 'future_kind', undefined]) {
        const seg = { id: 1, source_kind: kind as string, source_id: 4 }
        expect(canRouteSegmentHit(seg)).toBe(segmentHitPath(PID, seg) !== null)
        expect(canRouteNoteHit(seg)).toBe(noteHitPath(PID, seg) !== null)
      }
    })

    it('treats a routable kind with an unusable id as NOT renderable', () => {
      expect(canRouteSegmentHit({ id: 1, source_kind: 'conversation', source_id: null })).toBe(false)
    })
  })

  it('isRoutableSourceKind is exact — no prefix or case slippage', () => {
    expect(isRoutableSourceKind('conversation')).toBe(true)
    expect(isRoutableSourceKind('Conversation')).toBe(false)
    expect(isRoutableSourceKind('conversations')).toBe(false)
    expect(isRoutableSourceKind(undefined)).toBe(false)
    expect(isRoutableSourceKind(null)).toBe(false)
  })
})
