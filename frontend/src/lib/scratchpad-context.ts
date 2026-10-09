/**
 * Where a scratchpad note was jotted, as the words stored with it (#1002).
 *
 * 🔴 **It is DERIVED from the breadcrumb trail, never from a second list of
 * routes.** The old `contextHintLabel` named eight route shapes and returned
 * "Project overview" for everything else, so a note jotted on a document, an
 * observation, the Codebook, Ratings, Participants, Merge or Coding Import was
 * SAVED as coming from the overview — a stored claim, kept forever. The trail
 * already names every page, and the researcher reads it at the top of the window,
 * so the note now says what the page said.
 *
 * - **"Project overview" only on the overview** — the trail is the project alone
 *   there. Anywhere the trail names nothing more, there is NO hint (`''`) rather
 *   than a wrong one.
 * - **The page's own name joins the trail** when no crumb already carries it —
 *   a canvas names itself only through `setBreadcrumbLabel`.
 * - ⚠️ **Clipped to `CONTEXT_HINT_MAX` code points**, the server's limit
 *   (`schemas/scratchpad.py`): an entity name can itself be 255 characters, and an
 *   over-long hint failed the WHOLE save ("Failed to save") for every jot on that
 *   page.
 * - ⚠️ **Forward-only**: notes jotted before this keep the words they were stored
 *   with ("Conversation: X"); nothing rewrites them.
 */
import type { BreadcrumbSegment } from '@/layouts/breadcrumbs'

/** `ScratchpadEntryCreate.context_hint`'s `max_length` (backend/app/schemas/scratchpad.py). */
export const CONTEXT_HINT_MAX = 255

const SEPARATOR = ' › '

export function scratchpadContextHint(
  crumbs: readonly BreadcrumbSegment[],
  pageLabel: string,
  search: string,
): string {
  // crumbs[0] is the project itself — the note already belongs to the project.
  const trail = crumbs.slice(1).map(c => c.label.trim()).filter(Boolean)
  if (crumbs.length <= 1) return clip('Project overview')
  const page = pageLabel.trim()
  if (page && !trail.includes(page)) trail.push(page)
  // A tab the trail cannot see — kept from the old hint, which named it.
  if (trail[trail.length - 1] === 'Quantitative' && new URLSearchParams(search).get('tab') === 'rc') {
    trail.push('Relationships & Comparisons')
  }
  return clip(trail.join(SEPARATOR))
}

function clip(hint: string): string {
  const points = Array.from(hint)
  return points.length <= CONTEXT_HINT_MAX
    ? hint
    : `${points.slice(0, CONTEXT_HINT_MAX - 1).join('')}…`
}
