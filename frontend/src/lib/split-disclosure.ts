/**
 * #712 — what a split did to the notes attached to its quotes.
 *
 * A carried quote is a NEW row and its one-to-one `Note` is deliberately not
 * carried (`ix_notes_excerpt_unique` allows exactly one, so a divided quote
 * could not keep it on both pieces). The note is NOT lost — it stays on the
 * soft-deleted original and an unsplit restores it — but until then it is
 * invisible, and a researcher who splits and sees it gone has no way to know.
 *
 * ⚠️ Disclosed at SPLIT TIME because the link is unrecoverable afterwards:
 * `Excerpt` has no provenance column, the carry clips offsets and dedups on
 * (start, end) so child→source is many-to-one, and the child→original edge is a
 * contiguity heuristic. A per-quote caveat rendered later could only be guessed.
 *
 * Returns null on 0 — a real zero must not nag on every split.
 */
export function describeQuoteNotesStayed(count: number | undefined): string | null {
  if (!count || count < 1) return null
  const subject = count === 1 ? '1 quote note' : `${count} quote notes`
  const object = count === 1 ? 'it' : 'them'
  return `${subject} stayed with the original segment. Undo the split to bring ${object} back.`
}
