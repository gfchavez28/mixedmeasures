/**
 * Row 45 (i) — "locked spine, open columns" on the CLIENT side.
 *
 * A tool-maintained dataset's ROWS are derived from something else (today, the
 * project's participants), so anything that changes the row set is refused. The
 * COLUMNS are the researcher's: rename, describe, recolour, add a variable, edit
 * a cell in a column you made, export.
 *
 * 🔴 **This exists because the server's refusals were invisible here.** Step 3
 * shipped `managed_dataset_refusal` and wired it at SEVEN router doors, and
 * `managed_kind` did not ride the wire — so the moment a participant table
 * became creatable, the UI would offer Delete dataset, Delete record, two append
 * doors and three link doors, and the server would 409 every one. That is the
 * "offering a control that refuses" shape this codebase has now fixed three
 * times (#806 the computed-column editors, #807 Column details, #812 Delete
 * variable), and the remedy each time was ONE predicate rather than a gate per
 * trigger.
 *
 * ⚠️ **The refusal set follows from one PROPERTY, not a list** — *does this
 * change the row set?* A ninth affordance inherits the answer instead of needing
 * a ninth decision. Mirror of `services/participant_dataset.py`; the SERVER is
 * the authority and still refuses independently (a router guard is not a guard
 * on the operation, #589). This only decides what to OFFER.
 *
 * ⚠️ A refused action is not hidden — it takes `lib/mode-disabled.ts`'s
 * persistent-mode arm, so it stays focusable and says WHY. A researcher who
 * cannot find Delete learns nothing; one who reads "this table's records are
 * your participants" learns where to go.
 */

/** The acts a managed dataset refuses. One per QUESTION, not per endpoint —
 *  `append` is two endpoints and `linkParticipants` is three, because a refusal
 *  is about what the caller is doing to the row set. Mirrors `MANAGED_ACTIONS`. */
export type ManagedDatasetAction =
  | 'deleteDataset'
  | 'deleteRow'
  | 'addRow'
  | 'append'
  | 'linkParticipants'

/** Written to be shown verbatim, and each names what the researcher CAN do
 *  instead — a refusal that only forbids teaches nothing. Kept close to the
 *  server's wording without pretending to be it: when a request actually 409s,
 *  the server's own sentence is what gets surfaced (`serverDetailMessage`). */
const REFUSALS = {
  deleteDataset:
    'This table’s records are your project’s participants, so it is kept in step with them rather than deleted here. Remove a participant on the Participants page and their record goes with them.',
  deleteRow:
    'This record is a participant, so it is removed by deleting that participant on the Participants page — not from this table. You can still delete a variable you added here.',
  // Row 47 — the fifth action. It exists because the backend's row-set route
  // scan matched `POST …/{id}/rows` on its PATH and required an answer, not
  // because anyone remembered this seam while building "add a record".
  addRow:
    'Records here are your project’s participants, so a record is added by adding a participant on the Participants page. You can add a variable to this table and fill it in for everyone.',
  append:
    'Records here come from your project’s participants, so a file cannot add to them. Import the file as its own dataset, or add a variable to this one and fill it in.',
  linkParticipants:
    'Every record here is already one participant, so links are maintained for you and cannot be changed by hand.',
} satisfies Record<ManagedDatasetAction, string>

/** THE predicate: the sentence refusing `action`, or null to allow it.
 *
 *  An ordinary dataset (`managed_kind` null/absent) allows everything, so a call
 *  site can ask unconditionally and needs no branch of its own — which is what
 *  stops the check from being forgotten at the next door. */
export function managedDatasetRefusal(
  dataset: { managed_kind?: string | null } | null | undefined,
  action: ManagedDatasetAction,
): string | null {
  if (!dataset?.managed_kind) return null
  return REFUSALS[action]
}

/** Is this dataset maintained by the tool at all? For labelling and for the
 *  refresh affordance — NOT for gating an action, which must name the action so
 *  the reason it shows is the right one. */
export function isManagedDataset(
  dataset: { managed_kind?: string | null } | null | undefined,
): boolean {
  return Boolean(dataset?.managed_kind)
}
