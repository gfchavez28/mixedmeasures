/**
 * The words a per-memo control is named from (#912, a11y sweep run 5).
 *
 * A memo list renders N identical "Archive" / "Edit" / "Delete" buttons, and
 * nothing else in the row names which memo each acts on — #891(a)'s shape
 * (thirty Participants rows, ninety controls, none naming the person). So each
 * control's accessible name carries the memo's opening.
 *
 * ⚠️ Named from the SAVED content, never from the field being edited: while a
 * memo is in its editor the actions are not rendered, so the name cannot
 * change under a screen reader on every keystroke (#770's rule). Truncated so
 * the name stays a name rather than a paragraph read aloud.
 */
export const MEMO_PREVIEW_MAX = 40

/**
 * ⚠️ **NOTES share this, and that is deliberate (2026-09-10).** `NotesPanel`
 * renders the same N-identical-controls shape and its archive button had NO
 * accessible name at all — only a `title`, which #559 records as the weakest
 * route and which named no particular note either way. The only thing that
 * differs is the empty-content wording, so that is a parameter rather than a
 * second copy of the truncation rule.
 */
export function memoPreview(
  content: string | null | undefined,
  { max = MEMO_PREVIEW_MAX, empty = 'empty memo' }: { max?: number; empty?: string } = {},
): string {
  const text = (content ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return empty
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
