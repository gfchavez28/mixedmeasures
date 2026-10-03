import type { Code } from '@/lib/api'
import type { CodeApplicationIdentity } from '@/lib/coding-progress'

/**
 * Which codes can THIS coder rate on THIS target, in chip order? (#868 e/f)
 *
 * The re-rate affordance is a keyboard verb (`r`) plus a context-menu item, and
 * both need the same answer — as does any future surface that offers rating on an
 * application that already exists. Derived in ONE place so the verb and the menu
 * can never disagree about what is ratable, which is the `lib/codeShortcuts.ts`
 * lesson (#824) applied to a smaller space.
 *
 * Three filters, and each one is a refusal the SERVER would otherwise issue —
 * offering a control that 403s or 404s is the #806 shape:
 *
 * 1. 🔴 **The coder's OWN applications only.** `set_code_magnitude` filters on
 *    `user_id == user.id` (`magnitude-coding.md` §4) because a rating is one
 *    coder's judgement and overwriting a colleague's would fabricate agreement.
 *    The predicate mirrors each workbench's `currentMagnitude` EXACTLY — a
 *    colleague's chip is visible and is not ratable.
 * 2. **A declared scale.** No instrument, no rating (§10): the rating UI renders
 *    only against a scale, so a code without one has nothing to open.
 * 3. **Active codes only.** `validate_value` refuses `inactive` (#869 g), so an
 *    archived code's menu item would open a strip whose commit is refused.
 *    ⚠️ Note the asymmetry this preserves: *unrating* an inactive code stays
 *    legal server-side (clearing is recoverable), but there is no door to it
 *    here — that is deliberate, not an oversight.
 *
 * ⚠️ **Deduplicated on `code_id`.** A target can carry the same code from several
 * coders; after filter (1) at most one survives, but the dedup is kept so a
 * caller passing an unfiltered list cannot produce two menu items for one code.
 *
 * ⚠️ **Order is the caller's order**, which is chip order on every current
 * caller — so the verb opens the same code the coder sees first.
 */
export function ratableCodes(
  applications: readonly CodeApplicationIdentity[] | undefined,
  codeMap: Map<number, Code>,
  selfId: number | null,
): Code[] {
  if (!applications) return []
  const seen = new Set<number>()
  const out: Code[] = []
  for (const app of applications) {
    if (app.user_id !== selfId) continue
    if (seen.has(app.code_id)) continue
    const code = codeMap.get(app.code_id)
    if (!code || !code.magnitude_scale || !code.is_active) continue
    seen.add(app.code_id)
    out.push(code)
  }
  return out
}

/**
 * The code an open rating strip should show — the LIVE one from the page's codes
 * list, not the copy taken when the strip opened (#1112).
 *
 * Each workbench keeps `ratingTarget = { unit, code }`, and the strip read
 * `code.magnitude_scale` from that copy, so a scale saved while the strip was
 * open never reached it: measured, the step saved as 0.5 and the strip went on
 * offering the old step-1 ticks. Reading the page's `codeMap` (which the scale
 * dialog updates the moment the server answers) makes a rename, a new step and
 * a removed scale all arrive.
 *
 * ⚠️ Falls back to the captured copy only while the list has no such code (a
 * cold cache), never in preference to it.
 * ⚠️ The mount must also key on `scaleSignature(scale)`: the strip sets its
 * cursor once, so a step change has to be a remount.
 */
export function liveRatingCode(captured: Code, codeMap: Map<number, Code>): Code {
  return codeMap.get(captured.id) ?? captured
}
