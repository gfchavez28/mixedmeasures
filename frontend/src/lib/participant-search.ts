import type { Participant } from '@/lib/api/participants'

/**
 * Searching and BOUNDING a project's participant list — ONE source (#1045).
 *
 * The list has no natural size. A survey imported with identifier linking
 * creates one participant per record, so the BES file made 122,382 of them, and
 * every surface that drew the whole list drew a node per participant:
 *
 * - the dataset grid's link picker built its option list for all 200 rows of a
 *   page while every picker was CLOSED (JSX children are evaluated when the
 *   parent renders, whether or not a closed popover mounts them) — 1,817 MB and
 *   8.4 s to open a 20,000-participant dataset, and a white window at 122,382;
 * - the Participants page rendered one table row per participant — 25.9 s and
 *   640,162 DOM nodes at 20,000 (#1052);
 * - "Who is this document about?" listed every participant in one dialog.
 *
 * So a surface renders at most `PARTICIPANT_LIST_LIMIT` at a time and SAYS so
 * (`shownOfTotal`) — a list that ends early without saying so lets a researcher
 * conclude they have seen everyone (#844's rule). Search is what reaches the
 * rest, which is why it RANKS: a bounded view of matches in server order can
 * hide the one exact match behind a hundred longer identifiers that merely
 * contain it (typing `123` among numeric ids matches `1123`, `11230`, …).
 */
export const PARTICIPANT_LIST_LIMIT = 200

type SearchKeys = readonly [label: string, identifier: string, role: string]

/**
 * Lower-cased search keys, built once per list. Keyed on the ARRAY: every
 * surface reads the same `['participants', projectId]` cache entry, so the
 * pickers share one build until the list is refetched.
 */
const keyCache = new WeakMap<readonly Participant[], SearchKeys[]>()

function searchKeysFor(participants: readonly Participant[]): SearchKeys[] {
  let keys = keyCache.get(participants)
  if (!keys) {
    keys = participants.map(p => [
      (p.display_name || p.identifier).toLowerCase(),
      p.identifier.toLowerCase(),
      (p.role || '').toLowerCase(),
    ] as const)
    keyCache.set(participants, keys)
  }
  return keys
}

/** 0 = a field equals the term · 1 = starts with it · 2 = contains it · -1 = no match. */
function matchTier(keys: SearchKeys, term: string): number {
  let best = -1
  for (const key of keys) {
    if (key === term) return 0
    if (key.startsWith(term)) best = 1
    else if (best === -1 && key.includes(term)) best = 2
  }
  return best
}

/**
 * The participants a search matches — name (the display name, else the
 * identifier), identifier or role — exact matches first, then prefix matches,
 * then the rest, each tier keeping the server's order. An empty search returns
 * the list itself, unchanged and uncopied.
 */
export function searchParticipants(
  participants: readonly Participant[],
  search: string,
): readonly Participant[] {
  const term = search.trim().toLowerCase()
  if (!term) return participants
  const keys = searchKeysFor(participants)
  const exact: Participant[] = []
  const prefix: Participant[] = []
  const contains: Participant[] = []
  for (let i = 0; i < participants.length; i++) {
    const tier = matchTier(keys[i], term)
    if (tier === 0) exact.push(participants[i])
    else if (tier === 1) prefix.push(participants[i])
    else if (tier === 2) contains.push(participants[i])
  }
  return exact.concat(prefix, contains)
}

/**
 * "Showing the first 200 of 20,000 participants" — the disclosure a bounded
 * list owes. Null when nothing is hidden, so a caller renders nothing.
 */
export function shownOfTotal(shown: number, total: number, searching: boolean): string | null {
  if (total <= shown) return null
  const noun = searching ? 'matching participants' : 'participants'
  return `Showing the first ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`
}

/** The picker form: the disclosure plus what reaches the rest. */
export function pickerLimitNote(shown: number, total: number, searching: boolean): string | null {
  const head = shownOfTotal(shown, total, searching)
  if (head === null) return null
  return searching
    ? `${head}. Keep typing to narrow the list.`
    : `${head}. Type a name or ID to find the others.`
}
