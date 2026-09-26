/**
 * What the human-vs-machine table SAYS — single-sourced (queue row 49).
 *
 * 🔴 **This module exists because the copy is the third of three mechanisms
 * discharging one commitment.** STRATEGY requires that a machine layer be
 * excludable from every reliability aggregate; #989 built the exclusion, the
 * service refuses to pool the number, and these sentences are what stop a reader
 * treating what remains as reliability or as validation.
 *
 * A κ between a person and a model says how well the model reproduces THAT
 * PERSON's judgements. It is evidence for none of Krippendorff's validity types,
 * it licenses no claim that the coding is correct, and it is not an inter-rater
 * figure — the raters of one are people making independent interpretations,
 * which a model run is not.
 *
 * ⚠️ **Identity-pinned, like `lib/source-kind-copy.ts`.** These strings are
 * asserted by the table's tests so an edit that quietly turns a description into
 * a validation claim fails rather than ships.
 */

/** Above the table. States what the numbers are, in the researcher's words. */
export const MACHINE_AGREEMENT_EXPLAINER =
  'How closely each imported model layer reproduces each person’s coding. '
  + 'These figures describe the MODEL — they are not inter-rater reliability, '
  + 'and they are not evidence that the coding is correct. Nothing here enters '
  + 'the agreement figures above.'

/** Beside the coverage counts, where a thin pass is what makes a figure low. */
export const MACHINE_AGREEMENT_COVERAGE_NOTE =
  'Each row says how many units each side applied the code to. A low figure on a '
  + 'code one side has barely reached is about coverage, not about the model.'

/** When the configuration behind a layer was never recorded. */
export const MACHINE_AGREEMENT_NO_PROVENANCE =
  'No model configuration was recorded for this layer, so these figures cannot be '
  + 'reproduced. Add the model, how it was reached and its settings on the coder.'

/**
 * The three ways there is nothing to show. `satisfies Record<…>` so a fourth
 * reason is a COMPILE error rather than a silent fall-through to an `else`.
 *
 * ⚠️ Each has a DIFFERENT remedy, which is why they are three sentences and not
 * one — and why the table says something rather than rendering a silence that
 * reads as "still thinking" (#963 Tier 3).
 */
export type MachineAgreementUnavailable =
  | 'no_machine_coder'
  | 'no_human_coder'
  | 'no_shared_source'

export const MACHINE_AGREEMENT_UNAVAILABLE = {
  no_machine_coder:
    'No model layer has been imported yet. Import codings from a file and '
    + 'attribute them to a machine coder to compare them with your own.',
  no_human_coder:
    'There is no active person to compare against — every coder on the roster '
    + 'is archived or is a machine.',
  no_shared_source:
    'The model and your coders have not worked on the same source yet, so there '
    + 'is nothing comparable. Code some of the same material, or import model '
    + 'labels for material a person has coded.',
} satisfies Record<MachineAgreementUnavailable, string>

/** The sentence for an unavailable reason, or null for one this build does not know. */
export function machineAgreementUnavailableNote(reason: string | null | undefined): string | null {
  if (!reason) return null
  return (MACHINE_AGREEMENT_UNAVAILABLE as Record<string, string>)[reason] ?? null
}
