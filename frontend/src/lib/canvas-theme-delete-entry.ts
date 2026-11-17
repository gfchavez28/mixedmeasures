/**
 * #1301 — the history entry for deleting a canvas theme (or prose section).
 *
 * 🔴 **The inverse restores what the delete DESTROYED** (the internal design notes). It
 * used to capture `{ name, color }` and re-create that, so Ctrl+Z gave back an empty shell at
 * the end of the canvas: the writing and embeds, description, kind, place, parent, links and
 * nesting were gone — and a section holding only prose is deleted with no confirm.
 *
 * Now the DELETE hands out what it destroyed (`ThemeRestoreRecord`, read by the server from
 * the row, so it is never the page's cache, which can trail an autosave), and the undo sends
 * it back to `POST …/themes/restore` — ONE transaction, so it cannot half-land. What the
 * canvas no longer allows (a parent deleted since, a link whose other end is gone, a child
 * re-homed) is REPORTED, never forced and never a reason to drop the step.
 *
 * ⚠️ Every act-time fact is captured here (#1023): the id it acts on (the restore may hand
 * back a new one when SQLite gave the old id to a newer theme), and the canvas and refresh
 * the caller closes `api`/`onChanged` over. Redo deletes again and keeps the FRESH record.
 */
import { toast } from 'sonner'
import type { HistoryAction } from '@/hooks/useHistory'
import type {
  ThemeDeleteResult, ThemeRestoreLost, ThemeRestoreRecord, ThemeRestoreResult,
} from '@/lib/api'

export interface ThemeDeleteEntryApi {
  deleteTheme: (themeId: number) => Promise<ThemeDeleteResult>
  restoreTheme: (record: ThemeRestoreRecord) => Promise<ThemeRestoreResult>
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** The sentences for what a restore could not put back; empty when it all came back. */
export function restoreLostSentences(lost: ThemeRestoreLost): string[] {
  const out: string[] = []
  if (lost.parent) {
    out.push('The section it was nested under has been deleted or nested since, so it is back at the top level.')
  }
  if (lost.children > 0) {
    out.push(`${plural(lost.children, 'section that was nested under it has', 'sections that were nested under it have')} been moved or deleted since, so ${lost.children === 1 ? 'it stays' : 'they stay'} where ${lost.children === 1 ? 'it is' : 'they are'}.`)
  }
  if (lost.relationships > 0) {
    out.push(`${plural(lost.relationships, 'link', 'links')} could not be restored: the section at the other end has been deleted, or the two are linked again.`)
  }
  return out
}

/** What a section holds that makes its delete ask first (`CanvasView`'s confirm). */
export interface ThemeDeleteHolds {
  /** Excerpt, chart and memo embeds — each is a project material, so it stays in the project. */
  materials: number
  /** Callouts — a callout's number lives only in the section, so it leaves with it. */
  callouts: number
  /** Sections nested directly under it. */
  children: number
}

const joinClauses = (parts: string[]): string =>
  parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

/**
 * #1301 D269 — the section delete's confirmation. It is asked only for a section holding
 * materials, callouts or nested sections; a prose-only one is deleted at once, because Ctrl+Z
 * now brings it all back. It used to say the materials "will be permanently deleted" — false
 * twice: an excerpt, chart or memo stays in the project (only its embed leaves this canvas),
 * and the delete is undoable. Each clause is said only when its count is non-zero.
 *
 * ⚠️ A callout is counted apart from the materials: it is not a project material, so "they
 * stay in your project" would be false of it.
 */
export function themeDeleteConfirmText(name: string, holds: ThemeDeleteHolds): string {
  const { materials, callouts, children } = holds
  const contents: string[] = []
  if (materials > 0) contents.push(plural(materials, 'embedded material', 'embedded materials'))
  if (callouts > 0) contents.push(plural(callouts, 'callout', 'callouts'))
  const has: string[] = []
  if (contents.length > 0) has.push(`contains ${contents.join(' and ')}`)
  if (children > 0) has.push(`has ${plural(children, 'nested theme', 'nested themes')}`)
  const does: string[] = []
  if (materials > 0) {
    does.push(materials === 1
      ? 'takes the material off this canvas (it stays in your project)'
      : 'takes the materials off this canvas (they stay in your project)')
  }
  if (callouts > 0) does.push(callouts === 1 ? 'removes the callout with it' : 'removes the callouts with it')
  if (children > 0) does.push(children === 1 ? 'un-nests the theme' : 'un-nests the themes')
  const undo = 'Undo (Ctrl+Z) brings it all back while you stay on the Canvas page.'
  if (has.length === 0) return `"${name}" will be deleted. ${undo}`
  return `"${name}" ${has.join(contents.length > 1 ? ', and ' : ' and ')}. Deleting it ${joinClauses(does)}. ${undo}`
}

export function themeDeleteEntry(opts: {
  themeId: number
  name: string
  api: ThemeDeleteEntryApi
  /** Clear page state that named the deleted theme (its focus). */
  onDeleted: (themeId: number) => void
  /** The caller's refresh, captured at the act. */
  onChanged: () => void
}): HistoryAction {
  const { name, api, onDeleted, onChanged } = opts
  let currentId = opts.themeId
  let record: ThemeRestoreRecord | null = null
  return {
    type: 'canvas_theme_delete',
    description: `Delete theme "${name}"`,
    redo: async () => {
      const res = await api.deleteTheme(currentId)
      record = res.restore
      onDeleted(currentId)
      onChanged()
    },
    undo: async () => {
      // Unreachable — `useHistory` undoes only an entry whose redo succeeded — but a silent
      // return here would move the step to "redo" having restored nothing.
      if (!record) throw new Error('Nothing was recorded to restore')
      const res = await api.restoreTheme(record)
      currentId = res.theme.id
      const lost = restoreLostSentences(res.not_restored)
      if (lost.length > 0) {
        toast.warning(`Restored "${name}", but not everything around it`, { description: lost.join(' ') })
      }
      onChanged()
    },
  }
}
