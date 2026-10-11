/**
 * #1175 — what a delete confirmation says about everything ELSE the delete removes.
 *
 * *Delete variable* listed "value labels, missing-value rules and recodes" and the
 * dataset confirm "all columns, rows, recodes, and associated data" — and neither
 * named the saved statistics, the saved tests or the variable groups the same
 * click removed or recalculated. A cross-dataset pairing refusal arrived only
 * AFTER the click, as a 409. The rule this restores is the re-derive plan's: a
 * confirm that cannot name what it is about to change is not informed consent.
 *
 * The plan is the SERVER's (`GET …/removal-plan`), computed by the function the
 * delete itself runs; this module only words it. Quick compute's cached results
 * are not on the wire at all — they are rebuilt whenever a chart asks, so naming
 * them would put a cache in front of the researcher as if it were their work.
 */
import type { RemovalPlan } from '@/lib/api'
import { countLabel, listNames } from '@/lib/format'
import type { ListStatus } from '@/lib/list-status'

/**
 * One paragraph naming what else goes, or `null` when nothing else does.
 *
 * ⚠️ ONE string, never sibling JSX fragments: Chrome dropped the space between
 * two fragments of one described element once the second rendered late (#1067 c),
 * and this sentence arrives after the dialog opens.
 */
export function describeRemovalPlan(plan: RemovalPlan): string | null {
  const sentences: string[] = []

  const metrics = plan.saved_metrics_removed
  const removed: string[] = []
  if (metrics.length > 0) {
    removed.push(
      `${countLabel(metrics.length, 'saved statistic', 'saved statistics')} (${listNames(metrics)})`,
    )
  }
  if (plan.tests_removed > 0) {
    removed.push(countLabel(plan.tests_removed, 'saved test', 'saved tests'))
  }
  if (removed.length > 0) {
    // "1 saved test that uses it", but "1 saved statistic (A) and 1 saved test
    // that use it" — the verb agrees with everything named, not the last noun.
    const one = metrics.length + plan.tests_removed === 1
    sentences.push(`Also removes ${removed.join(' and ')} that ${one ? 'uses' : 'use'} it.`)
  }

  const recalculated = plan.groups_recalculated.map(g => g.name)
  const emptied = plan.groups_removed.map(g => g.name)
  const groups = (names: string[]) =>
    `${countLabel(names.length, 'variable group', 'variable groups')} (${listNames(names)})`
  if (recalculated.length > 0 && emptied.length > 0) {
    sentences.push(
      `${groups(recalculated)} will be recalculated; ${emptied.length} (${listNames(emptied)}) will be removed.`,
    )
  } else if (recalculated.length > 0) {
    sentences.push(`${groups(recalculated)} will be recalculated.`)
  } else if (emptied.length > 0) {
    sentences.push(`${groups(emptied)} will be removed.`)
  }

  return sentences.length > 0 ? sentences.join(' ') : null
}

export interface RemovalRefusal {
  /** The sentence for the dialog's description. */
  message: string
  /** Completes the confirm button's name — `lib/mode-disabled.ts` appends it. */
  reason: string
}

/**
 * Why the delete would be refused, or `null` when it would not.
 *
 * `blocked_by` first: those are the computed variables whose formulas read this
 * one, and the remedy is on the same screen. `refusal` is the server's own
 * sentence (a variable group left with unpaired cross-dataset members) and is
 * shown as written — rewording it here would be a second source for a refusal
 * the delete raises with its own words.
 */
export function removalPlanRefusal(plan: RemovalPlan): RemovalRefusal | null {
  const blockers = plan.blocked_by
  if (blockers.length > 0) {
    const one = blockers.length === 1
    const why = `the computed ${one ? 'variable' : 'variables'} ${listNames(blockers)} ${one ? 'uses' : 'use'} it`
    const block = `Can't delete: ${why}. Delete or edit ${one ? blockers[0] : 'them'} first.`
    return {
      message: plan.refusal ? `${block} ${plan.refusal}` : block,
      reason: `unavailable: ${why}`,
    }
  }
  if (plan.refusal) return { message: plan.refusal, reason: `unavailable: ${plan.refusal}` }
  return null
}

export interface RemovalPlanGate {
  /** What the description adds — the refusal, the consequences, or nothing. */
  sentence: string | null
  /** A persistent block: the confirm stays focusable with this in its name. */
  blockedReason: string | null
  /** The plan has not answered yet, so the confirm waits (a transient state). */
  waiting: boolean
}

/**
 * What a confirmation may say and do, decided on the plan's LOAD STATUS
 * (`lib/list-status.ts`), never on whether the plan object happens to exist.
 *
 * 🔴 **It WAITS while loading and PROCEEDS after a failure** — the import
 * wizards' split (the internal design notes, Tier 1). Waiting is what
 * makes the paragraph informed consent rather than decoration: a confirm pressed
 * before the plan answers removes saved statistics nobody was told about. But a
 * failed READ must not hold the delete hostage — the delete still runs the same
 * refusals server-side — so after a failure the surface says the check could not
 * run (`RemovalPlanStatus`) and the confirm works.
 *
 * ⚠️ Never a sentence from an unanswered plan: "nothing else is removed" and "we
 * have not looked" are the same empty value (#961).
 */
export function removalPlanGate(status: ListStatus, plan: RemovalPlan | undefined): RemovalPlanGate {
  if (status !== 'ready' || plan === undefined) {
    return { sentence: null, blockedReason: null, waiting: status === 'loading' }
  }
  const refusal = removalPlanRefusal(plan)
  if (refusal) return { sentence: refusal.message, blockedReason: refusal.reason, waiting: false }
  return { sentence: describeRemovalPlan(plan), blockedReason: null, waiting: false }
}
