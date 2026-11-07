/**
 * What the analysis page's participant (demographic) filter counts — the words, said ONCE
 * (#1536, D119/D120, 1.5.9).
 *
 * The RULE is the server's, `backend/app/services/participant_filter.py`: a passage counts under
 * the filter only when it reaches a selected participant through its own link — a turn by its
 * speaker, a document by the person it is linked to, a survey answer by its record. An
 * observation names no participant, so its clips are left out while a filter is on. The client
 * re-derives none of it; it only says it.
 *
 * Two charts do not take the filter (D120): the saturation curve (its route takes no participant
 * list) and the Timeline (it draws an observation's clips, which have no participant link).
 * Making either follow it would change saved Canvas embeds with no fingerprint to flag them
 * (`components/canvas/figure-baseline.ts`), so each says so instead.
 */

import type { DemographicFilter } from '@/lib/api'

export const PARTICIPANT_FILTER_RULE =
  'Counts what is linked to the selected participants: interview turns by speaker, documents by '
  + 'the person each is linked to, and survey answers by record. Observations have no participant '
  + 'link, so their clips are left out.'

/** The charts the filter does not reach, and the sentence each shows while a filter is on. */
export const FILTER_NOT_APPLIED = {
  saturation: 'The participant filter does not apply to the saturation curve: it counts every '
    + 'selected source.',
  timeline: 'The participant filter does not apply to the timeline: it draws every clip of the '
    + 'selected observations, which have no participant link.',
} as const

export type FilterNotAppliedChart = keyof typeof FILTER_NOT_APPLIED

/** The sentence for `chartType` while a filter is on, or null (another chart, or no filter). */
export function filterNotAppliedNote(chartType: string, filtered: boolean): string | null {
  if (!filtered) return null
  return Object.prototype.hasOwnProperty.call(FILTER_NOT_APPLIED, chartType)
    ? FILTER_NOT_APPLIED[chartType as FilterNotAppliedChart]
    : null
}

// ── What the filter IS, decided once (#1537, #1538 — D122–D125, 1.6.0) ─────────────────────────
//
// The applied filter is the URL's `pids` — what every request sends. The CHOSEN VALUES that
// produced it live with the page (`useQualitativeAnalysis`'s `filterChoice`), never in the
// *Filters* panel: the panel mounts only while open, so values held there were lost on every
// collapse, and the panel's effect then rewrote the applied list from nothing (#1537). A list
// with no values behind it (a link, a reload, a saved analysis — which stores ids only) is said,
// never cleared; and values that match no one are a state of their own, because the wire has no
// way to say "no one": every reader takes a missing or empty list as no filter (#1538).

/** The chosen values: a demographic variable's subtype → the values chosen in it. */
export type FilterValues = Readonly<Record<string, ReadonlySet<string>>>

/** The page's chosen values, with the list they produced and the project they belong to. */
export interface FilterChoice {
  projectId: number
  values: FilterValues
  /** Sorted; empty when the values match no one. */
  producedIds: readonly number[]
}

export type FilterResolution =
  | { kind: 'none' }
  | { kind: 'ids'; ids: number[] }
  | { kind: 'nobody' }

/** True when at least one value is chosen. */
export function hasChosenValues(values: FilterValues): boolean {
  return Object.values(values).some(set => set.size > 0)
}

/**
 * The participants the values select: a union within a variable, an intersection across
 * variables (the panel's rule since it was written). A chosen value or variable the options no
 * longer list selects no one.
 */
export function resolveFilterValues(
  values: FilterValues, options: readonly DemographicFilter[],
): FilterResolution {
  const active = Object.entries(values).filter(([, set]) => set.size > 0)
  if (active.length === 0) return { kind: 'none' }
  const perVariable = active.map(([subtype, chosen]) => {
    const union = new Set<number>()
    for (const option of options.find(f => f.subtype === subtype)?.values ?? []) {
      if (chosen.has(option.value)) for (const id of option.participant_ids) union.add(id)
    }
    return union
  })
  const ids = [...perVariable[0]]
    .filter(id => perVariable.every(set => set.has(id)))
    .sort((a, b) => a - b)
  return ids.length > 0 ? { kind: 'ids', ids } : { kind: 'nobody' }
}

export type ParticipantFilterState =
  /** No filter is applied. */
  | { kind: 'none' }
  /** Chosen values, and the list they select is the one applied. */
  | { kind: 'values'; values: FilterValues; ids: readonly number[] }
  /** A list no chosen values produced — a link, a reload, a saved analysis (D124). */
  | { kind: 'given'; ids: readonly number[] }
  /** Chosen values no participant holds together: nothing can be read (D125). */
  | { kind: 'nobody'; values: FilterValues }

/**
 * The one decision every surface reads. `choice` is null unless the panel's last act wrote the
 * applied list; every other writer of the list clears it (D123), so it is never compared with
 * the URL — a URL write renders a transition later than the state beside it (BrowserRouter wraps
 * location updates in `startTransition`), and a comparison would read the values as dropped for
 * that one render.
 */
