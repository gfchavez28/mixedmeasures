/**
 * The WORD for an interpretation band the server returns (`kappa_interpretation`,
 * `alpha_interpretation`, …) — the ONE place a band key becomes text.
 *
 * The server sends keys (`almost_perfect`), not prose. `IrrMatrix` held this map
 * privately, so the model-comparison table built its row names from the raw key
 * and a reader heard *"Kappa 0.89, almost underscore perfect"* (found by the
 * 2026-09-23 name sweep). An unknown key falls back to itself rather than to
 * nothing, so a band a newer server sends is still said.
 */
const BAND_LABEL: Record<string, string> = {
  poor: 'poor', slight: 'slight', fair: 'fair', moderate: 'moderate',
  substantial: 'substantial', almost_perfect: 'almost perfect',
  unreliable: 'unreliable', tentative: 'tentative', reliable: 'reliable',
}

export const bandWord = (b: string | null | undefined): string => (b ? BAND_LABEL[b] ?? b : '')
