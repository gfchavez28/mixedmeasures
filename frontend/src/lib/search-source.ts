/**
 * Where a search hit navigates — the ONE place a source kind is turned into a route.
 *
 * ## Why this is a module and not two `if` chains in SearchPopover
 *
 * The popover asked the same question twice, in two places that could drift:
 *
 *   1. a fail-closed WHITELIST deciding which kinds may render a row, whose comment
 *      said it exists so "a kind this popover can't navigate must not render a row
 *      that clicks through to /conversations/null"; and
 *   2. an `if / else if / else` deciding where a click GOES, whose final `else`
 *      was a catch-all that would happily build that exact `/conversations/null`.
 *
 * So the whitelist was load-bearing for the router's safety, in a different function,
 * with nothing tying them together. Here the router is the single authority: it
 * returns `null` for anything it cannot route, and renderability is *defined* as
 * "the router returned a path" (`canRouteSegmentHit` / `canRouteNoteHit`). A new
 * source kind is then unrenderable until someone gives it a route — structurally,
 * not by remembering to edit a second list.
 *
 * ## The null-id guard is not defensive padding
 *
 * `source_id` is `number | null` on the wire (its schema default is `None`), and
 * pre-#569 only the observation branch checked it. Once every branch reads
 * `source_id`, an unguarded null is precisely the `/conversations/null` the
 * whitelist was written to prevent — so the check lives here, once, for all kinds.
 *
 * ## #569
 *
 * These take `source_kind` + `source_id` — "the honest pair". They never read
 * `conversation_id`, which until the v1.3.0 beat expired was overloaded with the
 * DOCUMENT id on doc hits and null on observation hits. That field is gone.
 */

/** The source kinds this build can render and route. Anything else fails closed. */
export const ROUTABLE_SOURCE_KINDS = ['conversation', 'document', 'observation'] as const

export type SearchSourceKind = (typeof ROUTABLE_SOURCE_KINDS)[number]

export function isRoutableSourceKind(kind: string | undefined | null): kind is SearchSourceKind {
  return ROUTABLE_SOURCE_KINDS.includes(kind as SearchSourceKind)
}

/** The minimum a hit must carry to be routed. Both search result types satisfy it. */
interface RoutableHit {
  source_kind?: string
  source_id?: number | null
}

interface SegmentHit extends RoutableHit {
  id: number
}

interface NoteHit extends RoutableHit {
  segment_id?: number | null
}

/**
 * The path a SEGMENT hit opens, or `null` when this build cannot route it.
 *
 * `term` rides along to the conversation workbench only — it drives the in-transcript
 * highlight there and has no consumer on the other two surfaces.
 */
export function segmentHitPath(
  projectId: number | string,
  hit: SegmentHit,
  term?: string,
): string | null {
  const kind = hit.source_kind
  const sourceId = hit.source_id
  if (!isRoutableSourceKind(kind) || sourceId == null) return null

  switch (kind) {
    case 'observation':
      // Clip hit → the workbench ?clip= deep-link (D26).
      return `/projects/${projectId}/observations/${sourceId}?clip=${hit.id}`
    case 'document':
      return `/projects/${projectId}/documents/${sourceId}`
    case 'conversation': {
      const params = new URLSearchParams({ segment: String(hit.id) })
      if (term) params.set('q', term)
      return `/projects/${projectId}/conversations/${sourceId}?${params}`
    }
  }
}

/**
 * The path a NOTE hit opens, or `null` when this build cannot route it.
 *
 * Clip-anchored observation notes deep-link to their clip; observation-level notes
 * land on the workbench plain. Conversation and document notes open their source.
 */
export function noteHitPath(projectId: number | string, hit: NoteHit): string | null {
  const kind = hit.source_kind
  const sourceId = hit.source_id
  if (!isRoutableSourceKind(kind) || sourceId == null) return null

  switch (kind) {
    case 'observation': {
      const suffix = hit.segment_id != null ? `?clip=${hit.segment_id}` : ''
      return `/projects/${projectId}/observations/${sourceId}${suffix}`
    }
    case 'document':
      return `/projects/${projectId}/documents/${sourceId}`
    case 'conversation':
      return `/projects/${projectId}/conversations/${sourceId}`
  }
}

/** Renderability IS routability — see the module docblock. */
export const canRouteSegmentHit = (hit: SegmentHit): boolean => segmentHitPath(1, hit) !== null
export const canRouteNoteHit = (hit: NoteHit): boolean => noteHitPath(1, hit) !== null
