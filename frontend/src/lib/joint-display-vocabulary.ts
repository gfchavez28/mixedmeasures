/**
 * The joint display's words (ROADMAP row 56) — what the server says, and what the
 * researcher records.
 *
 * Two kinds of vocabulary, in one module so the Compact view, the builder, the drift line and the
 * report table (`lib/joint-display-report.ts` — the Report view and the three exports) all print
 * the SAME words:
 *
 * 1. **The server's (D207)** — the keys `services/joint_display.py` puts on the wire (a strand's
 *    unit and summary, why a between-group number is absent, how a strand formed the groups,
 *    a rated cell's basis, a strand's derived status). `SERVER_VOCABULARY` mirrors the Python
 *    constants by NAME and VALUE, and `backend/tests/test_joint_display_vocabulary.py` reads
 *    this file and holds the two equal, both ways (a key the server adds and the client lacks
 *    would otherwise render as nothing, silently — #855's mirror-nothing-imports lesson in
 *    reverse: here the mirror HAS a reader, the Compact view).
 * 2. **The researcher's (D169, D170, D163)** — fit, a strand's recorded status, the
 *    meta-inference type, a pin's role, how a pin is attributed. Data, not prose: each term has
 *    its label, its definition and its citation, and nothing in the app SUGGESTS one (D169.1:
 *    the fit is the researcher's). No Python twin: no server code reads these (the Word
 *    export's table is the client's, #1406 D5), and a twin nothing imports is #855.
 *
 * The meta-inference definitions are plain-language glosses of Younas, Fàbregues, Munce &
 * Creswell (2025), *Framework for types of metainferences in mixed methods research*, BMC
 * Medical Research Methodology 25:18 (doi 10.1186/s12874-025-02475-8) — CHECKED against its
 * full text at session C (2026-11-12f; the paper's own definitions are in the joint-display
 * record's *Session C as built*). Two corrections came of it: five of the seven glosses had
 * the wrong meaning (*global* is "beyond the samples and populations studied", not "across the
 * whole study"; *comparative* is a surface-level integrated account of the strands, not a
 * comparison of groups), and the five types apply under BOTH levels — "Under global and
 * specific metainferences, researchers can generate any of five subtypes" (D214), where D170
 * had read them as a subdivision of *specific*.
 */

// ── 1. The server's vocabulary (D207) ─────────────────────────────────────────────────

/** 🔴 NAME → VALUE, exactly as `services/joint_display.py` declares them. Python reads this
 *  block; keep it one `NAME: 'value',` per line. */
export const SERVER_VOCABULARY = {
  // #1639 (r1-5): the compute's 404 when the grouping variable is gone (`GROUPING_GONE_TEXT`).
  GROUPING_GONE: 'grouping_gone',
  UNIT_PARTICIPANTS: 'participants',
  SUMMARY_MEAN: 'mean',
  SUMMARY_DISTRIBUTION: 'distribution',
  VARIABLE_NOT_SUMMARISABLE: 'not_summarisable',
  VARIABLE_RATING_WITHHELD: 'rating_withheld_blind',
  EFFECT_NOT_TWO_GROUPS: 'not_two_groups',
  EFFECT_FORMED_GROUPS: 'formed_groups',
  FORMED_BY_GROUPING_VARIABLE: 'grouping_variable',
  FORMED_BY_DERIVATION: 'derived',
  FORMED_BY_MARK: 'marked',
  RATING_CELL_BASIS_MEAN_OF_PARTICIPANT_SCORES: 'mean_of_participant_scores',
  RATING_SCOPE_PROJECT: 'every_rated_passage_in_the_project',
  RATING_NO_SCORES: 'no_scores',
  RATING_NOT_ON_MACHINE_LAYER: 'machine_layer',
  STRAND_COVERS: 'covers',
  STRAND_NOT_MEASURED: 'not_measured',
  // #1659: why a strand is not measured on a row (`by_strand[key].not_measured_reason`).
  STRAND_NOT_MEASURED_NOTHING_BOUND: 'nothing_bound',
  STRAND_NOT_MEASURED_NO_QUESTIONS: 'no_questions',
  STRAND_NOT_MEASURED_BOUND_GONE: 'bound_gone',
  STRAND_NOT_MEASURED_BOUND_INACTIVE: 'bound_inactive',
  STRAND_NOT_MEASURED_BOUND_OTHER_DATASET: 'bound_other_dataset',
  STRAND_NOT_MEASURED_BOUND_UNAVAILABLE: 'bound_unavailable',
  // Joint display slice 2 (r1-1, r1-4): a strand's kind, the observation strand's unit and
  // its clips' provenance (D18), and why a clip carries no rating.
  STRAND_KIND_CODES: 'codes',
  STRAND_KIND_VARIABLES: 'variables',
  STRAND_KIND_OBSERVATION_CODES: 'observation_codes',
  STRAND_KIND_TEXT_CODES: 'text_codes',
  UNIT_OBSERVATIONS: 'observations',
  STRAND_SEGMENTATION_AGREED: 'agreed',
  STRAND_SEGMENTATION_OPEN: 'open',
  STRAND_SEGMENTATION_MIXED: 'mixed',
  RATING_NOT_ON_CLIPS: 'clips_name_no_participant',
  STRAND_DURATION_UNKNOWN: 'duration_unknown',
  STRAND_CLIPS_OPEN_CUTS: 'clips_open_cuts',
  // Joint display slice 2 (D173) — `services/joint_display_cases.py`'s.
  CASE_VALUE_MISSING: 'missing',
  CASE_NO_ROW: 'no_row',
  MISFIT_LISTED_BY_RULE: 'rule',
  MISFIT_LISTED_BY_ADDED: 'added',
  MISFIT_RULE_REFERENCE_MISSING: 'reference_missing',
  MISFIT_RULE_CONDITION_INVALID: 'condition_invalid',
  MISFIT_RULE_CODE_INACTIVE: 'code_inactive',
  MISFIT_RULE_RATING_WITHHELD: 'rating_withheld_blind',
  CASE_OP_LT: 'lt',
  CASE_OP_LE: 'le',
  CASE_OP_GT: 'gt',
  CASE_OP_GE: 'ge',
  CASE_OP_EQ: 'eq',
  CASE_OP_NE: 'ne',
  CASE_OP_IS: 'is',
  CASE_OP_IS_NOT: 'is_not',
  CASE_OP_MISSING: 'missing',
  // Joint display slice 2 (R8, r4-4) — `services/joint_display_pins.py`'s: a pinned quote's
  // source kind, so an answer's attribution can say it is a survey answer.
  PIN_SOURCE_CONVERSATION: 'conversation',
  PIN_SOURCE_DOCUMENT: 'document',
  PIN_SOURCE_OBSERVATION: 'observation',
  PIN_SOURCE_ANSWER: 'answer',
  // #1653 (D346): why the attribution variable (*Also show*) could not be read — `pin-facts`'
  // `column_unusable`; every pin keeps who said it and where (`attributionUnusableNote`).
  PIN_ATTRIBUTION_GONE: 'gone',
  PIN_ATTRIBUTION_INELIGIBLE: 'ineligible',
} as const

