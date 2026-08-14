# Accessibility

Mixed Measures is a local-first desktop research tool, maintained part-time by a single
author. This statement aims to be accurate rather than reassuring: it records what has
been built and measured, what is known to be broken, and — most importantly — what has
**not** been tested.

**Last reviewed:** 13 August 2026 · **Applies to:** version 1.3.1

## What this document is, and is not

This is a **self-assessment**, not a conformance claim.

- It is **not a VPAT** and not the result of a third-party audit.
- Mixed Measures does **not** claim WCAG conformance at any level. Several known
  failures are listed below.
- The target we work against is **WCAG 2.2 Level AA**.

Findings here come from code review, automated checks, values computed from the
shipped stylesheet, and browser verification. **Screen-reader testing has happened
once, in July 2026, and three releases have shipped since** — see
[Screen-reader testing](#screen-reader-testing), which is the section that matters
most for anyone evaluating this tool for institutional use.

## Reporting an accessibility problem

Please open a GitHub issue, or email `contact@mixedmeasures.com` with a subject line
beginning `[ACCESSIBILITY]`. Useful details: what you were trying to do, your operating
system, and your assistive technology and its version.

Response expectations match [SECURITY.md](SECURITY.md) — a single part-time maintainer,
acknowledgement within about 7 days.

## What works today

Each item below was verified in the source for this release.

**Text size (desktop app).** Settings → Appearance has a **Text size** control, and
<kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd> zoom in, out,
and reset. The range goes to **200%**, and the preference persists across restarts. In a
browser (running from source), your browser's own zoom applies instead. *Until 1.3.1 the
packaged app had no way to enlarge text at all.*

**Keyboard operation.** Coding, navigation and most workbench actions are keyboard
driven. Pressing <kbd>?</kbd> inside a project opens a keyboard reference covering
Global, Coding, Observations, Conversations, Text columns, Canvas, Dataset and Recode.
(The Settings page and the project list sit outside that layout, so <kbd>?</kbd> does not
open it there.)

**Charts expose their data.** Chart axis labels, category names and values are readable
rather than collapsed into a single image label, and charts built on our charting library
keep its own keyboard traversal of data points. *Before 1.3.1 a wrapper role suppressed
all of this.*

In the analysis views, the chart-type toolbar also offers a **Summary Table** that
presents the same numbers as a plain table. Note the limit: charts embedded on the Canvas
and charts in exported files carry no toolbar, so that alternative is not available
there.

**Focus indicator and text contrast.** The keyboard focus ring clears WCAG 2.2
SC 1.4.11 (3:1) on every surface in both themes, and every text token clears SC 1.4.3
(4.5:1) on every background it is actually painted over. Both are held by a
token × surface contrast matrix that reads the shipped stylesheet, composites the
translucent tints the app really paints, and fails the build if a new text token is
added without stating where it lands.

*This replaced a fourth "faint" text tier.* At AA that tier could not exist: to clear
4.5:1 it needed to be within ~1.5 points of the tier above it, which is not a visible
difference. Faint now equals muted. If you relied on that distinction visually, that is
why it is gone.

**Named controls and tables.** Popovers announce what they are rather than as an
unnamed dialog, and every result table carries a caption describing what it shows.
Both are held by fail-closed source scans.

**Skip link.** The first tab stop is "Skip to main content", which moves focus into
the page rather than only scrolling it — so the next Tab continues inside the content
instead of returning to the navigation. Without it, reaching page content cost 17 tab
stops on every navigation.

**Reduced motion.** A global `prefers-reduced-motion: reduce` rule disables animations,
transitions and smooth scrolling throughout the app — not per-component, not partial.

**Colour is not the only signal.** Coder attribution uses initials as well as colour.
Text drawn on a user-chosen colour (code and speaker colours) has its foreground computed
at runtime for contrast rather than assumed.

**Undo/redo** is available across the coding, dataset and canvas workspaces.

**Focus handling.** Dialogs trap focus; the app declares a `main` landmark and
`lang="en"`.

**Minimum window size.** The desktop window will not resize below 1280×720, below which
the data tables overlap rather than reflow.

## Known gaps

These are real and currently unfixed. Each links to a public issue you can follow,
comment on, or pick up.

**ARIA structure ([#9](https://github.com/gfchavez28/mixedmeasures/issues/9)) — mostly closed in 1.3.1, two parts remain.** The tree widgets now
share one keyboard layer: Enter, Space, Left/Right and the parent hop all work, group
elements are owned by their parent item, and each item announces its level and its
position among its siblings. The Crosswalk grid's role chain is repaired and the grid
costs one tab stop with arrow-key movement inside it, rather than one per cell.

Still open: in the Observations workbench the active-item reference can point outside the
virtualised window when the active clip scrolls out of view — there are three possible
fixes and the failure differs by screen reader, so it is being chosen with a reader in
hand rather than guessed. And the **category picker** used when creating a code or
category is a tree that never branches — it announces a level but has no keyboard model
of its own and spends one tab stop per category, which is felt on a large codebook.

**Dense type scale ([#11](https://github.com/gfchavez28/mixedmeasures/issues/11)).** The dominant body sizes are 12px and 13px, with roughly 495
instances at 11px or smaller. The Text size control above is the mitigation; the scale
itself has not been revisited.

**English only.** There is no internationalisation layer, and the bundled fonts
cover Latin and Latin-Extended only — other scripts fall back to system fonts and render
outside the designed type scale. Word counts are whitespace-delimited, which
under-reports for Chinese, Japanese and Thai.

**A deliberate trade-off worth naming.** Clip rows in the Observations workbench carry
interactive controls inside a role whose children are technically presentational. This is
a known conflict, kept because the alternative removed a needed affordance; every action
available from a row menu is also reachable another way.

**Its price is now measured rather than assumed.** Because a button inside an option is
not a valid child, NVDA re-orients to the list before *each* control — "Clips list" is
spoken four times on a coded row, roughly forty times to cross a list of thirteen. That
is the cost of the trade-off, stated so you can judge it. If it causes you trouble in
practice, please tell us — that would change the calculation.

## Screen-reader testing

**Last verified: 12 August 2026, with NVDA on Windows.** An earlier pair of
listen-throughs ran on 1 July 2026 against a large stress-test project — one covering the
conversation, document and text coding workbenches plus the reconciliation grid, and a
second confirming a fix.

That session is worth describing, because it shows what this kind of testing catches
and automated checks do not. Arrow-key navigation moved the visible selection but was
**silent**: the screen reader neither moved to nor announced the next segment. The
markup was valid and the structural checks passed; nothing managed focus, so there was
no anchor for the reader to follow. The reconciliation grid — the one surface that
already had a focus model — worked, which is what identified the cause. The fix (a
focusable list container plus an active-descendant reference on all three coding
surfaces) was confirmed in the second listen-through.

**The August pass closed the gap that had opened.** Three releases — 1.1.0, 1.2.0 and
1.3.0 — had shipped since July without being heard, including the whole Observations
track. On 12 August the Observations workbench was driven by ear for the first time,
along with the skip link, the reveal dialog, the video-pane size controls, and the naming
of the qualitative analysis surfaces.

It found six problems, and **all six are fixed in this release**: a clip list that told
the reader it held seven items when it held thirteen (and changed the number as you
scrolled); colour swatches and menus announcing as unavailable while fully operable;
segmentation controls that vanished from the keyboard entirely on a frozen observation
rather than explaining themselves; a toggle whose name contradicted its own state; the
Crosswalk grid's per-cell tab stops; and the measured cost of the clip-row trade-off
described above. The passes are recorded too, so they are not re-tested: the skip link
announces and moves focus correctly, the reveal dialog is clean, and a full check of
`/analysis/qualitative` found no unnamed elements.

**Still unheard, and named rather than implied:** whether the Observations *timeline* — a
visual track — conveys anything by ear at all; the table captions under cell navigation;
and the category picker described above.

**Never tested with:** JAWS, VoiceOver, or Orca; voice control; switch access;
magnification software; or high-contrast / forced-colours modes.

Treat this as the boundary of what we can honestly say. If you need assurance about
screen-reader behaviour on a current release for a procurement or grant requirement,
please contact us rather than inferring it from the sections above.

## How this was assessed

- **Contrast** figures are computed from the values in the shipped stylesheet using the
  WCAG relative-luminance formula, in both themes. They are *not* sampled from rendered
  pixels, so anywhere opacity or an image sits behind text the real ratio may differ.
- **Structure and naming** counts come from source review of the React components.
- **Automated checks** (axe-core) were run against components rendered in a test
  environment. Worth stating plainly: axe returned **zero violations** on two of the
  surfaces carrying the most serious problems found in this release. Automated tooling
  did not catch them, and should not be relied on as a safety net.
- **Keyboard behaviour** for the zoom controls and the coding shortcuts was driven in a
  real browser and in the packaged desktop application.

## Recent changes

**1.3.1**

Accessibility was the bulk of this release. Everything below shipped after 1.3.0 —
some of it was listed here under 1.3.0 while still unreleased, which was wrong.

- The tree widgets — codebook, source picker, code picker — share one keyboard layer:
  Enter, Space, Left/Right and the parent hop, with each item announcing its level and
  its position among its siblings. Two of the five could not be reached by keyboard at
  all.
- The Crosswalk grid costs one tab stop with arrow keys inside it, instead of one tab
  stop per cell.
- A virtualised clip list states how many clips it holds, rather than how many are
  currently rendered.
- Colour swatches and menus on a code row no longer announce as unavailable while being
  fully operable.
- On a frozen observation, splitting and merging stay reachable and say that the clip set
  is frozen, instead of disappearing from the keyboard.
- A code chip announces who applied it, rather than reading out the badge initials.
- Text inputs, dropdowns and outlined buttons have a boundary that clears 3:1 — they were
  at 1.3:1 and are the only thing identifying those controls.
- Three error messages, including the one naming why a project failed to load, were being
  painted with a border colour at 1.5:1. They and nineteen other misused foreground
  colours now use readable text tiers.
- Dimmed text on selected and now-playing rows clears AA; twelve status and source colour
  pairs were adjusted.
- Added a Text size control and restored the zoom keyboard shortcuts in the desktop app,
  which previously had no text-enlargement mechanism at all.
- Charts no longer suppress their own content from assistive technology, and their
  keyboard traversal of data points is reachable again.
- The log-scale caveat shown on transformed charts is announced rather than silently
  discarded along with the rest of the chart.
- Set a minimum desktop window size so data tables cannot be resized into overlap, and
  fixed the chrome so 200% zoom and narrow windows no longer scroll the page sideways.
- Focus ring raised to clear 3:1 in the light theme, where it measured 2.99:1 on panels
  and 2.57:1 on the app background.
- Five text tokens raised to clear 4.5:1, including the selection text colour, which was
  below AA on its own selection tint.
- The fourth "faint" text tier was retired: at AA it is indistinguishable from muted.
- 28 popovers and 20 result tables gained accessible names.
- Added a skip link, and the page now has exactly one `main` landmark.

**1.3.0**

- The Observations track shipped, and was not heard by a screen reader until after
  release. See *Screen-reader testing* above.
