/**
 * Row 45 (i) — the reading half of a PARTICIPANT SCORE's stated basis: how a
 * person's many per-passage ratings became the one number in their cell.
 *
 * The ELEVENTH member of the STATED-BASIS FAMILY (the internal design notes):
 * the server states how a number was produced and the client DISPLAYS that,
 * never inferring it from which screen it is rendering.
 *
 * ## Why a participant score needs a basis
 *
 * Two different averages sit one step apart in this pipeline and they are
 * different ACTS, not two settings of one knob:
 *
 *   1. across CODERS, on one passage — the MEDIAN. A *reliability* act: one true
 *      value, coder noise discarded. (`_decide_magnitude`, already shipped.)
 *   2. across PASSAGES, for one participant — the MEAN. A *scoring* act.
 *
 * The design note is blunt about the cost of blurring them: *"naming both
 * 'average magnitude' is how a researcher ends up reporting one as the other."*
 * A future variant — a median at step 2, a rating-weighted mean — must take a
 * NEW value here rather than change what an unchanged column heading means.
 *
 * ## Why the *n* is beside it and not folded in
 *
 * A mean of 3.643 over seven passages and over one are the same number and not
 * the same evidence (#693: *the n is the dangerous half*). The tool writes the
 * *n* as its own variable — `{code} (rated passages)` — so it survives into
 * charts, filters and the R export. `describeParticipantScore` puts both in one
 * sentence for the places that show a single cell.
 *
 * Constants are hand-mirrored with `services/magnitude_rollup.py` — no codegen —
 * so `tests/test_magnitude_rollup_basis.py::TestCrossLanguageContract` reads
 * THIS FILE and fails on drift. TypeScript catches only the opposite direction.
 */

// ── The basis ───────────────────────────────────────────────────────────────

/** Mirrors `MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS`. */
export const MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS = 'mean_of_target_ratings'

export type MagnitudeRollupBasis = typeof MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS

/**
 * Words for each basis.
 *
 * `satisfies Record<…>` is property (b) of the family rule: a basis added to
 * the union without words here is a COMPILE error rather than silence.
 */
const BASIS_WORDS = {
  [MAGNITUDE_ROLLUP_BASIS_MEAN_OF_TARGET_RATINGS]:
    'the mean of this person’s per-passage ratings',
} satisfies Record<MagnitudeRollupBasis, string>

/**
 * How this score was produced, in words.
 *
 * ⚠️ An UNKNOWN basis is reported VERBATIM rather than relabelled or dropped.
 * The family's standing trap is that the client's fallback for an unrecognised
 * value is silence — correct for a payload that predates the field, and
 * invisible for a value a NEWER server sends. Naming it is what makes that
 * visible instead.
 */
export function describeRollupBasis(basis: string | null | undefined): string | null {
  if (!basis) return null
  const known = (BASIS_WORDS as Record<string, string>)[basis]
  return known ?? `computed as ${basis}`
}

// ── The managed column's own vocabulary ─────────────────────────────────────

/** Mirrors `MANAGED_SPEC_KIND_SCORE`. */
export const MANAGED_SPEC_KIND_SCORE = 'magnitude_score'
/** Mirrors `MANAGED_SPEC_KIND_RATED_TARGETS`. */
export const MANAGED_SPEC_KIND_RATED_TARGETS = 'magnitude_rated_targets'

export type ManagedSpecKind =
  | typeof MANAGED_SPEC_KIND_SCORE
  | typeof MANAGED_SPEC_KIND_RATED_TARGETS

/** What a column of this kind HOLDS — the noun, for a heading or a tooltip. */
const KIND_WORDS = {
  [MANAGED_SPEC_KIND_SCORE]: 'rating score',
  [MANAGED_SPEC_KIND_RATED_TARGETS]: 'number of rated passages',
} satisfies Record<ManagedSpecKind, string>

/** The provenance a tool-maintained column carries. Shape mirrors the JSON in
 *  `DatasetColumn.managed_spec`; every field is optional on the wire because an
 *  older payload has none of it. */
export interface ManagedSpec {
  kind?: string
  code_id?: number
  basis?: string
}

export function isManagedColumn(column: { managed_spec?: ManagedSpec | null }): boolean {
  return Boolean(column.managed_spec?.kind)
}

/**
 * One sentence describing a tool-maintained column, for its header tooltip and
 * its accessible description.
 *
 * ⚠️ Returns null for an ordinary column so a caller can render nothing rather
 * than a sentence about a concept that does not apply.
 */
export function describeManagedColumn(
  spec: ManagedSpec | null | undefined,
): string | null {
  if (!spec?.kind) return null
  const noun = (KIND_WORDS as Record<string, string>)[spec.kind]
  if (!noun) {
    // A kind a newer server knows and this build does not. Say so rather than
    // claim it is an ordinary column — the same reason the basis is verbatim.
    return 'A value this tool maintains. Refresh the participant table to update it.'
  }
  const basis = describeRollupBasis(spec.basis)
  const opening = `The ${noun} for this person`
  return basis ? `${opening} — ${basis}.` : `${opening}. Maintained by the tool.`
}

// ── Freshness ───────────────────────────────────────────────────────────────