const V = SERVER_VOCABULARY

/** How a strand formed the groups (D171) — the row's label, never a block. */
export const FORMED_BY_TEXT: Record<string, string> = {
  [V.FORMED_BY_GROUPING_VARIABLE]: 'is the variable that formed the groups',
  [V.FORMED_BY_DERIVATION]: 'is derived from the variable that formed the groups (or it from this)',
  [V.FORMED_BY_MARK]: 'was marked as the source of the groups',
}

/** D171's sentence, and the threat its help names. */
export const FORMED_GROUPS_NOTE =
  'Its difference between the groups holds by construction, so it is not a finding and gets no between-group statistic here.'
export const FORMED_GROUPS_HELP =
  'Worth checking: groups chosen for extreme scores tend to look less extreme when measured again (regression to the mean).'

/** Why a between-group number is absent — the display's own reasons beside `undefined_stats`'. */
export const EFFECT_ABSENT_TEXT: Record<string, string> = {
  [V.EFFECT_NOT_TWO_GROUPS]: 'A difference is stated between two groups only.',
  [V.EFFECT_FORMED_GROUPS]: FORMED_GROUPS_NOTE,
}

/** A rated cell's basis and scope (D168.2, D204) — said once under the display. #1645: the score
 *  is the person's, from every source, so its line is drawn once under no strand's name — the
 *  sentence says why a strand's line has no rating beside it. */
export const RATING_BASIS_TEXT =
  "A rated cell is the mean of the group's participant scores; each score is over every rated passage of that person in the project, from any source, so a rated line belongs to no one strand and is shown once."
/** #1645 — the tag of a rated code's line (the Compact view) and of its sentence in a group's
 *  cell (the report): the same word a slice-1 display always used, now on every display. */
export const RATED_LINE_TAG = 'Rated'

export const RATING_ABSENT_TEXT: Record<string, string> = {
  [V.RATING_NO_SCORES]: 'Nobody in this group has a score on this code.',
  [V.RATING_NOT_ON_MACHINE_LAYER]: "A machine coder's layer has no ratings to average.",
}

/** A survey variable the display cannot summarise (open text, an identifier). */
export const NOT_SUMMARISABLE_TEXT = 'This variable has no summary here (open text or an identifier).'

/** #1615 — a survey variable worked out from participant scores, while blind (the
 *  participant table's #1608 words). The row's rated codes show the viewer's own ratings. */
export const RATING_WITHHELD_TEXT =
  "Left out while blind: it comes from participant scores, which combine every coder's ratings, so it would show your colleagues' judgements. A rated code shows your own ratings."

/** #1615 — the attribution column comes from participant scores, while blind. */
export function attributionWithheldText(column: string): string {
  return `${column} is left out of the quotes' attribution while blind: it comes from participant scores, which combine every coder's ratings.`
}

/**
 * #1653 (D346) — the *Also show* variable could not be read: gone, or retyped so it cannot form
 * groups. Every pin keeps who said it and where (the whole attribution read failed until #1653,
 * and every quote said "Its attribution could not be read."). Said where D286's note is said —
 * the Compact view's notes and `buildJointDisplayReport`'s note, so every export carries it.
 */
export const ATTRIBUTION_GONE_TEXT =
  'The variable shown beside each quote is not in this project: it was deleted, or not brought in by an import. Each quote still says who said it and where. Edit the display to choose another.'
export function attributionIneligibleText(column: string): string {
  return `“${column}” is no longer shown beside each quote: it is not an ordinal, nominal, binary or demographic variable now. Each quote still says who said it and where.`
}
/** The sentence for `pin-facts`' `column_unusable`, or null when the variable was read. */
export function attributionUnusableNote(
  answer: { column_unusable?: string | null; column_name?: string | null } | null | undefined,
): string | null {
  if (answer?.column_unusable === V.PIN_ATTRIBUTION_GONE) return ATTRIBUTION_GONE_TEXT
  if (answer?.column_unusable === V.PIN_ATTRIBUTION_INELIGIBLE) {
    return attributionIneligibleText(answer.column_name || 'The variable')
  }
  return null
}
/**
 * #1653 (D346) — the builder's *Also show* option for a held variable it cannot offer. ⚠️ Not
 * "no longer in this project": the builder's list (`analysis-columns`) carries no open-text
 * column, so a variable retyped to open text and a deleted one look the same from there — this
 * is true of both. The display's own note (the SERVER's `column_unusable`) says which.
 */
export const ATTRIBUTION_OPTION_UNOFFERED_TEXT = 'A variable that cannot be shown beside a quote'
export function attributionOptionIneligibleText(column: string): string {
  return `${column} (cannot be shown beside a quote)`
}

// ── 2a. Fit (D169) ────────────────────────────────────────────────────────────────────

export interface Term {
  key: string
  label: string
  definition: string
}

