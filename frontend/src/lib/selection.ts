/**
 * #480 — the ONE canonical "selected / active" recipe (DESIGN.md §9a). A calm blue
 * tint: present enough to locate yourself, quiet enough not to compete with CTAs.
 * Import these instead of hand-rolling a per-component selected style — that drift
 * (grey `bg-mm-surface` slides, raw `bg-blue-50`, `bg-white` cards, …) is exactly what
 * #480 unwinds. Focus stays the green ring (§9); focus ≠ selection.
 *
 * Roles (never confused): SELECTION = these blue tints · CTA = filled green/teal ·
 * STATUS = semantic (amber/emerald/rose/purple). A control that is none of those
 * carries no colour.
 */

/**
 * Tint background only — e.g. a segmented-control sliding indicator. Per-mode: dark
 * needs a heavier alpha (the dark surface is near-black, so the same alpha reads fainter).
 */
export const SELECTED_TINT = 'bg-[hsl(var(--mm-blue)/0.20)] dark:bg-[hsl(var(--mm-blue)/0.30)]'
/** Active text token (AA on the tint). */
export const SELECTED_TEXT = 'text-mm-blue-text'
/** Thin inset blue edge — adds crisp "selected" definition on top of the tint. */
export const SELECTED_RING = 'ring-1 ring-inset ring-[hsl(var(--mm-blue)/0.45)]'

/** Segment / chip / cell / mode-toggle button (the common case): tint + ring + text. */
export const SELECTED_SEGMENT = `${SELECTED_TINT} ${SELECTED_RING} ${SELECTED_TEXT} font-medium`
/**
 * Selected list / table ROW — tint + a left accent bar drawn as an INSET shadow (not a
 * border), so it adds no width and is a safe drop-in: `isSelected ? SELECTED_ROW : ''`
 * never shifts the layout vs the unselected row.
 */
export const SELECTED_ROW = `${SELECTED_TINT} ${SELECTED_TEXT} shadow-[inset_3px_0_0_0_hsl(var(--mm-blue)/0.65)]`
/** Selected CARD — tint + ring (ring is shadow-based → no layout shift). */
export const SELECTED_CARD = `${SELECTED_TINT} ${SELECTED_TEXT} ring-1 ring-[hsl(var(--mm-blue)/0.6)]`
/**
 * Selected TABLE CELL — an OPAQUE bg (not the alpha tint). Sticky cells paint over
 * scrolled content, so a translucent tint would bleed (#472 class); use this for
 * selected cells in sticky/virtualized tables. Pair the row's left bar separately.
 */
export const SELECTED_CELL = 'bg-mm-blue-cell'

// ── NOT selection: "now playing" (Observations D27) ─────────────────────────
// The playhead-containment state — "the playhead is inside this clip right
// now" — is a PLAYBACK fact, not a selection. It lives beside the selection
// recipes so nobody reinvents it as another blue, keyed to the playhead's own
// mm-green family so it visually reads "at the playhead" (the playhead line is
// bg-mm-green). Selection still wins when both apply — a selected clip shows
// the blue recipe, and follow-mode clips are usually both.

/** Now-playing list ROW — green tint + left bar (the SELECTED_ROW geometry). */
export const NOW_PLAYING_ROW =
  'bg-[hsl(var(--mm-green)/0.10)] dark:bg-[hsl(var(--mm-green)/0.16)] shadow-[inset_3px_0_0_0_hsl(var(--mm-green)/0.6)]'
/** Now-playing timeline BAR — a green ring over the clip bar. */
export const NOW_PLAYING_BAR = 'ring-2 ring-[hsl(var(--mm-green)/0.75)]'

/**
 * Selected timeline BAR — a blue RING, deliberately not the tint (#656).
 *
 * A clip bar carries its code's own colour as an inline `backgroundColor`, and
 * an inline style beats a Tailwind `bg-*` class — so `SELECTED_SEGMENT`'s tint
 * would silently paint nothing there and selection would vanish from the
 * timeline the moment bars stopped being uniformly teal. Ring geometry matches
 * NOW_PLAYING_BAR beside it; hue keeps the roles apart (blue = selection,
 * green = playhead), and selection still wins when both apply.
 */
export const SELECTED_BAR = 'ring-2 ring-[hsl(var(--mm-blue))]'
