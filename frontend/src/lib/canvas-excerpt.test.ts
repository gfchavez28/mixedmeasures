import { describe, it, expect } from 'vitest'
import {
  excerptEmbedAttrs,
  excerptDisplayLabel,
  excerptAttributionLine,
} from './canvas-excerpt'
import type { ExcerptDetailResponse } from '@/lib/api'

function excerpt(over: Partial<ExcerptDetailResponse> = {}): ExcerptDetailResponse {
  return {
    id: 5, segment_id: 2001, dataset_value_id: null,
    start_offset: null, end_offset: null, start_time: null, end_time: null,
    excerpt_text: 'Small-group transition',
    source_kind: 'observation', source_name: 'Classroom',
    conversation_id: null, conversation_name: null,
    observation_id: 7, observation_name: 'Classroom',
    speaker_name: null, segment_timestamp: 65,
    note: null, has_note: false, created_at: '2026-07-18T00:00:00+00:00',
    context_before: null, context_after: null, segment_text: null,
    ...over,
  }
}

describe('excerptEmbedAttrs', () => {
  it('composes clip attribution into sourceContext, not a new attr', () => {
    // Load-bearing: all four export renderers (md/HTML/PDF/docx) read only
    // displayText/sourceContext/materialTag, so attribution shipped as its own
    // attr would be INERT in every export and a clip embed would keep
    // exporting as an empty blockquote.
    expect(excerptEmbedAttrs(excerpt())).toEqual({
      excerptId: 5,
      displayText: 'Small-group transition',
      sourceContext: 'Classroom · 1:05.0',
      conversationId: null,
      observationId: 7,
    })
  })

  it('names the QUOTE’s range for a sub-clip quote', () => {
    const attrs = excerptEmbedAttrs(excerpt({ start_time: 70.5, end_time: 80 }))
    expect(attrs.sourceContext).toBe('Classroom · 1:10.5–1:20.0')
  })

  it('never renders "Empty excerpt" for an unlabeled clip', () => {
    // A clip's excerpt_text is its LABEL and labels are routinely empty, which
    // is exactly what produced the literal "Empty excerpt" on canvas.
    const attrs = excerptEmbedAttrs(excerpt({ excerpt_text: '' }))
    expect(attrs.displayText).toBe('Clip 1:05.0')
  })

  it('carries observationId so the source link can resolve', () => {
    // Without it "View Source" cannot render — it keys on conversationId,
    // which a clip never has.
    expect(excerptEmbedAttrs(excerpt()).observationId).toBe(7)
  })

  it('leaves the conversation shape untouched', () => {
    expect(excerptEmbedAttrs(excerpt({
      observation_id: null, observation_name: null,
      source_kind: 'conversation', source_name: 'Interview 1',
      conversation_id: 3, conversation_name: 'Interview 1',
      excerpt_text: 'we tried that',
    }))).toEqual({
      excerptId: 5,
      displayText: 'we tried that',
      sourceContext: 'Interview 1',
      conversationId: 3,
      observationId: null,
    })
  })
})

describe('the Materials drawer row (#630)', () => {
  // ⚠️ Every case below must use a CLIP fixture. A conversation-only fixture
  // passes before AND after the fix — the same blind spot that kept #616/#620
  // alive and that #629 carries the same rider for.

  it('gives an UNLABELED clip a visible row, not a blank one', () => {
    // The exact repro: excerpt_text '' + no speaker + no conversation, so the
    // old `{excerpt_text}` over `[speaker, conversation]` row rendered "" on
    // BOTH lines — an unidentifiable click target with no accessible name.
    const clip = excerpt({ excerpt_text: '', start_time: 60, end_time: 61 })
    expect(excerptDisplayLabel(clip)).toBe('Clip 1:00.0–1:01.0')
    expect(excerptAttributionLine(clip, { includeSpeaker: true }))
      .toBe('Classroom · 1:00.0–1:01.0')
  })

  it('shows a LABELED clip its label over its observation attribution', () => {
    const clip = excerpt({ start_time: 60, end_time: 61 })
    expect(excerptDisplayLabel(clip)).toBe('Small-group transition')
    expect(excerptAttributionLine(clip, { includeSpeaker: true }))
      .toBe('Classroom · 1:00.0–1:01.0')
  })

  it('still shows the speaker for a conversation excerpt', () => {
    // The drawer has always shown speaker · conversation; the fix must not
    // quietly drop it by reusing the embed's conversation-only attribution.
    const conv = excerpt({
      observation_id: null, observation_name: null,
      source_kind: 'conversation', source_name: 'Interview 1',
      conversation_id: 3, conversation_name: 'Interview 1',
      speaker_name: 'P04', excerpt_text: 'we tried that',
    })
    expect(excerptAttributionLine(conv, { includeSpeaker: true }))
      .toBe('P04 · Interview 1')
  })

  it('keeps the speaker OUT of the embed attribution', () => {
    // Opt-in, deliberately: sourceContext is read by all four export
    // renderers, so including the speaker would change every exported
    // blockquote — well outside #630.
    const conv = excerpt({
      observation_id: null, observation_name: null,
      source_kind: 'conversation', source_name: 'Interview 1',
      conversation_id: 3, conversation_name: 'Interview 1',
      speaker_name: 'P04', excerpt_text: 'we tried that',
    })
    expect(excerptAttributionLine(conv)).toBe('Interview 1')
  })

  it('falls back to a bare range-less clip label', () => {
    const clip = excerpt({ excerpt_text: '', segment_timestamp: null })
    expect(excerptDisplayLabel(clip)).toBe('Clip')
    expect(excerptAttributionLine(clip, { includeSpeaker: true })).toBe('Classroom')
  })
})