export interface FitVocabulary {
  key: 'fetters' | 'farmer'
  label: string
  terms: Term[]
  citation: string
}

const SILENCE: Term = {
  key: 'silence',
  label: 'Silence',
  definition: 'One strand covers it; the other says nothing.',
}

/** The default: Fetters, Curry & Creswell (2013), plus silence in Farmer et al. (2006)'s sense. */
export const FIT_FETTERS: FitVocabulary = {
  key: 'fetters',
  label: 'Confirmation · expansion · discordance · silence',
  terms: [
    { key: 'confirmation', label: 'Confirmation', definition: "The findings from each strand confirm the other's." },
    { key: 'expansion', label: 'Expansion', definition: 'They diverge, but each adds to the picture: different or complementary aspects of one thing.' },
    { key: 'discordance', label: 'Discordance', definition: 'They are inconsistent, contradict or disagree.' },
    SILENCE,
  ],
  citation: 'Fetters, Curry & Creswell (2013), with silence after Farmer et al. (2006).',
}

/** Optional per display: Farmer's convergence coding — built for qualitative datasets. */
export const FIT_FARMER: FitVocabulary = {
  key: 'farmer',
  label: 'Agreement · partial agreement · silence · dissonance',
  terms: [
    { key: 'agreement', label: 'Agreement', definition: 'The strands agree on both the meaning and the prominence of the finding.' },
    { key: 'partial_agreement', label: 'Partial agreement', definition: 'They agree on its meaning or its prominence, not both.' },
    SILENCE,
    { key: 'dissonance', label: 'Dissonance', definition: 'They disagree about its meaning or its prominence.' },
  ],
  citation: "Farmer et al. (2006), built for triangulating qualitative datasets (it compares meaning and prominence); used across methods after O'Cathain, Murphy & Nicholl (2010).",
}

export const FIT_VOCABULARIES = [FIT_FETTERS, FIT_FARMER] as const
export type FitVocabularyKey = FitVocabulary['key']

export function fitVocabulary(key: string | null | undefined): FitVocabulary {
  return key === 'farmer' ? FIT_FARMER : FIT_FETTERS
}

/** A stored fit key, read against the display's vocabulary — null when it is not one of its terms. */
export function fitTerm(vocabulary: FitVocabulary, key: string | null | undefined): Term | null {
  if (!key) return null
  return vocabulary.terms.find(t => t.key === key) ?? null
}

// ── 2b. A strand's status on a row (D169.2) ───────────────────────────────────────────

/** What the RESEARCHER may record; "not measured" is the app's and cannot be chosen. */
export const STRAND_STATUS_RECORDED: Term[] = [
  { key: 'covers', label: 'Covers it', definition: 'The strand has evidence on this construct.' },
  { key: 'silent', label: 'Silent', definition: 'The strand covered the topic and had nothing on it.' },
]
/**
 * Joint display slice 2 (r1-4): why a number on an observation strand is not given. The strand's
 * unit sentences are r2-6's set in §3 (`OBSERVATION_BASIS_TEXT` · `OBSERVATION_CLIPS_*`) — ONE set.
 */
export const OBSERVATION_ABSENT_TEXT: Record<string, string> = {
  duration_unknown: 'No share of observed time: an observation has no recorded duration.',
  clips_open_cuts: 'No clip count: each coder cut their own clips.',
}
/** r1-4: an observation strand draws no rating — the reason, for `RATING_NOT_ON_CLIPS`. */
export const OBSERVATION_RATING_TEXT = 'Ratings are not shown for clips: a rating score belongs to a participant, and a clip names none.'

/**
 * ONE sentence for "not measured" — the Report's note and the overview's note read it (the
 * prototype had "bound to the row" here and "bound to the construct" in the overview; the guided
 * flow's check, kit layer 3, had a third). It says "construct", the word the screen uses for a
 * row. #1659: it said "nothing from this strand is bound to the construct", false whenever the
 * bound code was deleted, merged away or the strand's questions were gone — so it states only
 * what is true in every case, and each place a strand is not measured says WHY
 * (`notMeasuredText`, from the server's reason).
 */
export const STRAND_NOT_MEASURED_TEXT = 'Not measured: nothing from this strand can be shown on the construct; each such place says why.'

/** #1659 — the server's reason (`not_measured_reason`) as the clause after "Not measured: ".
 *  `what` names a code or a variable for the nothing-bound case; the others need no noun. */
export const NOT_MEASURED_REASON_TEXT: Record<string, (what: 'code' | 'variable') => string> = {
  [V.STRAND_NOT_MEASURED_NOTHING_BOUND]: what => `no ${what} bound`,
  [V.STRAND_NOT_MEASURED_NO_QUESTIONS]: () => 'none of its survey questions is in this project',
  [V.STRAND_NOT_MEASURED_BOUND_GONE]: () => 'what it binds is no longer in this project',
  [V.STRAND_NOT_MEASURED_BOUND_INACTIVE]: () => 'what it binds is inactive in the codebook',
  [V.STRAND_NOT_MEASURED_BOUND_OTHER_DATASET]: () => 'what it binds is in another dataset than this strand reads',
  [V.STRAND_NOT_MEASURED_BOUND_UNAVAILABLE]: () => 'nothing it binds can be shown here',
}

/** #1659 — the clause for a strand of `kind`, or null for an unknown or absent reason (then the
 *  place says only "Not measured" — never a guessed cause). */
export function notMeasuredClause(reason: string | null | undefined, kind: string): string | null {
  const text = reason ? NOT_MEASURED_REASON_TEXT[reason] : undefined
  return text ? text(kind === 'variables' ? 'variable' : 'code') : null
}

/** #1659 — "Not measured: <why>" (the Compact view's line, the open construct's). */
export function notMeasuredText(reason: string | null | undefined, kind: string): string {
  const clause = notMeasuredClause(reason, kind)
  return clause ? `Not measured: ${clause}` : 'Not measured'
}

// ── 2c. The meta-inference (D170) ─────────────────────────────────────────────────────

