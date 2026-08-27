/**
 * #585/#793: the single place "may this column's value labels be edited?" is decided.
 *
 * Value labels key each cell on its CODE, read from `value_numeric`. That IS the
 * raw code after import and under an IDENTITY `scale_map` primary — but a
 * `reverse` primary stores the REFLECTED score (#585), and a FLIPPING or
 * COLLAPSING `scale_map` stores its own mapping's output (#793). Relabelling
 * then reads each cell's wrong code and rewrites the response to a different
 * answer, self-consistently (label and code agree with each other and with
 * nothing else). The backend refuses both
 * (`services/value_labels.py::blocking_reverse_primary` and
 * `::code_identity_violation` → 400); this mirrors what it can, client-side, so
 * the dialog can say so BEFORE the researcher does the work.
 *
 * ⚠️ **This is a SHAPE test, and it is deliberately weaker than the backend's.**
 * The authority reads the column's stored cells; a client cannot, because #800
 * PAGINATED `GET …/data` — the client holds one 200-row page, so a data-driven
 * mirror would pronounce a column safe on the strength of a sample. What rides
 * the payload is each definition's `mapping`, so what is checkable here is
 * "does this mapping send a numeric key somewhere other than itself". That
 * covers the case the Recode Workbench actually creates (a flip authored over
 * bare codes). A hand-flip keyed on LABELS is invisible from here and is caught
 * by the backend on save — rejection, not concealment.
 *
 * Rejection, NOT concealment (the `identifier-guard.ts` rule): "Add/Edit value
 * labels..." stays visible in the column menu — hiding it would remove the only
 * surface that explains why the column can't be relabelled. The dialog opens and
 * refuses, naming the recode and the way out.
 *
 * `category_group` needs no guard: it CLEARS `value_numeric`, so the backend
 * recovers the code by parsing `value_text`.
 */
import type { DatasetColumn, RecodeDefinitionSummary } from '@/lib/api/datasets'

/** Why relabelling is refused — the two reasons read differently to a researcher. */
export type ValueLabelBlocker = {
  /**
   * Either payload's view of the primary. Both carry the three fields the copy
   * needs; `recode_type` is widened to `string` because `PrimaryRecodeSummary`
   * mirrors a server enum that may gain a member before this union does — and a
   * blocker that fails to TYPE is a blocker that fails to WARN.
   */
  definition: { id: number; name: string; recode_type: string }
  /** `reverse` — stores a reflected score. `remap` — stores its mapping's output. */
  kind: 'reverse' | 'remap'
}

/**
 * Does this mapping send a NUMERIC key to a different number?
 *
 * `{"1": 1, "2": 2}` is an identity code map and is safe. `{"1": 5, "2": 4}` is
 * a flip and `{"1": 1, "2": 1}` is a collapse — both put something other than
 * the response's code into `value_numeric`.
 *
 * Non-numeric keys are skipped rather than judged: on a labelled column the keys
 * ARE the labels, and `value_numeric` is the code, which is the ordinary re-edit
 * path that must keep working.
 */
function remapsItsOwnCodes(mapping: RecodeDefinitionSummary['mapping']): boolean {
  return Object.entries(mapping ?? {}).some(([key, value]) => {
    const code = Number(key)
    const out = Number(value)
    // `Number('')` is 0 and `Number(null)` is 0 — test the emptiness, not the
    // NaN-ness, or a blank key reads as code 0 and every mapping looks unsafe.
    if (key.trim() === '' || !Number.isFinite(code)) return false
    if (value === null || value === '' || !Number.isFinite(out)) return false
    return code !== out
  })
}

/**
 * The primary recode that blocks relabelling, or null when clear.
 *
 * Returns the definition (not a boolean) so callers can name it — a guard whose
 * job is to explain must be able to say WHICH recode is in the way — plus the
 * KIND, so the copy can describe the right consequence rather than a generic one.
 *
 * Note `recode_definitions` rides only the `/data` column payload; it is
 * `undefined` on column shapes fetched elsewhere, which reads as "not blocked".
 * That is the correct default here — the backend is the authority and refuses
 * regardless; this is a pre-flight, never the enforcement point.
 */
export function valueLabelBlocker(
  column: Pick<DatasetColumn, 'recode_definitions' | 'primary_recode'>,
): ValueLabelBlocker | null {
  /**
   * 🔴 **TWO payloads carry the primary, and only one of them is on every
   * surface — found by driving the page, 2026-08-23.**
   *
   * `recode_definitions` rides ONLY `GET …/data`. When this editor was a modal
   * it was opened from the Data view, so that was always the payload. Inline in
   * the Variables view it is fed by `listColumns`, which has never carried the
   * field — so the pre-flight silently returned "not blocked" for every
   * column, including the #793 one it exists to catch. The backend still
   * refused, but the researcher only learned that after typing five labels,
   * which is precisely what "say so BEFORE they do the work" rules out.
   *
   * `primary_recode` is the fix and is strictly better: it is on EVERY column
   * response, and the server has already done the shape test, so the client
   * needs no mapping at all. `recode_definitions` stays as the fallback for
   * payloads that predate the field.
   */
  const summary = column.primary_recode
  if (summary) {
    if (summary.recode_type === 'reverse') {
      return { definition: summary, kind: 'reverse' }
    }
    if (summary.recode_type === 'scale_map' && summary.remaps_codes) {
      return { definition: summary, kind: 'remap' }
    }
    return null
  }

  const primary = (column.recode_definitions ?? []).find(d => d.is_primary)
  if (!primary) return null
  if (primary.recode_type === 'reverse') return { definition: primary, kind: 'reverse' }
  if (primary.recode_type === 'scale_map' && remapsItsOwnCodes(primary.mapping)) {
    return { definition: primary, kind: 'remap' }
  }
  return null
}
