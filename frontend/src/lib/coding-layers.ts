import type { Coder } from '@/lib/api'

/**
 * The stored `coder_type` of a MACHINE coder (#989) — labels a model produced
 * elsewhere, loaded in as a file.
 *
 * 🔴 The wire value is `'ai'` and the NAME is the claim: `User.coder_type`
 * reserved `'ai'` in D14 and renaming the column would be a migration for
 * nothing. Mirrors `backend/app/auth.py::CODER_TYPE_MACHINE`.
 */
export const MACHINE_CODER_TYPE = 'ai'

/**
 * Is this coder a machine?
 *
 * ⚠️ `coder_type` is OPTIONAL on the wire, so an absent value must read as
 * HUMAN — a payload from a server that predates the field describes a person.
 * The fail-closed direction here is the OPPOSITE of the server's: treating
 * unknown as machine would quietly drop real colleagues out of every
 * reliability surface.
 */
export const isMachineCoder = (coder: Pick<Coder, 'coder_type'>): boolean =>
  coder.coder_type === MACHINE_CODER_TYPE

/**
 * The coding LAYER a surface is reading (Track J · J2-5; the machine layer #989).
 * Mirrors `backend/app/services/coding_layers.py::VALID_LAYER_SCOPES`, which also
 * builds the routers' `layer_scope` query-parameter pattern from that tuple — so
 * a value this file offers and that file does not know answers 422, and the
 * cross-language contract test is what keeps the two lists equal.
 *
 * - `human`     — people's coding (the default). Excludes consensus AND machine.
 * - `consensus` — the derived agreement layer, present only once it exists.
 * - `machine`   — labels a model produced elsewhere, loaded in as a file.
 */
export type LayerScope = 'human' | 'consensus' | 'machine'

export const LAYER_SCOPES: readonly LayerScope[] = ['human', 'consensus', 'machine']

/**
 * What each layer is CALLED on screen, and what it means.
 *
 * `satisfies Record<LayerScope, …>` on purpose: a fourth layer must not be able
 * to fall through to whichever branch happens to be the `else`. That is the
 * stated-basis family's rule (b) — a new variant is a COMPILE error where it can
 * be — and #941's, where a ternary chain's final arm silently became the default
 * for a value nobody had considered.
 */
export const LAYER_SCOPE_META = {
  human: {
    label: 'Coders',
    description: 'Coding done by the people on this project.',
  },
  consensus: {
    label: 'Consensus',
    description: 'The agreed layer, derived where coders applied the same codes.',
  },
  machine: {
    label: 'Machine',
    description:
      'Codes imported from a model. Never counted as a coder in agreement figures.',
  },
} satisfies Record<LayerScope, { label: string; description: string }>

export const layerScopeLabel = (scope: LayerScope): string => LAYER_SCOPE_META[scope].label

export interface LayerAvailability {
  /** A consensus layer has been materialised for this project (DEC-A). */
  consensusAvailable: boolean
  /** The roster holds ≥1 machine coder (#989). */
  hasMachineCoders: boolean
}

/** Does this roster contain a machine coder? The one derivation; never inline the compare. */
export const rosterHasMachineCoders = (coders: readonly Coder[]): boolean =>
  coders.some(isMachineCoder)

/**
 * The layers a surface may offer, in display order.
 *
 * 🔴 `human` is ALWAYS present and always first — it is the default every
 * endpoint falls back to, so a picker that could omit it would be able to leave
 * a surface with no way back to the reading everything else assumes.
 *
 * ⚠️ A layer is offered only when it can actually return something: consensus
 * only once it exists, machine only once a machine coder is on the roster.
 * Offering an empty layer is the #806 shape — a control whose selection the
 * server answers with nothing.
 */
export function availableLayerScopes(availability: LayerAvailability): LayerScope[] {
  const scopes: LayerScope[] = ['human']
  if (availability.consensusAvailable) scopes.push('consensus')
  if (availability.hasMachineCoders) scopes.push('machine')
  return scopes
}

/**
 * Should the layer picker render at all?
 *
 * There must be somewhere to go: with only the human layer available the control
 * is a one-option group that reports state nothing can change. This replaces the
 * two hand-rolled `multiCoder && consensusAvailable` gates that each also
 * restated the option list inline — which is why adding a third layer would
 * otherwise have needed both to be found.
 */
export const showLayerPicker = (availability: LayerAvailability): boolean =>
  availableLayerScopes(availability).length > 1

/**
 * Narrow an untrusted value (a URL param, a persisted preference) to a layer this
 * build knows, falling back to `human`.
 *
 * ⚠️ The fallback is the DEFAULT rather than a refusal: a saved `machine` scope
 * surviving into a project whose machine coder was archived must land the reader
 * on people's coding, not on an error or an empty screen.
 */
export const asLayerScope = (value: unknown): LayerScope =>
  LAYER_SCOPES.includes(value as LayerScope) ? (value as LayerScope) : 'human'