/** Glosses of the paper's definitions, checked against its full text (the module docstring). */
export const META_INFERENCE_LEVELS: Term[] = [
  { key: 'global', label: 'Global', definition: 'A conclusion meant to apply beyond the people and setting studied: to other populations, practice or policy.' },
  { key: 'specific', label: 'Specific', definition: 'A conclusion about the particular people and setting this study examined.' },
]
/** 🔴 D214: offered under EITHER level — the paper's two axes are scope and kind of insight. */
export const META_INFERENCE_TYPES: Term[] = [
  { key: 'relational', label: 'Relational', definition: 'Links inferences from both strands to show how cases, constructs or variables relate.' },
  { key: 'predictive', label: 'Predictive', definition: 'A tentative forecast of events, mechanisms or patterns in what was studied.' },
  { key: 'causal', label: 'Causal', definition: 'Shows a cause-and-effect relationship that both strands support.' },
  { key: 'comparative', label: 'Comparative', definition: 'A surface-level account of how the strands’ findings fit together (confirming, expanding or disagreeing), without deeper synthesis. Also called descriptive.' },
  { key: 'elaborative', label: 'Elaborative', definition: 'A new insight from combining the strands that goes beyond what either says on its face, while staying grounded in the data.' },
]
export const META_INFERENCE_CITATION =
  'Types after Younas, Fàbregues, Munce & Creswell (2025): each of the five applies to a global or a specific conclusion.'

/** "Specific · relational", "Global · causal", "Global", or '' — how a typed meta-inference names its type. */
export function metaInferenceTypeLabel(level: string | null | undefined, type: string | null | undefined): string {
  const lv = META_INFERENCE_LEVELS.find(t => t.key === level)
  if (!lv) return ''
  const sub = META_INFERENCE_TYPES.find(t => t.key === type)
  return sub ? `${lv.label} · ${sub.label.toLowerCase()}` : lv.label
}

export const IMPLICATION_CITATION =
  'An implication column for evaluations, after Monkman et al. (2026): program recommendations organised by logic-model domain.'

// ── 2d. Pins (D163) ───────────────────────────────────────────────────────────────────

export const PIN_ROLES: Term[] = [
  { key: 'typical', label: 'Typical', definition: 'Representative of what this group said.' },
  { key: 'illustrative', label: 'Illustrative', definition: 'Shows the finding vividly, without a claim to be typical.' },
  { key: 'discrepant', label: 'Discrepant', definition: 'Runs against the finding; it says why it is here.' },
]
export type PinRole = 'typical' | 'illustrative' | 'discrepant'

/**
 * Joint display slice 2 (R8, r4-4; L3): a survey answer's source as a pin's attribution names
 * it — "Survey answer (Baseline survey › Comments)". A "Dataset › Column" name alone does not
 * tell a reader the words were written in a questionnaire rather than said.
 */
export function surveyAnswerSourceText(sourceName: string): string {
  return `Survey answer (${sourceName})`
}

/** Joint display slice 2 (r4-5): the pin picker's description — passages AND answers. */
export const PIN_PICKER_DESCRIPTION =
  'Suggestions come from this group’s own coded passages and open-text answers. Pinning saves the whole passage or answer as a quote, so it is on the Quote Board too, and a withdrawal removes it like any other quote.'

export const ATTRIBUTION_MODES = [
  { key: 'participant', label: 'Participant identifier' },
  { key: 'speaker', label: 'Speaker label' },
  { key: 'source', label: 'Source only' },
  { key: 'none', label: 'None' },
] as const
export type AttributionMode = (typeof ATTRIBUTION_MODES)[number]['key']

/** The least identifying label the researcher has is the default (D163.4). */
export const DEFAULT_ATTRIBUTION: AttributionMode = 'participant'

// ── 2e. The case-ordered view and "cases that don't fit" (slice 2, D173) ─────────────

/** r3-4 — each operator as the rule's sentence reads it ("Training hours is less than 24"). */
export const CASE_OPERATOR_TEXT: Record<string, string> = {
  [SERVER_VOCABULARY.CASE_OP_LT]: 'is less than',
  [SERVER_VOCABULARY.CASE_OP_LE]: 'is at most',
  [SERVER_VOCABULARY.CASE_OP_GT]: 'is more than',
  [SERVER_VOCABULARY.CASE_OP_GE]: 'is at least',
  [SERVER_VOCABULARY.CASE_OP_EQ]: 'equals',
  [SERVER_VOCABULARY.CASE_OP_NE]: 'does not equal',
  [SERVER_VOCABULARY.CASE_OP_IS]: 'is',
  [SERVER_VOCABULARY.CASE_OP_IS_NOT]: 'is not',
  [SERVER_VOCABULARY.CASE_OP_MISSING]: 'has no answer',
}

/** Why a case's value is not shown — a cell of the case view, and its export. */
export const CASE_VALUE_ABSENT_TEXT: Record<string, string> = {
  [SERVER_VOCABULARY.CASE_VALUE_MISSING]: 'no answer',
  [SERVER_VOCABULARY.CASE_NO_ROW]: 'not in this dataset',
  [SERVER_VOCABULARY.VARIABLE_NOT_SUMMARISABLE]: 'not shown (open text or an identifier)',
  [SERVER_VOCABULARY.VARIABLE_RATING_WITHHELD]: 'left out while blind',
}

/** A code fact with no material in the strand's sources — "used it?" has no answer. */
export const CASE_NO_MATERIAL_TEXT = 'no material in these sources'
/** #1626 — material, none of it coded under the scope: "did not use" is not yet a finding. */
export const CASE_NOT_CODED_TEXT = 'not coded yet'

/** Why a stated rule selects nothing — said in place of the count, never as "0 match". */
export const MISFIT_RULE_UNAVAILABLE_TEXT: Record<string, string> = {
  [SERVER_VOCABULARY.MISFIT_RULE_REFERENCE_MISSING]:
    'The rule names a code or variable this row no longer binds, so it selects no cases. Edit the rule.',
  [SERVER_VOCABULARY.MISFIT_RULE_CONDITION_INVALID]:
    'A condition of the rule cannot be checked as written, so it selects no cases. Edit the rule.',
  // #1664 (D333): kept and not run — the code's coding was merged elsewhere or set aside.
  [SERVER_VOCABULARY.MISFIT_RULE_CODE_INACTIVE]:
    'The rule names a code the codebook made inactive, so it selects no cases. Edit the rule.',
}