export function participantFilterState(
  choice: FilterChoice | null, projectId: number, appliedIds: readonly number[],
): ParticipantFilterState {
  if (choice && choice.projectId === projectId && hasChosenValues(choice.values)) {
    return choice.producedIds.length > 0
      ? { kind: 'values', values: choice.values, ids: choice.producedIds }
      : { kind: 'nobody', values: choice.values }
  }
  return appliedIds.length > 0 ? { kind: 'given', ids: appliedIds } : { kind: 'none' }
}

/**
 * #1542 — is the applied list exactly the list these values produced? Asked by
 * `useQualitativeAnalysis` only when a NEW LOCATION commits (never on an ordinary render —
 * `url-state.md` §2): a location the hook did not write can carry another list, and the chosen
 * values then no longer describe it (D123).
 */
export function choiceProducedList(choice: FilterChoice, appliedIds: readonly number[]): boolean {
  const produced = choice.producedIds
  return produced.length === appliedIds.length && produced.every((id, i) => id === appliedIds[i])
}

/** True when the filter state applies a participant list — the rule line's condition (D119). */
export function filterApplied(state: ParticipantFilterState): boolean {
  return state.kind === 'values' || state.kind === 'given'
}

/** "Group: X, Y; Site: South" — the chosen values in the options' order, for the D125 notice. */
export function describeFilterValues(values: FilterValues, options: readonly DemographicFilter[]): string {
  const parts: string[] = []
  for (const option of options) {
    const chosen = values[option.subtype]
    if (!chosen || chosen.size === 0) continue
    const named = option.values.map(v => v.value).filter(v => chosen.has(v))
    // A value the options no longer list is still named — it is what the researcher chose.
    for (const v of chosen) if (!named.includes(v)) named.push(v)
    parts.push(`${option.label}: ${named.join(', ')}`)
  }
  return parts.join('; ')
}

/** D124 — the panel's line for a list no chosen values produced. */
export function givenFilterNote(count: number): string {
  return `A filter from a link or a saved analysis keeps ${count} ${count === 1 ? 'participant' : 'participants'}. `
    + 'Its values were not saved with it.'
}

/** D125 — the panel's line under values that match no one. */
export const NO_PARTICIPANT_MATCHES_VALUES = 'No participant has all of these values.'

/** D125 — the analysis area's notice (and the reason every blocked door names). */
export function noParticipantMatchesNotice(described: string): string {
  return described
    ? `No participant matches the chosen filters (${described}).`
    : 'No participant matches the chosen filters.'
}

// ── What a FILE says the filter is (#1545, 1.6.0) ───────────────────────────────────────────────
//
// A file the filter narrows says so on its scope line, beside #499's coders and layer: until
// 1.6.0 a file exported with and without "Group = Y" had the same first line and the same name.
// The server's files take the same words from `backend/app/services/participant_filter.py`
// (`participant_filter_scope_bit`, and `PARTICIPANT_FILTER_RULE` above, pinned equal by
// `test_participant_filter_files_1545.py`); the client's files from `frequencyFileScope`.

/** What a file says about the applied filter: the chosen values in the panel's words when the
 *  page holds them, and how many participants the applied list holds. */
export interface ParticipantFilterFileScope {
  /** `describeFilterValues`' "Group: Y; Site: South", or null for a list no values produced (a
   *  link, a reload, a saved analysis — D124: their values were not saved). */
  label: string | null
  count: number
}

/**
 * The file's description of the filter, or null when no list is APPLIED. Decided from
 * `appliedIds` — the list the request carries — never from the state alone: a file must not
 * claim a filter its numbers lack (#1542: the chosen values outliving a same-route link). The
 * values are named only while they produced exactly that list; otherwise the count stands alone.
 * D125's "no one" applies no list, and every door waits under it.
 */
export function participantFilterFileScope(
  state: ParticipantFilterState, options: readonly DemographicFilter[], appliedIds: readonly number[],
): ParticipantFilterFileScope | null {
  const applied = [...new Set(appliedIds)].sort((a, b) => a - b)
  if (applied.length === 0) return null
  const named = state.kind === 'values'
    && state.ids.length === applied.length && state.ids.every((id, i) => id === applied[i])
  const label = named ? describeFilterValues(state.values, options) || null : null
  return { label, count: applied.length }
}

/** "participant filter: Group: Y (12 participants)" — the server's `participant_filter_scope_bit`,
 *  word for word (the count stands alone when there is no label). */
export function participantFilterScopeBit(scope: ParticipantFilterFileScope): string {
  const count = `${scope.count} ${scope.count === 1 ? 'participant' : 'participants'}`
  const label = scope.label?.trim()
  return label ? `participant filter: ${label} (${count})` : `participant filter: ${count}`
}

/** D125 — what the notice tells the researcher to do, and why a file or a saved analysis waits. */
export const NO_PARTICIPANT_MATCHES_HINT =
  'Change or clear a filter under Filters to see analysis here, export it or add it to Materials.'
