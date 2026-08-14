/**
 * Resolving a saved Timeline material's config into what `TimedAnalytics` needs
 * (#652 slab 4) — pure, so the RENDERER and the EXPORT resolve identically.
 *
 * The Timeline is the one qualitative material with **no endpoint**: it is
 * computed client-side from the workbench clip payload over four reference
 * datasets. That makes it the one type where the canvas could plausibly ship a
 * second, subtly-different implementation of "which observations, which codes,
 * whose marks" — the renderer mounting a component and the export path mounting
 * nothing. These three functions are the shared answer; both callers use them
 * and neither re-derives.
 *
 * Every rule below MIRRORS `QualitativeAnalysisView`. Where a rule looks odd,
 * the oddity is the view's and the comment says so — do not normalize it here.
 */
import type { Code, Observation } from '@/lib/api'
import type { CoderInclude } from '@/lib/timed-analytics'
import type {
  TimedCodeLite,
  TimedObservationLite,
} from '@/components/qualitative-analysis/TimedAnalytics'

/**
 * Which observations this Timeline charts.
 *
 * ⚠️ **An empty `observation_ids` means ALL OBSERVATIONS, not none.**
 * `QualitativeAnalysisView::contentObservations` returns the whole project list
 * when the selection is empty and the tab is not Content — so on Descriptives,
 * where the Timeline lives, "nothing selected" charts everything. This is the
 * FOURTH disagreeing empty-list semantic in this feature (see the table in
 * `inline-chart-params.ts`) and the first that lives in the VIEW rather than in
 * a service, which is why it cannot be answered from the config alone.
 *
 * ⚠️ Reachable with no observation selected at all: `hasSourceSelection` is
 * satisfied by a conversation, so a researcher who picked only conversations
 * and switched to Timeline saw EVERY observation charted. Mirrored deliberately.
 *
 * FILTERS the project list rather than mapping the ids, so the caller's order
 * (the backend's) is preserved and a stale id simply drops out.
 */
export function resolveTimelineObservations(
  configObservationIds: readonly number[],
  projectObservations: readonly Observation[],
): TimedObservationLite[] {
  const wanted = new Set(configObservationIds)
  const chosen = configObservationIds.length > 0
    ? projectObservations.filter(o => wanted.has(o.id))
    : projectObservations
  return chosen.map(o => ({
    id: o.id,
    name: o.name,
    media_duration_seconds: o.media_duration_seconds,
    segmentation_frozen_at: o.segmentation_frozen_at,
  }))
}

/**
 * Which codes get a lane, and in what order.
 *
 * ⚠️ **Order comes from the PROJECT'S code list, never from `code_ids`.**
 * `timedCodes` filters `codes` — which arrives in the backend's `display_order`
 * — so iterating the config's array instead would silently reorder every lane
 * and every table row relative to the figure the researcher saved.
 *
 * `is_active` is applied here too: a code deactivated after the material was
 * saved disappears from the analysis view, so it must disappear here.
 *
 * The caller guarantees a non-empty `code_ids` (that is
 * `qualChartHasEnoughToFetch`'s Timeline branch), which is why there is no
 * "empty means all active" arm — that arm is dead in the view and stays dead
 * here.
 */
export function resolveTimelineCodes(
  configCodeIds: readonly number[],
  projectCodes: readonly Code[],
): TimedCodeLite[] {
  const wanted = new Set(configCodeIds)
  return projectCodes
    .filter(c => c.is_active && wanted.has(c.id))
    .map(c => ({
      id: c.id,
      name: c.name,
      color: c.color,
      category_id: c.category_id,
      category_color: c.category_color,
    }))
}

export interface TimelineCoderLens {
  /** null = no filter (all coders + unattributed); a set = ONLY these ids. */
  include: CoderInclude
  /** Drives per-coder affordances inside `TimedAnalytics`. */
  multiCoder: boolean
  /** True when the lens was narrowed by blind mode rather than by the config. */
  blinded: boolean
}

/**
 * The coder lens for a Timeline **on the canvas**.
 *
 * 🔴 **This is a privacy control, not a display preference.** The canvas had no
 * blind lens before slab 4 (nothing under `components/canvas/` or `CanvasView`
 * consulted `useBlindMode`) and it never needed one, because every embed until
 * now rendered aggregates. The Timeline is the first canvas surface that prints
 * coder IDENTITY — `TimedAnalytics` renders `coder.username` in the by-coder
 * table AND appends it to every codeline mark's `title`.
 *
 * Two facts make the naive version leak:
 *
 *   1. `buildCurrentConfig` persists `coder_ids: coderIds` — the RAW filter, not
 *      the blind-forced `effectiveCoderInclude`. So a material saved WHILE BLIND
 *      stores `[]`, i.e. "no filter" (that gap is #683).
 *   2. Blind mode is per-(project, coder) local state, so the researcher reading
 *      the canvas may be blind right now regardless of what was saved.
 *
 * Replay the saved scope unchanged and a blind researcher's canvas names their
 * colleagues — multi-coder invariant 5.
 *
 * ⚠️ **Narrowing `include` is the WHOLE fix, and that is worth stating because
 * it is easy to over-build here.** This function first also blanked the
 * `coderMap` as belt-and-braces; mutation testing showed that guard could not be
 * killed, and the reason is structural: `marksForCode` drops every detail whose
 * `user_id` fails `detailVisible`, so once the include set is `{self}` the only
 * `user_id` that can reach a mark's `title` is the viewer's own. A colleague
 * name is unreachable, so a second guard against it was unfalsifiable comfort
 * and was removed rather than left with a comment claiming it mattered.
 *
 * Fail-closed on a missing self id: an empty include set hides everything, which
 * is the right direction for a privacy control.
 *
 * No React Query hazard here — the clip queries are unfiltered and the lens is
 * applied in pure compute downstream, so the #454 "key on the effective scope"
 * rule has nothing to bite on. Do not add a redundant key for it.
 */
export function resolveTimelineCoderLens(
  savedCoderIds: readonly number[] | null,
  blind: boolean,
  self: number | null,
  rosterMultiCoder: boolean,
): TimelineCoderLens {
  if (blind) {
    return {
      include: new Set(self != null ? [self] : []),
      multiCoder: false,
      blinded: true,
    }
  }
  return {
    include: savedCoderIds && savedCoderIds.length > 0 ? new Set(savedCoderIds) : null,
    multiCoder: rosterMultiCoder,
    blinded: false,
  }
}