/** #1615 — a condition on a rating-derived variable while blind: named, never dropped. */
export function misfitRuleWithheldText(columns: string[]): string {
  const names = columns.map(c => `“${c}”`).join(', ')
  return `This rule is not checked while blind: ${names} ${columns.length === 1 ? 'comes' : 'come'} ` +
    'from participant scores, which combine every coder\'s ratings, so the cases it selects ' +
    'would show your colleagues\' judgements.'
}

/** r3-2 — what the count says, with the cases the rule cannot check never folded in. */
export function misfitCountText(matched: number, total: number, unknown: number): string {
  const base = `${matched} of ${total} ${total === 1 ? 'case' : 'cases'} ${matched === 1 ? 'meets' : 'meet'} the rule`
  return unknown > 0
    ? `${base}; ${unknown} cannot be checked (a value is missing, or there is no material in the sources).`
    : `${base}.`
}

export const MISFIT_HEADING = 'Cases that don’t fit'
export const MISFIT_RULE_LABEL = 'Rule'
/** r3-12 — the researcher's own changes to the rule's list, each with a reason. */
export const MISFIT_ADDED_LABEL = 'Added by the researcher'
export const MISFIT_REMOVED_LABEL = 'Removed by the researcher'
/** r3-9 — a reason is required; a hand-edited file may lack one. */
export const MISFIT_NO_REASON_TEXT = 'No reason recorded.'
/** D173 — the app never decides misfit; the case view's standing line. */
export const MISFIT_PRINCIPLE_TEXT =
  'Mixed Measures never decides which cases don’t fit: state a rule, and add or remove cases with a reason for each.'
/**
 * r3-13 (Kaiser 2009, deductive disclosure) — shown beside the reason field, and above the
 * list while it holds an added or removed case: the export prints each with its reason.
 */
export const MISFIT_DISCLOSURE_TEXT =
  'The export prints each added or removed case with your reason. Read beside the case’s '
  + 'group and the display’s quotes, a reason can identify someone to a reader who knows the '
  + 'setting — write it so it does not.'
/** r3-13 — the case view's columns, together, can single a person out; said once above it. */
export const CASE_VIEW_DISCLOSURE_TEXT =
  'Each row shows one participant’s group and values together. This view is for your analysis; '
  + 'the export prints only the rule, its count and the cases you added or removed.'

// ── 2f. The case view's controls (joint display slice 2, round 2 — r5) ────────────────
// Every word below is on screen only (the export prints the 2e sentences). Name-sweep strings.

/** r5-2 — the open construct's button, and the dialog it opens (hosted by the page, D213). */
export const CASE_VIEW_OPEN_TEXT = 'Open the case view'
export const caseViewOpenLabel = (construct: string) => `Open the case view for ${construct}`
export const caseViewTitle = (construct: string) => `Cases that don’t fit · ${construct}`
/** The open construct's section with nothing in it yet. */
export const MISFIT_NONE_TEXT = 'No rule stated, and no case added.'
export const MISFIT_COUNT_LOADING_TEXT = 'Counting the cases…'
export const MISFIT_COUNT_FAILED_TEXT = 'The count could not be read.'
/** The export's note when its count read failed — nothing about a case is guessed. */
export const MISFIT_COUNT_UNREAD_TEXT = 'Its count, and who its cases are, could not be read.'

/** r3-12's `only` — which cases the table lists. */
export const CASES_SHOW_LEGEND = 'Show'
export const CASES_SHOW_ALL = 'All cases'
export const CASES_SHOW_LIST = 'The list'
export const CASES_LOADING_TEXT = 'Loading the cases…'
export const CASES_FAILED_TEXT = 'The cases could not be read.'
export const CASES_EMPTY_LIST_TEXT = 'The list is empty: no case meets the rule, and none was added.'
export const CASES_NO_GROUPS_TEXT = 'Nobody has a value of the grouping variable, so there are no cases.'
/** D96 — no viewer to scope a blind read to: no read, and this sentence. */
export const CASES_NO_VIEWER_TEXT = 'The cases were not read: the coder could not be identified while blind mode is on.'
export const casesRangeText = (from: number, to: number, of: number) => `Cases ${from}–${to} of ${of}`
export const CASES_PREVIOUS_TEXT = 'Previous page'
export const CASES_NEXT_TEXT = 'Next page'

/** The table's columns besides the strands' (r3-7: a case is its participant identifier). */
export const CASE_COLUMN_CASE = 'Case'
export const CASE_COLUMN_GROUP = 'Group'
export const CASE_COLUMN_LIST = 'On the list'
export const CASE_COLUMN_ACTION = 'Change the list'
/** A code fact: used / not used / no material (r3-2: unknown is never "no"). */
export const CASE_USED_TEXT = 'used'
export const CASE_NOT_USED_TEXT = 'not used'
/** A survey comments strand's "no material": the person answered none of its questions. */
export const CASE_NO_ANSWER_TEXT = 'did not answer these questions'
export const casePassagesText = (n: number) => `${n} ${n === 1 ? 'passage' : 'passages'}`

/** Where a case stands against the rule and the list. */
export const CASE_LISTED_TEXT = {
  rule: 'Yes — meets the rule',
  added: 'Yes — added by the researcher',
  removed: 'No — removed by the researcher',
  unknown: 'No — the rule cannot check this case',
  no: 'No',
} as const

/** r3-9 — adding or removing a case takes a reason; the row actions and the reason form. */
export const CASE_ADD_TEXT = 'Add…'
export const CASE_REMOVE_TEXT = 'Remove…'
export const caseAddLabel = (who: string) => `Add ${who} to the list`
export const caseRemoveLabel = (who: string) => `Remove ${who} from the list`
export const caseReasonLabel = (action: 'add' | 'remove', who: string) =>
  `Reason for ${action === 'add' ? 'adding' : 'removing'} ${who}`
