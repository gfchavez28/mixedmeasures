import type { CodeSegmentsWithContextResponse, CodeTextsResponse } from '@/lib/api'

/** One page of the Content tab's lists — the server's default, and its window per kind. */
export const CONTENT_PAGE_SIZE = 200

/**
 * The Content tab's coded passages, as ONE payload built from the pages loaded
 * so far (#968).
 *
 * *Load more* used to put the limit in the query KEY, so every press was a new
 * query with nothing in hand and the three sections were replaced by a loading
 * notice until it answered — losing the researcher's place. The query is an
 * infinite one now, and its pages are merged here:
 *
 * - **Groups merge by their source id** (a conversation, document or observation
 *   can continue onto the next page), in FIRST-SEEN order.
 * - **Rows de-duplicate by id.** A refetch of an infinite query re-runs the stored
 *   offsets, so a coding added or removed between two pages can shift a row onto
 *   a second page — it must not render twice (React keys collide).
 * - **Totals and `has_more` come from the LAST page** — they describe the whole
 *   selection and are the same on every page, except that the last is newest.
 */
export function mergeContentPages(
  pages: readonly CodeSegmentsWithContextResponse[],
): CodeSegmentsWithContextResponse | undefined {
  if (pages.length === 0) return undefined
  const last = pages[pages.length - 1]
  return {
    ...last,
    conversations: mergeGroups(pages.map(p => p.conversations), g => g.conversation_id),
    documents: mergeGroups(pages.map(p => p.documents ?? []), g => g.document_id),
    observations: mergeGroups(pages.map(p => p.observations ?? []), g => g.observation_id),
  }
}

function mergeGroups<G extends { segment_count: number; segments: { id: number }[] }>(
  lists: readonly (readonly G[])[],
  key: (group: G) => number,
): G[] {
  const byKey = new Map<number, G>()
  const seen = new Set<number>()
  for (const list of lists) {
    for (const group of list) {
      const fresh = group.segments.filter(s => !seen.has(s.id))
      for (const s of fresh) seen.add(s.id)
      if (fresh.length === 0) continue
      const k = key(group)
      const prev = byKey.get(k)
      byKey.set(k, prev ? { ...prev, segments: [...prev.segments, ...fresh] } : { ...group, segments: fresh })
    }
  }
  return [...byKey.values()].map(g => ({ ...g, segment_count: g.segments.length }))
}

/** The Coded Texts list's pages, merged the same way — groups by dataset, rows by value id. */
export function mergeTextPages(pages: readonly CodeTextsResponse[]): CodeTextsResponse | undefined {
  if (pages.length === 0) return undefined
  const last = pages[pages.length - 1]
  const byDataset = new Map<number, CodeTextsResponse['datasets'][number]>()
  const seen = new Set<number>()
  for (const page of pages) {
    for (const ds of page.datasets) {
      const fresh = ds.texts.filter(t => !seen.has(t.dataset_value_id))
      for (const t of fresh) seen.add(t.dataset_value_id)
      if (fresh.length === 0) continue
      const prev = byDataset.get(ds.dataset_id)
      byDataset.set(ds.dataset_id, prev ? { ...prev, texts: [...prev.texts, ...fresh] } : { ...ds, texts: fresh })
    }
  }
  return {
    ...last,
    datasets: [...byDataset.values()].map(ds => ({ ...ds, text_count: ds.texts.length })),
  }
}

/** Rows of one kind loaded so far — the "N" of a section's "Showing N of M". */
export function loadedCount(groups: readonly { segments: readonly unknown[] }[]): number {
  return groups.reduce((n, g) => n + g.segments.length, 0)
}
