/**
 * Ghost suggestion visual state derivation.
 *
 * `confident` — cross-dataset cluster with members_paired populated. Amber accent.
 * `unpaired`  — cross-dataset cluster where auto-pair couldn't decide. Greyed.
 * `single`    — single-dataset cluster (no pairing needed). Green accent.
 *
 * Lives in its own file so SuggestionGhostRow.tsx satisfies the
 * react-refresh/only-export-components rule (component files should only
 * export components for HMR).
 */

import type { DomainSuggestion } from '@/lib/api/analysis-domains'

export type GhostState = 'confident' | 'unpaired' | 'single'

export function getGhostState(suggestion: DomainSuggestion): GhostState {
  const datasetIds = new Set(
    suggestion.members.map(m => m.dataset_id).filter((id): id is number => id != null),
  )
  if (datasetIds.size <= 1) return 'single'
  if (suggestion.unpaired) return 'unpaired'
  return 'confident'
}