export const CASE_ADD_CONFIRM_TEXT = 'Add with this reason'
export const CASE_REMOVE_CONFIRM_TEXT = 'Remove with this reason'
export const MISFIT_REASON_REQUIRED_TEXT = 'Write a reason first: each case you add or remove keeps one.'
export const MISFIT_REASON_KEPT_TEXT = 'A reason is required, so the earlier one is kept.'
export const caseUndoLabel = (action: 'add' | 'remove', who: string) =>
  `Undo ${action === 'add' ? 'adding' : 'removing'} ${who}`
export const CASE_UNDO_ADD_TEXT = 'Undo add'
export const CASE_UNDO_REMOVE_TEXT = 'Undo remove'
export const CASE_GONE_TEXT = 'a participant no longer in the project'
export const CASE_OUTSIDE_GROUPS_TEXT = 'no longer in the display’s groups'
export const CASE_NAME_LOADING_TEXT = 'a case (loading its identifier)'
export const CASE_NAME_UNREAD_TEXT = 'a case (its identifier could not be read)'
export const CASE_LIST_NONE_TEXT = 'None.'
export const caseListMaxText = (n: number) => `A list holds up to ${n} cases.`
export const addedOutsideText = (n: number) => n === 1
  ? '1 added case is no longer in the display’s groups, so it is not in the table.'
  : `${n} added cases are no longer in the display’s groups, so they are not in the table.`

/** r3-1 / r3-10 — the rule editor: one condition per line, AND only. */
export const RULE_HEADING = 'Rule'
export const RULE_AND_TEXT = 'Every condition must hold: they are joined by “and”.'
export const RULE_EMPTY_TEXT = 'No rule stated. Add a condition to state one.'
/**
 * #1661 — the DRAFT's sentence while it is edited: a line not yet finished is left out and
 * COUNTED, never printed as `“”` and never dropped unsaid; a draft whose every line is
 * unfinished says so (it once fell back to the SAVED rule's sentence, above lines that no
 * longer held it). Null = no line at all (`RULE_EMPTY_TEXT`). Saving an unfinished line is
 * still refused by `ruleNeedsValueText`.
 */
export const RULE_NONE_FINISHED_TEXT = 'No rule stated yet'
export const ruleUnfinishedText = (n: number) => `${n} ${n === 1 ? 'condition' : 'conditions'} not finished`
export function ruleDraftSentence(finished: string | null, unfinished: number): string | null {
  if (unfinished === 0) return finished
  return `${finished ?? RULE_NONE_FINISHED_TEXT} (${ruleUnfinishedText(unfinished)})`
}
export const RULE_ADD_CONDITION_TEXT = 'Add a condition'
export const RULE_SAVE_TEXT = 'Save rule'
export const RULE_DISCARD_TEXT = 'Discard changes'
export const RULE_CLEAR_TEXT = 'Remove the rule'
export const RULE_GROUP_OPTION = 'The group'
export const RULE_CODE_PRESENT_TEXT = 'used'
export const RULE_CODE_ABSENT_TEXT = 'did not use'
/** A condition this version cannot read (R1 keeps it): shown, sent as it is, never edited. */
export const RULE_UNREADABLE_TEXT = 'A condition this version cannot read'
export const ruleMaxText = (n: number) => `A rule holds up to ${n} conditions.`
export const ruleNeedsValueText = (i: number) => `Condition ${i} needs a value.`
export const ruleFieldLabel = (i: number, field: 'what' | 'group' | 'comparison' | 'value' | 'used') =>
  `Condition ${i}: ${{ what: 'what it checks', group: 'group', comparison: 'comparison', value: 'value', used: 'used or not' }[field]}`
export const ruleRemoveLabel = (i: number) => `Remove condition ${i}`
/** A variable a blind coder cannot filter by (#1615): offered greyed, with the reason. */
export const RULE_WITHHELD_OPTION_SUFFIX = ' (left out while blind)'
/** #1664 (D333): a bound code the codebook made inactive — offered greyed, so a saved condition
 *  naming it still shows what it names (kept, never silently dropped) and a new one cannot. */
export const RULE_INACTIVE_OPTION_SUFFIX = ' (inactive in the codebook)'
// ── 3. Strands (joint display slice 2 — C7) ───────────────────────────────────────────
// ⚠️ The KIND keys ride the compute wire (C1/C2), so r1's Python constants for them join
// `SERVER_VOCABULARY` above with D207's contract test; the words below are the client's (no
// server code prints them — the Word table is the client's, #855).

/** What the builder offers, and how a strand of each kind is described (r2-1, r2-2). */
export const STRAND_KIND_TERMS = [
  { key: 'codes', label: 'Codes', add: 'Add a code strand',
    definition: 'Codes over the conversations and documents you choose. A cell counts participants: speakers and documents linked to a participant.' },
  { key: 'variables', label: 'Survey variables', add: 'Add a survey strand',
    definition: "Variables of one dataset linked to participants. A cell summarises the linked participants' own values." },
  { key: 'text_codes', label: 'Survey comments', add: 'Add a survey comments strand',
    definition: "Codes on the answers to the open-text survey questions you choose. A cell counts the participants whose answer carries the code, out of those in the group who answered." },
  { key: 'observation_codes', label: 'Observation codes', add: 'Add an observation strand',
    definition: 'Codes on the clips of the observations you choose. Observations are not linked to participants, so this strand stands beside the groups.' },
] as const

/** The implicit pair's tags (a slice-1 display) — slice 1's own words, unchanged. */
export const IMPLICIT_STRAND_TAG = { codes: 'Coded', variables: 'Survey' } as const

/** r2-2 — a named strand left without a name (an import, a hand-edited file). */
export const UNNAMED_STRAND_TAG = { codes: 'Codes', variables: 'Survey', observation_codes: 'Observations', text_codes: 'Survey comments' } as const

