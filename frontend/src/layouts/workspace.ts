// Workspace-tab detection for the TopRail. Kept out of ProjectLayout.tsx so the
// component file stays component-only (Fast Refresh) and this pure function is
// unit-testable in isolation.

export type Workspace =
  | 'overview'
  | 'conversations'
  | 'datasets'
  | 'documents'
  | 'observations'
  | 'analysis'
  | 'none'

/** The project route's first segment → the tab it belongs to. */
const WORKSPACE_BY_SEGMENT: Record<string, Workspace> = {
  overview: 'overview',
  conversations: 'conversations',
  datasets: 'datasets',
  documents: 'documents',
  observations: 'observations',
  analysis: 'analysis',
}

/**
 * 🔴 **An unrecognised route lights NO tab — the default is `'none'`, never
 * `'overview'`.** It used to fall through to Overview, so every standalone page
 * had to opt OUT by name (#428e added Participants and Memos & Notes), and each
 * one added later — Merge, then Coding Import — lit Overview and marked it
 * `aria-current="page"` until somebody noticed. A new page now claims nothing
 * until it is taught which tab it belongs to, which is the safe direction.
 */
export function detectWorkspace(pathname: string): Workspace {
  const segment = pathname.match(/^\/projects\/[^/]+\/([^/]+)/)?.[1]
  // An own-property check, not a bare lookup: `WORKSPACE_BY_SEGMENT['constructor']`
  // is the Object constructor, which is truthy and not a Workspace. (`Object.hasOwn`
  // is ES2022; this project's `lib` is ES2020.)
  return segment && Object.prototype.hasOwnProperty.call(WORKSPACE_BY_SEGMENT, segment)
    ? WORKSPACE_BY_SEGMENT[segment]
    : 'none'
}
