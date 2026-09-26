import type { Coder } from '@/lib/api'

/**
 * A MACHINE coder's PROVENANCE — which model, reached how, at what settings
 * (queue row 49).
 *
 * 🔴 **This is the feature, not metadata on it.** A 2026 scoping review of LLM
 * use in qualitative research found **75% of studies report no model parameter
 * settings at all** and **45% do not say how the model was accessed**, with
 * human-vs-LLM agreement spanning 36%–99% precisely because the configuration
 * varies unrecorded. Under the project's five-question purpose statement an
 * imported machine layer is a **question-3 (provenance)** capability, and this
 * is the part of it that reaches a screen.
 *
 * Mirrors `backend/app/services/machine_coder.py`; the access vocabulary is
 * contract-tested from Python (`tests/test_machine_coder_contract.py`), which
 * reads this file.
 */

export interface MachineProvenance {
  /** The identifier a methods section would quote (`gpt-4o-2024-08-06`). */
  model: string
  access?: MachineAccess
  /** The instrument itself. Can be paragraphs — never put it in a one-liner. */
  prompt?: string
  /** Decoding settings. Values are TEXT so `0` and `"0"` are one record. */
  parameters?: Record<string, string>
}

/** How the model was reached — the gap 45% of published studies leave open. */
export type MachineAccess = 'api' | 'web' | 'local' | 'other'

/** Ordered: the picker renders in this order. Mirrors `MACHINE_ACCESS_KINDS`. */
export const MACHINE_ACCESS_KINDS: readonly MachineAccess[] = [
  'api', 'web', 'local', 'other',
]

/**
 * What each access kind is CALLED.
 *
 * `satisfies Record<MachineAccess, …>` so a fifth kind is a COMPILE error rather
 * than falling through to whichever branch happens to be the `else` — the
 * stated-basis family's rule (b), and #941's.
 */
export const MACHINE_ACCESS_LABEL = {
  api: 'API',
  web: 'Web interface',
  local: 'Local deployment',
  other: 'Other',
} satisfies Record<MachineAccess, string>

/**
 * One line naming the configuration — for a chip, a picker row, a table header.
 *
 * ⚠️ Deliberately NOT the prompt: a prompt is paragraphs and this has to fit
 * beside a coder's name. The surfaces that show the prompt show it in full.
 *
 * 🔴 **The unrecorded case gets WORDS, not an empty string.** "Configuration not
 * recorded" is the fact every other tool is permanently in, and hiding it would
 * make an undocumented model indistinguishable from a documented one — which is
 * the defect this whole row exists to close.
 */
export function describeProvenance(provenance: MachineProvenance | null | undefined): string {
  if (!provenance?.model) return 'Configuration not recorded'
  const parts = [provenance.model]
  if (provenance.access) parts.push(`via ${MACHINE_ACCESS_LABEL[provenance.access]}`)
  const params = provenance.parameters ?? {}
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length) parts.push(entries.map(([k, v]) => `${k} ${v}`).join(', '))
  return parts.join(' · ')
}

/** Has this coder recorded a configuration at all? */
export const hasProvenance = (coder: Pick<Coder, 'machine_provenance'>): boolean =>
  !!coder.machine_provenance?.model

/**
 * Why a machine coder's configuration cannot be edited, or null when it can.
 *
 * 🔴 **The server decides this and the client must not re-derive it.** The lock
 * is DERIVED from whether the coder holds any coding, and a client that guessed
 * would offer an editor the server 409s — the #806 shape, and #974's rule (a
 * prediction computed differently from the act it predicts).
 */
export function provenanceLockReason(
  coder: Pick<Coder, 'provenance_locked'>,
): string | null {
  return coder.provenance_locked
    ? 'This coder has already produced coding, so its configuration is fixed. '
      + 'Two configurations of one model are two different coders — add a second '
      + 'machine coder for the new configuration.'
    : null
}

/**
 * `temperature=0, top_p=1` → `{temperature: '0', top_p: '1'}`.
 *
 * Lives here rather than beside either form because BOTH the import page and the
 * Settings dialog author a provenance, and a second copy of this parser is a
 * second answer to "what is a setting" (#733: a copy propagates a defect
 * verbatim, not merely drifts).
 *
 * ⚠️ Deliberately forgiving about SEPARATORS and exact about the SPLIT: a
 * researcher pasting from a config file uses commas, newlines or both, and a
 * value containing `=` (a stop sequence) must keep everything after the FIRST
 * one. The server normalises and refuses what it cannot store — this only has to
 * get the shape right.
 */
export function parseParameters(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of parameterChunks(text)) {
    const pair = readParameter(line)
    if (pair) out[pair[0]] = pair[1]
  }
  return out
}

/** The non-empty, trimmed chunks of a settings text — the ONE split. */
function parameterChunks(text: string): string[] {
  return text.split(/[\n,]+/).map(c => c.trim()).filter(Boolean)
}

/** One chunk → `[name, value]`, or `null` when it is not readable — the ONE test. */
function readParameter(line: string): [string, string] | null {
  const at = line.indexOf('=')
  if (at <= 0) return null
  const key = line.slice(0, at).trim()
  const value = line.slice(at + 1).trim()
  return key && value ? [key, value] : null
}

/**
 * The parts of a settings text that `parseParameters` will DROP — anything that
 * is not `name=value` with both halves present (`temperature: 0`, `seed=`).
 *
 * 🔴 **The parser is forgiving by design, and forgiving meant SILENT:** a
 * researcher who wrote `temperature 0` saved a provenance with no settings and
 * nothing said so — on the one form whose purpose is recording the
 * configuration. The form shows these instead, so the drop is a choice.
 * It calls the parser's own split and test, so the two cannot disagree about
 * what is readable.
 */
export function unreadableParameters(text: string): string[] {
  return parameterChunks(text).filter(line => readParameter(line) === null)
}

/** The inverse, for seeding an editor from a stored provenance. */
export function formatParameters(parameters: Record<string, string> | undefined): string {
  return Object.entries(parameters ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
}
