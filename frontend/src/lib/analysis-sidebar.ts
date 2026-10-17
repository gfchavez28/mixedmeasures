/**
 * The analysis pages' sidebar `Panel` sizes — ONE place for both pages (#1180).
 *
 * `AnalysisView` and `QualitativeAnalysisView` each carried `defaultSize="22"
 * minSize="15" maxSize="32"` — all percentages, so at 640×360 the sidebar was 22% of
 * a ~625-px group: **136 px** (139 on the qualitative page). The variable group's name
 * stacked a word per line, the group detail's content box was 47 px, and *Create
 * scale score* wrapped to three lines. Two copies of one sizing is how a fix to one
 * page re-splits the pair, so both spread this object.
 *
 * - **`minSize` is PIXELS** — react-resizable-panels (4.10) reads a string ending in
 *   `px` as pixels and a unit-less string as a percentage. 200 px is the width at
 *   which the group detail's button fits on one line (with its indent trimmed,
 *   `DomainPickerDetail`).
 * - 🔴 **`maxSize` must stay above the floor at the narrowest group.** At a 640
 *   viewport with a 17-px Windows scrollbar the group is 623 px, and the old 32% of
 *   623 is 199 px — a maximum BELOW the 200-px minimum. 35% is 218 px there (≈ 448 at
 *   1280, from ≈ 410). `responsive-chrome.test.ts` pins the arithmetic.
 * - 🔴 **`preserve-pixel-size`, because a pixel floor RATCHETS a percentage.**
 *   MEASURED live: with the default (`preserve-relative-size`), narrowing the window
 *   to 640 pushed the stored layout from 22% to 32% to honour the floor, and widening
 *   again kept 32% — the sidebar grew from 281 to ~410 px at 1280 and was saved that
 *   way. Holding the sidebar's PIXEL width across a window resize, it went
 *   280 → 217 (the 35% ceiling at 640) → 217, and the main area takes the rest. 35%
 *   rather than 40% because the ceiling is now also what a wider sidebar is cut to
 *   on a narrow window (40% left the main area 371 px at 640; 35% leaves 402).
 */
export const ANALYSIS_SIDEBAR_PANEL = {
  defaultSize: '22',
  minSize: '200px',
  maxSize: '35',
  groupResizeBehavior: 'preserve-pixel-size',
} as const

/**
 * The layout a FIRST visit starts from, passed when nothing is stored yet.
 *
 * 🔴 MEASURED (live, 2026-10-13): with no stored layout the library derives the
 * first layout from `defaultSize`, against a group size it takes as the sum of the
 * panels' `offsetWidth` at mount — and at mount that sum was ~568 px on a 1280-px
 * window. A 200-px minimum is 35% of 568, so a first visit opened the sidebar at
 * 449 px instead of 281 and SAVED it. With a layout handed in, the panels are
 * sized from it before they are measured, and the first visit opens at 22%.
 */
export const ANALYSIS_DEFAULT_LAYOUT = { sidebar: 22, main: 78 }

/** The narrowest panel group the floor must fit: a 640-px viewport less a 17-px scrollbar. */
export const NARROWEST_ANALYSIS_GROUP_PX = 640 - 17