/** r4's note sentence for an open-text strand (O'Cathain & Thomas 2004: commenters may differ). */
export const TEXT_CODES_BASIS_TEXT =
  'An open-text count is the participants whose answer to these questions carries the code, out of those in the group who answered them; an answer the project treats as empty, such as “N/A”, is not an answer. People who write comments may differ from those who do not, so each group also shows how many were surveyed.'

/** r2-11 (r4's found-beside #4) — the bases the Compact footer and the report note BOTH print. */
export const CODED_COUNT_BASIS_TEXT =
  'A coded count is the participants with at least one coded passage, out of those in the group with material in the chosen sources; interviewer turns are left out by speaker role.'
export const SURVEY_CELL_BASIS_TEXT =
  "A survey cell summarises each linked participant's own value: the mean (SD) and n of a numeric or ordinal variable, or the categories present for a categorical one."

/** r2-12 — the builder's question list for an open-text strand. */
export const TEXT_STRAND_QUESTIONS_LABEL = 'Questions'

/** r2-6 — the observation strand's line and its sentence (Compact, Report, the note). */
/** r2-6 — the Compact line's short form (the open construct and the note carry the reason). */
export const OBSERVATION_LINE_TEXT = 'drawn once across the groups, not split by group'
export const OBSERVATION_BESIDE_TEXT =
  'Observations are not linked to participants, so this strand is drawn once across the groups and never split by group.'

/** r2-3 — how a fit names the pair it compares (Compact, Report, the export): "Interviews · Survey". */
export function fitPairText(a: string, b: string): string {
  return `${a} · ${b}`
}
/** r2-3, shape (ii): the open construct's help under its pairs (L1: fit is defined over a pair). */
export const FIT_PAIR_HELP =
  'A fit compares two strands. Record one for each pair you compare; each strand also shows whether it has evidence here.'
/** r2-8 — DERIVED, never chosen: neither strand of the pair has data on the construct (Tonkin-Crine et al. 2016's "not applicable", never silence). */
export const PAIR_NOT_APPLICABLE_LABEL = 'Not applicable'
export const PAIR_NOT_APPLICABLE_TEXT = 'Not applicable: neither strand has evidence on this construct, so there is no fit to record.'
export const ADD_FIT_PAIR_TEXT = 'Compare another pair'

/**
 * r2-4 — the BUILDER's limit (layout and cost; a builder rule, so raising it changes no file).
 * R13: not the server's request bound (`schemas/joint_display.py::MAX_STRANDS_PER_REQUEST`, 8) —
 * two constants, two names.
 */
export const MAX_STRANDS_IN_BUILDER = 4
export const STRAND_LIMIT_TEXT = `A display holds up to ${MAX_STRANDS_IN_BUILDER} strands.`
/**
 * Joint display slice 2 (round-2 combine, Q6): the server's cap on what a construct binds from ONE
 * strand — its codes, or its variables (`schemas/joint_display.py::MAX_IDS_PER_STRAND`). Past it
 * the builder offers no more and says why; the compute would refuse the 51st ("could not be computed").
 */
export const MAX_IDS_PER_BINDING = 50
export const BINDING_LIMIT_TEXT = `A construct holds up to ${MAX_IDS_PER_BINDING} codes or variables from each strand. Clear one to choose another.`
/** The same server cap on a survey comments strand's questions (`text_column_ids`): a 51st 422'd the display. */
export const STRAND_QUESTIONS_LIMIT_TEXT = `A survey comments strand holds up to ${MAX_IDS_PER_BINDING} questions. Clear one to choose another.`

// ── #1644 review (r3): the server's bounds the builder mirrors ───────────────────────────────
/**
 * r3-3 — the server's cap on a display's rows (`schemas/joint_display.py::MAX_DISPLAY_ROWS`): a
 * 101st construct made the whole display fail to compute, as a 51st code did before D317. Held to
 * the server by `test_joint_display_vocabulary.py::test_the_client_limits_are_the_servers`.
 * (r3-1: a strand's chosen SOURCES have no copy here — the server's bound on them is SQL's, not a
 * choice's, and no list a person ticks reaches it.)
 */
export const MAX_CONSTRUCTS = 100
export const CONSTRUCT_LIMIT_TEXT = `A display holds up to ${MAX_CONSTRUCTS} constructs. Remove one to add another.`

/** r2-6 — the observation strand's basis in the note (the literature's L2; r1 computes it). */
export const OBSERVATION_BASIS_TEXT =
  "An observation cell gives the observations with at least one clip coded with the code, out of the strand's observations, and the coded time as a share of the observed time. It never counts participants."
export const OBSERVATION_CLIPS_OPEN_TEXT =
  "Clips are not counted while each coder cuts their own: splitting one stretch into two clips would double a count. They are counted once the observation's clips are agreed."
export const OBSERVATION_CLIPS_AGREED_TEXT =
  "Clips are counted because the observations' clips were agreed (their segmentation is frozen)."
/**
 * R6 — some observations' clips agreed and some not (`segmentation: 'mixed'`): r1's compute counts
 * clips in the AGREED observations only, and the sentence says so.
 */
export function observationClipsMixedText(agreed: number, chosen: number): string {
  return `Clips are counted in the ${agreed} of ${chosen} observations whose clips were agreed; the others' clips are not counted, because each coder cut their own.`
}

/** r2-9 — the Report's overview of strands by construct (ePIP's write-up table, Gauly et al. 2024). */
export const STRAND_OVERVIEW_TITLE = 'Strands by construct: identified or not identified'
export const STRAND_OVERVIEW_CELL = { covers: 'Identified', silent: 'Not identified (silent)', not_measured: 'Not identified (not measured)' } as const
export const STRAND_OVERVIEW_NOTE =
  `After the extended Pillar Integration Process (Gauly, Ulahannan & Grove 2024): which strands have evidence on each construct. Silent: the researcher recorded that the strand covered the topic and had nothing on it. ${STRAND_NOT_MEASURED_TEXT}`