/**
 * 🔴 **THE HONEST HALF.** A participant table states WHEN it was computed and
 * never that it is up to date.
 *
 * A rating score moves when any of EIGHT input classes changes — a rating, a
 * code application appearing or disappearing, a code's declared scale, code
 * equivalence grouping, any of three participant-link FKs, a speaker's
 * facilitator flag, a segment merge or split, and archiving a coder. The server
 * marks `managed_stale` from the triggers it can enumerate, but **its absence
 * is not evidence of freshness**, so this never renders the words "up to date".
 *
 * Returns null when the table has never been computed — the caller shows the
 * empty state instead, which is a different sentence.
 */
export function describeFreshness(
  dataset: { managed_synced_at?: string | null; managed_stale?: boolean | null },
  now: Date = new Date(),
): { label: string; stale: boolean } | null {
  if (!dataset.managed_synced_at) return null
  const when = new Date(dataset.managed_synced_at)
  if (Number.isNaN(when.getTime())) return null
  const label = `Computed ${relativeTime(when, now)}`
  return { label, stale: Boolean(dataset.managed_stale) }
}

/** Coarse and deliberately so: the exact minute is noise, and the question a
 *  researcher is actually asking is "is this from today's work or last week's?" */
function relativeTime(when: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - when.getTime()) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

// ── What the rollup could not score, and why ────────────────────────────────
//
// 🔴 **Decision 4's disclosure.** The rollup is obliged to SAY what it excluded
// rather than drop it silently — that obligation is why `observation_clip` is a
// named reason at all — and a disclosure that reaches no surface discharges
// nothing. These are the EIGHT reasons: three from `services/magnitude_rollup.py`
// (this module's own decisions) and five from `services/participant_resolution.py`
// (a target that reached nobody, and WHY). They merge into one dict because a
// researcher reads one list, and a test asserts the vocabularies are disjoint so
// a collision cannot silently sum two facts.
//
// ⚠️ Counted at the RATING grain — one coder judgement each — because *"2
// ratings on video clips were not scored"* is the sentence a researcher needs.

/** Mirrors the eight `EXCLUDED_*` / `UNRESOLVED_*` constants. */
export type RollupExclusionReason =
  | 'no_code_consensus'
  | 'facilitator_turn'
  | 'no_declared_scale'
  | 'observation_clip'
  | 'no_speaker'
  | 'speaker_unlinked'
  | 'document_unlinked'
  | 'row_unlinked'

/**
 * Each says what happened AND what the researcher can do about it, except
 * `observation_clip`, which is STRUCTURAL — there is no participant link on an
 * observation to make, so promising one would be a lie. That distinction is the
 * whole reason the resolver reports five reasons instead of one boolean.
 */
const EXCLUSION_WORDS = {
  no_code_consensus: 'the coders did not agree the code applies',
  facilitator_turn: 'the passage is a facilitator’s own turn',
  no_declared_scale: 'the code no longer declares a rating scale',
  observation_clip: 'video clips do not link to a participant',
  no_speaker: 'the passage has no speaker',
  speaker_unlinked: 'the speaker is not linked to a participant',
  document_unlinked: 'the document is not linked to a participant',
  row_unlinked: 'the record is not linked to a participant',
} satisfies Record<RollupExclusionReason, string>

/** Words for one exclusion reason.
 *
 *  ⚠️ An UNKNOWN reason is named verbatim, never dropped — the family's standing
 *  failure is silence on a value a newer server sends. */
export function describeExclusion(reason: string): string {
  return (EXCLUSION_WORDS as Record<string, string>)[reason] ?? reason
}

/** One sentence summarising a refresh, for the toast.
 *
 *  Leads with what LANDED and then with what did not, because both are results:
 *  a refresh that scored nobody and says only "done" is the silent-exclusion
 *  failure Decision 4 exists to prevent.
 */
export function describeRefresh(report: {
  participants_scored: number
  participants_coded_unrated: number
  excluded_ratings: Record<string, number>
  /** #923 — saved metrics deleted with a reaped score column. Optional because a
   *  server that predates the field sends none, and a missing count must read as
   *  "nothing was removed" rather than as `undefined`. */
  metrics_removed?: number
}): string {
  const parts: string[] = []
  const n = report.participants_scored
  parts.push(n === 1 ? 'Scored 1 participant' : `Scored ${n} participants`)

  if (report.participants_coded_unrated > 0) {
    const u = report.participants_coded_unrated
    parts.push(`${u} coded but not yet rated`)
  }

  // #923 — a refresh can DELETE something the researcher built: a chart or test
  // on a score column whose code has since been deleted goes with the column.
  // Everything else in this sentence is about what was computed; this is the one
  // clause about what was destroyed, so it must not be inferable only from
  // `columns_removed`.
  const m = report.metrics_removed ?? 0
  if (m > 0) {
    parts.push(
      `${m} saved metric${m === 1 ? '' : 's'} removed with a score variable whose code is gone`,
    )
  }

  const excluded = Object.entries(report.excluded_ratings ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
  if (excluded.length > 0) {
    const total = excluded.reduce((sum, [, count]) => sum + count, 0)
    const leading = excluded
      .slice(0, 2)
      .map(([reason, count]) => `${count} because ${describeExclusion(reason)}`)
      .join(', ')
    const rest = excluded.length > 2 ? `, and ${excluded.length - 2} other reasons` : ''
    parts.push(
      `${total} rating${total === 1 ? '' : 's'} not counted — ${leading}${rest}`,
    )
  }

  return parts.join(' · ') + '.'
}
