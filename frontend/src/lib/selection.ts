/**
 * #480 — the ONE canonical "selected / active" recipe (the internal design notes). A calm blue
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
 * #748 — **a selection surface raises the dim text tiers one step, for everything
 * inside it.**
 *
 * Measured (`lib/contrast.ts`, the shipped tokens): `--mm-text-muted` /
 * `--mm-text-faint` / `--muted-foreground` on the selection tint are **3.12:1 in
 * dark** and **3.86:1 in light** — below AA on the app's most common state
 * surface, and on the opaque `--mm-blue-cell` variant 3.50:1. Three obvious
 * levers are arithmetically dead, so do not re-propose them: lightening the dim
 * token needs L≥64 in dark (`--mm-text-secondary` is 72%, so the tier stops
 * existing); darkening `--mm-blue-cell` to L≤17 leaves the tint at 1.11:1
 * against its own surface, i.e. invisible; and lowering the tint alpha to 0.08 —
 * where the tint has all but gone — still only reaches 4.46. The tint's hue sits
 * too close to the dim tokens' lightness for any of them to work.
 *
 * What does work is changing which tier those descendants resolve to. This is a
 * **CSS custom property, not a class selector**: the recipe re-points the token
 * on the selected element and every descendant inherits it, so no component opts
 * in and none can forget. The alias is to `--mm-text-secondary`, an existing
 * tier rather than a new value — 5.16 dark / 4.87 light on the tint, 5.79 / 6.05
 * on the cell.
 *
 * ⚠️ Both themes are covered by ONE declaration: the tokens are bare HSL triples
 * and `--mm-text-secondary` is itself per-theme, so the alias resolves correctly
 * in each without a `dark:` variant. ⚠️ `--muted-foreground` (shadcn) has to be
 * in the list — it is the token actually painted inside a selected cell
 * (`ByTextTable`'s "Empty response"), and the #699 matrix missed the whole class
 * because that token was not on its axis.
 */
export const SELECTION_TEXT_FLOOR =
  '[--mm-text-muted:var(--mm-text-secondary)] [--mm-text-faint:var(--mm-text-secondary)] [--muted-foreground:var(--mm-text-secondary)]'

/**
 * Tint background only — e.g. a segmented-control sliding indicator. Per-mode: dark
 * needs a heavier alpha (the dark surface is near-black, so the same alpha reads fainter).
 */
export const SELECTED_TINT =
  `bg-[hsl(var(--mm-blue)/0.20)] dark:bg-[hsl(var(--mm-blue)/0.30)] ${SELECTION_TEXT_FLOOR}`
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
export const SELECTED_CELL = `bg-mm-blue-cell ${SELECTION_TEXT_FLOOR}`

// ── NOT selection: "now playing" (Observations D27) ─────────────────────────
// The playhead-containment state — "the playhead is inside this clip right
// now" — is a PLAYBACK fact, not a selection. It lives beside the selection
// recipes so nobody reinvents it as another blue, keyed to the playhead's own
// mm-green family so it visually reads "at the playhead" (the playhead line is
// bg-mm-green). Selection still wins when both apply — a selected clip shows
// the blue recipe, and follow-mode clips are usually both.

/**
 * Now-playing list ROW — green tint + left bar (the SELECTED_ROW geometry).
 *
 * ⚠️ It carries `SELECTION_TEXT_FLOOR` too, and the reason is worth keeping: the
 * floor is a property of **tinted rows**, not of what the tint means. Measured
 * before it was added, `--mm-text-faint` (the clip row's own metadata) read
 * **3.91:1 in dark** and **4.38:1 in light** here — a lighter tint than
 * selection's and still below AA. A state surface that dims its own text is one
 * defect with two hues; it was found only because this pair was put on the
 * guard's axis rather than assumed safe for being "not selection".
 */
export const NOW_PLAYING_ROW =
  `bg-[hsl(var(--mm-green)/0.10)] dark:bg-[hsl(var(--mm-green)/0.16)] shadow-[inset_3px_0_0_0_hsl(var(--mm-green)/0.6)] ${SELECTION_TEXT_FLOOR}`
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
