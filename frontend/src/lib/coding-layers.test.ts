/**
 * The coding-layer vocabulary (#989).
 *
 * This module exists because the layer list was restated inline at ELEVEN places
 * across the client and TEN more in the routers, so adding the machine layer
 * meant finding every one of them. These tests pin the properties that make one
 * source worth having.
 */
import { describe, it, expect } from 'vitest'
import {
  asLayerScope,
  availableLayerScopes,
  isMachineCoder,
  LAYER_SCOPES,
  LAYER_SCOPE_META,
  layerScopeLabel,
  MACHINE_CODER_TYPE,
  rosterHasMachineCoders,
  showLayerPicker,
  type LayerScope,
} from './coding-layers'

// `coder_type` stated EXPLICITLY as undefined: that is the shape a payload from a
// server predating the field has, and it is the case `isMachineCoder` must read as
// human. Without it the object has no property in common with `Pick<Coder,
// 'coder_type'>` and tsc rejects the call — which vitest cannot see.
const HUMAN: { id: number; username: string; coder_type?: string } =
  { id: 1, username: 'Me', coder_type: undefined }
const MACHINE = { id: 9, username: 'GPT-Coder', coder_type: MACHINE_CODER_TYPE }

describe('isMachineCoder', () => {
  it('recognises the stored wire value', () => {
    expect(isMachineCoder(MACHINE)).toBe(true)
  })

  it('reads an ABSENT coder_type as human', () => {
    // A payload from a server that predates the field describes a person. The
    // fail-closed direction here is the opposite of the server's: treating
    // unknown as machine would drop real colleagues out of reliability.
    expect(isMachineCoder(HUMAN)).toBe(false)
    expect(isMachineCoder({ coder_type: undefined })).toBe(false)
  })

  it('is EXACT — a case variant is not the machine kind', () => {
    // The backend compares `coder_type` exactly everywhere, so a client that
    // matched loosely would disagree with it about who may vote.
    expect(isMachineCoder({ coder_type: 'AI' })).toBe(false)
    expect(isMachineCoder({ coder_type: 'machine' })).toBe(false)
  })

  it('reads an unknown kind as human, matching normalize_coder_type', () => {
    expect(isMachineCoder({ coder_type: 'robot' })).toBe(false)
  })
})

describe('rosterHasMachineCoders', () => {
  it('is false for an empty or all-human roster', () => {
    expect(rosterHasMachineCoders([])).toBe(false)
    expect(rosterHasMachineCoders([HUMAN, { id: 2, username: 'Alice' }])).toBe(false)
  })

  it('is true as soon as one machine is present', () => {
    expect(rosterHasMachineCoders([HUMAN, MACHINE])).toBe(true)
  })
})

describe('availableLayerScopes', () => {
  it('always offers the human layer, first', () => {
    // It is the default every endpoint falls back to; a picker that could omit
    // it would be able to strand a surface away from the default reading.
    for (const consensusAvailable of [false, true]) {
      for (const hasMachineCoders of [false, true]) {
        const scopes = availableLayerScopes({ consensusAvailable, hasMachineCoders })
        expect(scopes[0]).toBe('human')
      }
    }
  })

  it('offers a layer only when it can return something', () => {
    expect(availableLayerScopes({ consensusAvailable: false, hasMachineCoders: false }))
      .toEqual(['human'])
    expect(availableLayerScopes({ consensusAvailable: true, hasMachineCoders: false }))
      .toEqual(['human', 'consensus'])
    expect(availableLayerScopes({ consensusAvailable: false, hasMachineCoders: true }))
      .toEqual(['human', 'machine'])
    expect(availableLayerScopes({ consensusAvailable: true, hasMachineCoders: true }))
      .toEqual(['human', 'consensus', 'machine'])
  })
})

describe('showLayerPicker', () => {
  it('hides the picker when the human layer is the only one', () => {
    // A one-option group reports state nothing can change.
    expect(showLayerPicker({ consensusAvailable: false, hasMachineCoders: false })).toBe(false)
  })

  it('shows it for EITHER additional layer, not only consensus', () => {
    // The two hand-rolled gates it replaced both read `multiCoder &&
    // consensusAvailable`, so a machine-only project would have had a layer it
    // could never select.
    expect(showLayerPicker({ consensusAvailable: true, hasMachineCoders: false })).toBe(true)
    expect(showLayerPicker({ consensusAvailable: false, hasMachineCoders: true })).toBe(true)
  })
})

describe('asLayerScope', () => {
  it('passes every known scope through', () => {
    for (const scope of LAYER_SCOPES) expect(asLayerScope(scope)).toBe(scope)
  })

  it('falls back to the DEFAULT rather than refusing', () => {
    // A saved `machine` scope surviving into a project whose machine coder was
    // archived must land on people's coding, not on an error screen.
    expect(asLayerScope('robot')).toBe('human')
    expect(asLayerScope(undefined)).toBe('human')
    expect(asLayerScope(null)).toBe('human')
    expect(asLayerScope(7)).toBe('human')
    expect(asLayerScope('')).toBe('human')
  })
})

describe('the label table', () => {
  it('names every scope, with no empty label', () => {
    // `satisfies Record<LayerScope, …>` makes a MISSING key a compile error; this
    // is the runtime half — a key present but blank would render an unnamed tab.
    for (const scope of LAYER_SCOPES) {
      expect(layerScopeLabel(scope).length).toBeGreaterThan(0)
      expect(LAYER_SCOPE_META[scope].description.length).toBeGreaterThan(0)
    }
    expect(Object.keys(LAYER_SCOPE_META).sort()).toEqual([...LAYER_SCOPES].sort())
  })

  it('gives each scope a DISTINCT label', () => {
    // Two layers reading the same on screen is a picker that cannot be used.
    const labels = LAYER_SCOPES.map(layerScopeLabel)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it("says in the machine layer's own description that it is not a rater", () => {
    // STRATEGY's constraint has to reach the researcher somewhere, and this is
    // the string that renders beside the control that selects the layer.
    expect(LAYER_SCOPE_META.machine.description.toLowerCase()).toContain('agreement')
  })
})

describe('the cross-language contract', () => {
  it('declares exactly the scopes the backend does', () => {
    // Mirrors `backend/app/services/coding_layers.py::VALID_LAYER_SCOPES`, which
    // BUILDS the routers' query-parameter pattern from the same tuple. A scope
    // this file offers and that file does not know answers 422 — the Python side
    // reads this literal back in `test_machine_coder_layer.py`.
    const expected: LayerScope[] = ['human', 'consensus', 'machine']
    expect([...LAYER_SCOPES]).toEqual(expected)
  })
})
