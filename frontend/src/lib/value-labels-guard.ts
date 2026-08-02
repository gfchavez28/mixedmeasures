/**
 * #585: the single place "may this column's value labels be edited?" is decided.
 *
 * Value labels key each cell on its CODE, read from `value_numeric`. That IS the
 * raw code after import and under a `scale_map` primary — but a `reverse` primary
 * stores the REFLECTED score, `(min+max) - code`, while the column's
 * `scale_values` stay in FORWARD codes. Relabelling then reads each cell's mirror
 * code and rewrites the response to its opposite, self-consistently (label and
 * code agree with each other and with nothing else). The backend refuses this
 * (`services/value_labels.py::blocking_reverse_primary` → 400); this mirrors the
 * rule client-side so the dialog can say so BEFORE the researcher does the work.
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

/**
 * The reverse-scoring primary that blocks relabelling, or null when clear.
 *
 * Returns the definition (not a boolean) so callers can name it — a guard whose
 * job is to explain must be able to say WHICH recode is in the way.
 *
 * Note `recode_definitions` rides only the `/data` column payload; it is
 * `undefined` on column shapes fetched elsewhere, which reads as "not blocked".
 * That is the correct default here — the backend is the authority and refuses
 * regardless; this is a pre-flight, never the enforcement point.
 */
export function blockingReversePrimary(
  column: Pick<DatasetColumn, 'recode_definitions'>,
): RecodeDefinitionSummary | null {
  const defs = column.recode_definitions ?? []
  return defs.find(d => d.is_primary && d.recode_type === 'reverse') ?? null
}
