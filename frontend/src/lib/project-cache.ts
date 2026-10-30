import type { QueryClient } from '@tanstack/react-query'

/**
 * #1206 — forget every cached project page before showing one.
 *
 * Call it whenever a project's data is REPLACED or a new project may take an old
 * one's id: an overwrite or new-copy import (and its failure — an import the
 * client stopped waiting for may still have finished), a create, a duplicate, a
 * delete, a merge. Call it BEFORE `navigate`, so the page being opened finds
 * nothing cached and asks the server. #1226: and whenever a SOURCE is deleted —
 * source ids are reused too (below).
 *
 * 🔴 **Why every INACTIVE query, and not "the queries keyed on this project id".**
 * SQLite reuses ids (no AUTOINCREMENT), measured on a scratch copy (2026-10-14b):
 * an overwrite of the newest project came back as the SAME project 1 with the same
 * conversation and segment ids, so its Overview and workbench showed the replaced
 * copy with no refetch; delete-then-create reused id 2 and the new project's
 * Overview showed the deleted one's name. And when the project id did NOT repeat,
 * the CONVERSATION ids did — and `['segments', cid]` carries no project id at all
 * (nor `['notes', …]`, `['participant-detail', id]`), so a removal by project id
 * would have left the new project's workbench showing a segment from the old one.
 * On the project list every project page is inactive, so this needs no key
 * convention to be complete. The cost is a first-visit load on each page.
 *
 * ⚠️ **Removed, not invalidated.** An invalidated query still paints its old copy
 * first and refetches after; three are `staleTime: Infinity` and never refetch
 * while observed (TextCodingView auto-saves its config, so it could write the
 * replaced copy's selection onto the new one). ⚠️ **Not a full reload** (a
 * restore's way): that would discard the success toast that names the safety
 * copy, which is the recovery instruction.
 *
 * 🔴 **#1226 — a SOURCE delete is the same door one level down.** Deleting the
 * newest conversation, document, observation or dataset hands its id to the next
 * one created, in the same project or another: `['document', pid, did]` is the
 * new document's key exactly, and `['segments', cid]` / `['notes', cid]` carry
 * no project id at all. DRIVEN (2026-10-15): the re-imported interview's page
 * showed the deleted transcript with no request, and a quote made on it landed
 * on the new interview's passage. So every source delete door calls this — the
 * four list pages in `onSettled` (a delete the client stopped waiting for may
 * still have finished), and the observation wizard after removing its own empty
 * shell. None of them is on the deleted source's own page, so its pages are
 * inactive, which is what the removal needs. The doors are found by what they
 * CALL — `pages/source-delete-forget-cache.test.ts`.
 *
 * `refreshActive` is for a caller INSIDE a project (Merge; a withdrawal, #1474,
 * which deletes and blanks a person's data across every page): the page on screen
 * keeps its queries, and they are invalidated so they refetch rather than removed
 * from under their observers. ⚠️ An invalidated query keeps serving its old data
 * until the refetch lands, so a caller whose page on screen must NOT show the old
 * copy for even that long resets it as well (the withdrawal's canvas, #1320).
 */
export function forgetCachedProjectPages(
  queryClient: QueryClient,
  { refreshActive = false }: { refreshActive?: boolean } = {},
): void {
  queryClient.removeQueries({ type: 'inactive' })
  if (refreshActive) void queryClient.invalidateQueries({ type: 'active' })
}
