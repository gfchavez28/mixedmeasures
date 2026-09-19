/**
 * "Is this code name already taken?" — asked in ONE place (#963).
 *
 * Six surfaces create a code from a typed name and each had its own copy of this
 * comparison; three more had none at all, which is the defect this closes. Four
 * copies of one predicate is the substrate debt this codebase keeps paying, and
 * the copies had already drifted in what they compared against (see below).
 *
 * 🔴 **The comparison must match `routers/codes.py::_refuse_duplicate_code_name`,
 * which is the actual guard.** Trimmed, case-insensitive, and the server uses
 * Python's `.lower()` rather than `.casefold()` for precisely this reason — a
 * server stricter than the hint on screen refuses names no surface warned about.
 *
 * ⚠️ **WHAT the caller compares against is still the caller's decision, and the
 * surfaces legitimately differ.** The workbench panels hold the ACTIVE code list
 * (that is what they render); `CodebookSlideOut` and the create dialogs hold the
 * list INCLUDING inactive codes, because a deactivated code has not released its
 * name. The server checks every code either way, so a surface with the narrower
 * list under-warns rather than mis-warns — it offers a name the server then
 * refuses with a message, which is the safe direction.
 */

/** The form both sides of the comparison are reduced to. */
export function normalizeCodeName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * The code whose name collides with `name`, or `undefined`.
 *
 * Returns the CODE rather than a boolean so a caller can name it on screen —
 * "a code named X already exists" is actionable where "already exists" sends the
 * researcher hunting.
 *
 * ⚠️ An empty or whitespace-only `name` matches NOTHING. Callers that treat an
 * empty query as "cannot create" must keep saying so themselves; folding that
 * into this function would make the same call mean two different things.
 */
export function findCodeByName<T extends { name: string }>(
  codes: readonly T[],
  name: string,
): T | undefined {
  const needle = normalizeCodeName(name)
  if (!needle) return undefined
  return codes.find(code => normalizeCodeName(code.name) === needle)
}
