import type { ExcerptResponse } from '@/lib/api'
import { formatTimecode } from '@/lib/utils'

/**
 * The range an excerpt names, as a timecode string ('' when it has none).
 *
 * A sub-clip quote points at a moment INSIDE the clip; that range is the
 * quote's identity (D29), so it wins over the clip's own start.
 */
export function excerptRangeLabel(e: ExcerptResponse): string {
  if (!e.observation_id) return ''
  return e.start_time !== null
    ? rangeLabel(e.start_time, e.end_time)
    : rangeLabel(e.segment_timestamp, null)
}

/**
 * The text an excerpt displays. Shared by the canvas embed and the Materials
 * drawer (#630) so the clip fallback cannot drift between them.
 *
 * A clip's `excerpt_text` is its LABEL, and labels are routinely empty — a
 * time-range quote carries no text of its own. Without the fallback the embed
 * rendered the literal "Empty excerpt" and the drawer row rendered nothing at
 * all.
 */
export function excerptDisplayLabel(e: ExcerptResponse): string {
  if (e.observation_id) {
    const range = excerptRangeLabel(e)
    return e.excerpt_text?.trim() || (range ? `Clip ${range}` : 'Clip')
  }
  return e.excerpt_text
}

/**
 * The attribution line beneath an excerpt.
 *
 * ⚠️ `includeSpeaker` is deliberately OPT-IN rather than always-on. The canvas
 * embed composes this into `sourceContext`, which all four export renderers
 * read — turning "Conversation" into "Speaker · Conversation" there would
 * silently change every exported blockquote, which is well outside #630. The
 * Materials drawer has always shown the speaker and keeps doing so.
 *
 * A clip has neither speaker nor conversation (its `Segment` parent is an
 * Observation), which is exactly why the drawer's old
 * `[speaker_name, conversation_name]` line rendered empty.
 *
 * ⚠️ #736: this used to ENUMERATE parents — observation, else conversation —
 * and a DOCUMENT quote matched neither, so it returned ''. That blank reached
 * the Materials drawer, the embed's `sourceContext`, and therefore all four
 * export renderers: a document quote exported as an unattributed blockquote.
 * It now reads the RESOLVED `source_name`, which cannot go one parent short.
 * The clip branch survives only to COMPOSE the timecode — `source_name` is
 * deliberately bare, because a per-clip suffix once shattered the quote
 * board's group-by-source into one bucket per clip.
 */
export function excerptAttributionLine(
  e: ExcerptResponse,
  opts: { includeSpeaker?: boolean } = {},
): string {
  const name = e.source_name ?? ''
  if (e.observation_id) {
    const range = excerptRangeLabel(e)
    return range ? `${name} · ${range}` : name
  }
  if (opts.includeSpeaker) {
    return [e.speaker_name, name].filter(Boolean).join(' · ')
  }
  return name
}

/**
 * An excerpt → canvas `excerpt-embed` node attrs (slab 5c).
 *
 * Single-sourced because BOTH insert paths (`handleInsertExcerpt` and
 * `handleInsertPendingItem`) build these, and a clip needs three fields the
 * conversation shape never did.
 *
 * ⚠️ WHY THE ATTRIBUTION IS COMPOSED INTO `sourceContext` rather than shipped as
 * separate `observationName`/`timecodeRange` attrs (which is what the plan's
 * D31 first asked for): all four export renderers — markdown, HTML, PDF
 * (`lib/canvas-export.ts`) and docx (`services/canvas_export.py`) — read ONLY
 * `displayText`, `sourceContext` and `materialTag`. New attrs would therefore
 * be inert in every export, and a clip embed would keep exporting as an empty
 * blockquote with no attribution. Composing into `sourceContext` gets all four
 * exports right for free, and matches the field's existing posture: like
 * `displayText`, it is a preformatted SNAPSHOT taken at insert time, not live
 * data. `observationId` is a real attr because the source LINK must resolve.
 */
export function excerptEmbedAttrs(e: ExcerptResponse): Record<string, unknown> {
  return {
    excerptId: e.id,
    displayText: excerptDisplayLabel(e),
    sourceContext: excerptAttributionLine(e),
    conversationId: e.observation_id ? null : e.conversation_id,
    observationId: e.observation_id ?? null,
  }
}

function rangeLabel(start: number | null, end: number | null): string {
  if (start === null) return ''
  if (end === null || end === start) return formatTimecode(start)
  return `${formatTimecode(start)}–${formatTimecode(end)}`
}