// ── The builder: a failed list, a strand's removal (joint display slice 2, round 2 — r6) ──

/** r6-10 — the builder: removing a strand that recorded fits name (`fitsNamingStrand`). */
export function strandRemovalWarningText(strand: string, fits: number): string {
  return `Removing ${strand} also removes ${fits} recorded ${fits === 1 ? 'fit that compares' : 'fits that compare'} it with another strand. The meta-inferences stay as written.`
}
/**
 * A dialog's change whose display left the canvas while it was open (`DisplayDialogHost`'s
 * `commitDisplay` found no live view) — in the vocabulary module, as every sentence the display
 * says is (the build moved it out of the host; the guided flow, kit layer 3, had its own copy).
 */
export const DISPLAY_NOT_LIVE_TEXT = 'The joint display is no longer on this canvas, so the change was not made.'
/**
 * #1639 follow-up (r1-8) — a bound code the codebook made inactive is left out of the numbers,
 * as every analysis view leaves it out, and the display says which and why: a merged code has
 * no coding of its own (the merge moved it), and drawing it showed 0 in every group.
 */
export const inactiveCodeText = (c: { name: string; merged_into_name: string | null }) => c.merged_into_name
  ? `“${c.name}” was merged into “${c.merged_into_name}”, so it has no coding of its own to show here. Edit the row to bind “${c.merged_into_name}”.`
  : `“${c.name}” is inactive in the codebook, so it is left out here, as in the rest of the analysis. Reactivate it in the codebook, or edit the row.`
/**
 * #1639 (r1-5) — the variable that formed the groups is not here: the compute's 404 for it
 * (`GROUPING_GONE`: deleted — with D319's AUTOINCREMENT its id is never anyone else's) and a
 * stored null (D202: an import could not carry it; the builder never saves a display without
 * one, so a null is never "not chosen yet"). One sentence for both, since neither says which.
 */
export const GROUPING_GONE_TEXT =
  'The variable that formed this display’s groups is not in this project: it was deleted, or not brought in by an import. Edit the display to choose another.'
/**
 * #1665 (D336) — bound variables of another dataset than their survey strand reads (D205). They
 * are in the project, so they are never counted under "no longer in this project".
 */
export const otherDatasetVariablesText = (n: number) =>
  `${n} bound ${n === 1 ? 'variable is' : 'variables are'} from another dataset than ${n === 1 ? 'its' : 'their'} survey strand reads, so ${n === 1 ? 'it is' : 'they are'} left out. Edit the row.`
/**
 * #1665 (D335) — changing a survey strand's dataset starts the strand over (D205), so the builder
 * asks first when constructs have chosen its variables. The safe choice keeps the dataset.
 */
export const strandDatasetChangeWarningText = (constructs: number) =>
  `Changing the dataset removes the variables ${constructs} ${constructs === 1 ? 'construct' : 'constructs'} chose for this strand.`
export const strandDatasetKeepText = (dataset: string | null) => (dataset ? `Keep “${dataset}”` : 'Keep the dataset')
export const STRAND_DATASET_CHANGE_TEXT = 'Change the dataset'
/**
 * #1646 (D337) — the open construct's Quotes line: each pin counted against its OWN strand's
 * coded passages (a codes strand) or coded answers (a survey comments strand). One pool item:
 * "N of M … pinned"; several: what the quotes are chosen from, each count in its unit (said once
 * at the end when every item shares it, as before).
 */
export interface QuotePoolItem { name: string; n: number; unit: 'passages' | 'answers'; pinned: number }
const poolUnit = (unit: QuotePoolItem['unit'], n: number) =>
  `coded ${unit === 'answers' ? (n === 1 ? 'answer' : 'answers') : (n === 1 ? 'passage' : 'passages')}`
/**
 * #1668 (D344) — the pin picker's words, by what its strand lists (`lib/joint-display.ts::
 * pinPoolUnit`): a survey comments strand's coded ANSWERS, else coded passages. Five lines said
 * "passage" over answers ("2 coded passages in this group" above two answers, driven 11-16d).
 */
export function pinPickerText(unit: QuotePoolItem['unit']) {
  const answers = unit === 'answers'
  return {
    count: (n: number, more: boolean) =>
      `${n} ${poolUnit(unit, n)} in this group${more ? ' — the first 50 are listed' : ''}.`,
    loading: answers ? 'Loading this group’s answers…' : 'Loading this group’s passages…',
    failed: answers ? 'The answers could not be loaded.' : 'The passages could not be loaded.',
    empty: answers
      ? 'Nobody in this group has an answer with this code in this strand’s questions.'
      : 'Nobody in this group has a passage with this code in the display’s sources.',
    list: answers ? 'Answers to pin' : 'Passages to pin',
  }
}

export function quotePoolText(pool: QuotePoolItem[]): string {
  if (pool.length === 0) return ''
  if (pool.length === 1) return `${pool[0].pinned} of ${pool[0].n} ${poolUnit(pool[0].unit, pool[0].n)} pinned`
  if (pool.every(p => p.unit === pool[0].unit)) {
    return `chosen from ${pool.map(p => `${p.name} ${p.n}`).join(' · ')} ${poolUnit(pool[0].unit, 2)}`
  }
  return `chosen from ${pool.map(p => `${p.name} ${p.n} ${poolUnit(p.unit, p.n)}`).join(' · ')}`
}
/** #1639 (r1-4) — a variable or dataset delete's confirm: what it does to a joint display. */
export const DELETE_REACHES_DISPLAYS_TEXT =
  'A joint display that uses it will show it as no longer in the project.'
export const STRAND_REMOVE_CONFIRM_TEXT = 'Remove the strand and its fits'
export const STRAND_REMOVE_KEEP_TEXT = 'Keep the strand'
/** r6-9 — the builder's observations list could not be read: never "Every one (0)". */
export const OBSERVATIONS_FAILED_TITLE = 'The observations could not be loaded'
/** The same for a survey comments strand's questions (the open-text columns' own read). */
export const QUESTIONS_FAILED_TITLE = 'The questions could not be loaded'
