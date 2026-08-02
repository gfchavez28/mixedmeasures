/**
 * The words we use to explain WHICH SOURCE TYPE a recording belongs in — and
 * what each choice costs. One module, so the import fork, the workbench freeze
 * control (slab 3) and the Reliability tab (slab 6b) cannot drift apart.
 *
 * Why this is single-sourced rather than typed where it is needed:
 *
 *   These sentences are the basis on which a researcher makes a decision they
 *   cannot undo, after which they may code for hours. One of them was FALSE in
 *   the plan for a day — D16 originally told people an Observation has "no
 *   consensus and no reconciliation", which D18 then showed is untrue for a
 *   frozen clip set. A sentence like that, re-typed into three surfaces, gets
 *   corrected in one of them.
 *
 * The module is a flat set of literals on purpose. A fail-closed source scan
 * (source-kind-copy.test.ts) checks that its load-bearing phrases appear nowhere
 * else, and a scan can only see what is written plainly — building this out of
 * clever composition would blind the very guard that protects it.
 */

/** The one sentence. If a surface can only afford one line, it is this one. */
export const SOURCE_KIND_ONE_LINER =
  'A recording can live in either place. In a Conversation it’s an aid — you code the transcript. '
  + 'In an Observation it’s the material — you code the timeline.'

/**
 * The one-line description for an INVENTORY surface — the Overview's
 * Observations card (#627). Short enough for a card, and it lives here rather
 * than in the page because it carries "code what happened", which is one of the
 * phrases the drift scan protects. A nav label is a low-stakes surface, but the
 * words still have to be the same words.
 */
export const OBSERVATION_CARD_DESCRIPTION =
  'Mark clips on a recording’s timeline and code what happened.'

export interface SourceKindRow {
  source: string
  youCode: string
  theRecordingIs: string
}

/** The unit of analysis is the distinction that matters — not the artifact. */
export const SOURCE_KIND_TABLE: SourceKindRow[] = [
  {
    source: 'Conversations',
    youCode: 'what was said — the transcript is the material',
    theRecordingIs: 'an aid — it plays alongside',
  },
  {
    source: 'Documents',
    youCode: 'what was written',
    theRecordingIs: 'n/a',
  },
  {
    source: 'Observations',
    youCode: 'what happened — the timeline is the material',
    theRecordingIs: 'the material itself',
  },
]

/**
 * What an Observation genuinely cannot do. Stated up front, because discovering
 * it after eight hours of coding is a failure we inflicted.
 *
 * NOTE what is deliberately NOT here: "no consensus, no reconciliation". That
 * was D16's original wording and D18 struck it — a FROZEN clip set gets ordinary
 * agreement scoring, consensus and reconciliation, through the engines that
 * already ship. The reliability consequence is a separate question with its own
 * answer below, not a flat cost of choosing an Observation.
 */
export const OBSERVATION_TRADEOFFS: string[] = [
  'No transcript text — so no word search, no verbatim quotes, and no speaker or participant spine.',
  'Codes are shared with the rest of the project, but the source is not linked to any transcript of the same session.',
]

export const CONVERSATION_TRADEOFFS: string[] = [
  'You can only code what was said — silences, gestures and anything crossing turn boundaries have no home in a transcript.',
]

/** D15 — the honest answer for "I have both a video AND a transcript". */
export const DOUBLE_IMPORT_NOTE =
  'Have both a recording and a transcript, and want to code utterances AND what you see? '
  + 'Import the session twice — once as a Conversation, once as an Observation. They share '
  + 'the project’s codes, but they are not linked, so the session counts as two sources in '
  + 'your analysis.'

/**
 * D17 — the single most de-risking sentence available to us. It converts an
 * irreversible-feeling fork into "the file is reusable; the coding isn't."
 */
export const ESCAPE_HATCH_NOTE =
  'Pick wrong and you can re-use the same recording in the other place without re-uploading it — '
  + 'only the coding doesn’t move.'

// ── The segmentation freeze (D18) — a SECOND question, and a reversible one ──
//
// Deliberately NOT a control on the import form: per D20 the freeze happens later,
// in the workbench, once clips actually exist (freezing a "start empty" observation
// would freeze zero clips). These strings preview a decision; they never make it.

export const SEGMENTATION_FREEZE_QUESTION =
  'Will your team agree the clips up front, or will each coder mark their own?'

export const SEGMENTATION_FREEZE_REVERSIBLE =
  'You can change this any time before coding starts.'

export const FROZEN_CONSEQUENCES =
  'Frozen — everyone codes the same clips, so agreement is simply “did we apply the same codes?” '
  + 'You get ordinary agreement scoring, consensus and reconciliation. The trade: you don’t re-cut the '
  + 'clips mid-study.'

export const OPEN_CONSEQUENCES =
  'Open — each coder marks their own clips, so you also measure whether you agreed on WHERE the '
  // "event-matched agreement" deliberately NOT promised here: 6b-A-3 is specified
  // (D47) but unbuilt, and copy must not claim what the tool doesn't compute —
  // the §8n rule. Restore the phrase in the SAME change that ships it.
  + 'moments are. Reliability uses time-based agreement plus unitizing alpha. There is '
  + 'no consensus layer, because a clip only one person marked has only one vote.'

// ── Drop routing ────────────────────────────────────────────────────────────
//
// A recording dropped on the Conversations list used to be a silent no-op. The
// person doing it is exactly who Observations are for, so we route them — and
// say why, in the words that own the distinction.

export const DROPPED_RECORDING_TITLE =
  'That’s a recording, not a transcript — importing it as an Observation.'

export const DROPPED_RECORDING_DETAIL =
  'You’ll code it on its own timeline. Meant to code what was said? Add a transcript in the '
  + 'Conversations importer instead.'

export const DROPPED_TRANSCRIPT_TITLE =
  'That’s a transcript, not a recording — importing it as a Conversation.'

/** Freezing after distributing copies does not retroactively make the cuts shared. */
export const FREEZE_BEFORE_YOU_DISTRIBUTE =
  'Freeze before you hand copies out for coding — freezing afterwards can’t make clips '
  + 'that were cut separately into the same clips.'

/**
 * The unfreeze confirm (slab 3e — the #615-fixed consequence, stated BEFORE the
 * click). Unfreezing deletes only the DERIVED consensus layer, synchronously;
 * every human coding stays. The methodological half is the part a team can't
 * undo: agreement already reported was computed on units now open to change.
 */
export const UNFREEZE_CONSEQUENCES =
  'Re-opening drops this observation’s consensus layer — every coder’s own work stays, '
  + 'but agreement you already reported was computed on clips that can now change. '
  + 'Reliability reverts to the open-cuts statistics until you freeze again.'

/** Reliability-tab explainers (slab 6b) — SAME words as the fork above, by construction. */
export const RELIABILITY_EXPLAINER_FROZEN = FROZEN_CONSEQUENCES
export const RELIABILITY_EXPLAINER_OPEN = OPEN_CONSEQUENCES

/**
 * Phrases that must exist in exactly ONE place: here.
 *
 * Consumed by the drift scan. Kept narrow and distinctive on purpose — a guard
 * on a common word like "consensus" would fire on the whole multi-coder UI and
 * be turned off within a week, which is worse than no guard.
 */
export const LOAD_BEARING_PHRASES: string[] = [
  'you code the transcript',
  'you code the timeline',
  'code what was said',
  'code what happened',
  'unitizing alpha',
  'without re-uploading',
  'each coder mark their own',
  'drops this observation’s consensus layer',
]
