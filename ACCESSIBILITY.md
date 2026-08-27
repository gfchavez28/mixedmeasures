# Accessibility

Mixed Measures is a local-first desktop research tool, maintained part-time by a single
author. This statement aims to be accurate rather than reassuring: it records what has
been built and measured, what is known to be broken, and — most importantly — what has
**not** been tested.

**Last reviewed:** 27 August 2026 · **Applies to:** version 1.4.0

**Scope of the most recent review.** The 1.4.0 round covered the new Variables view, the
Data view, the Canvas (including snapshot comparison) and the quantitative analysis
surfaces. It did **not** revisit the four coding workbenches, the crosswalk, the import
wizards, the codebook, settings, or the project-merge flow — those were last examined for
1.3.1 and the notes below still stand for them.

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

## A deliberate exception: the size of code chips

WCAG 2.5.8 (Target Size, Minimum) asks that a pointer target be at least 24 by 24
CSS pixels. The small code chips attached to a segment, a clip or a row do not
meet it: they are about 16.5 pixels tall. **This is a decision, not an oversight,
and it is recorded here so it can be argued with.**

The criterion carries an explicit exception for targets whose size is constrained
by the line-height of the surrounding text, which is what a wrapped row of chips
is. Against that, the cost of compliance was measured rather than assumed: the
chips sit in a wrapped row whose line pitch is 20.5 pixels, so 24-pixel hit boxes
would **overlap**, and chips would steal each other's clicks. That is a
functional regression traded for a marginal one, across twelve places in nine
components including two dense grids.

The remove control on a chip is smaller still, at 14 by 14 pixels, and it is the
part of this we are least comfortable with. Enlarging it is not a matter of
padding: it is positioned at the chip's top-right corner, so a compliant hit box
centred there would cover part of the chip itself and break "click the chip to
focus its code" near its end, while extending it outward would reach the
neighbouring chip instead. The honest fix is to make the chips themselves taller,
which changes row density across the application and wants a deliberate look at
the two dense grids rather than a quick edit.

Every one of these controls is fully reachable and operable by keyboard, and each
carries an accessible name. **If you use a pointer and find these targets hard to
hit, please tell us** — that report is what would move this from a documented
trade-off to a scheduled fix.

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
hand rather than guessed.

The **category picker** used when creating a code or category is no longer part of this
gap: it costs one tab stop with arrow keys inside it, and rows blocked by the depth limit
stay reachable and say why. (Two earlier versions of this note were wrong about it. The
first said the picker "never branches" — it does nest, and announces each item's level and
position; the seeded test project simply had no nested categories, so a flat *rendering*
was mistaken for a flat *capability*. The second left "spends one tab stop per category"
standing here for three days after that was fixed. Both were corrected by listening to it,
and the second by a close-out sweep rather than by anyone noticing.)

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

**Its price is measured rather than assumed, and it is much smaller than it was.**
Because a button inside an option is not a valid child, a screen reader re-orients to the
list before *each* control — so the cost is the number of controls the list puts in the
keyboard's path. Until recently every row put at least one there, and it was the Delete
button: crossing thirteen clips meant meeting thirteen destructive controls and nothing
else. A row's controls now join the keyboard's path only when that row is *selected*, so
the same list presents eleven stops — all of them on the three rows that actually carry
codes or notes — and the Delete for the clip you are on. Clicking any row's controls with
a mouse is unchanged. If the remaining cost causes you trouble in practice, please tell
us — that would change the calculation.

**One accepted limitation, stated plainly.** The clip list renders only the rows near your
scroll position, and the reader is pointed at the current clip by reference. If you scroll
the list away from that clip with a mouse wheel, the reference briefly names a row that is
no longer present. Tested with NVDA: it recovers on the next arrow key, announcing the
correct clip and position, so we have left it rather than rebuild the focus model around
it. We have not tested how other screen readers behave in that moment.

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

**A second pass ran on 2026-08-17**, on the three surfaces the first left unheard. It
found four more problems, all fixed here: every clip in the Observations list was
announced *twice*, because the row's name briefly changed after you arrived on it; an
observation with no recording attached described its selected clip as playing; the dataset
grid named the column of each cell but never the record, so moving across a row told you
values without telling you whose; and the codebook tree's left/right arrows expanded and
collapsed branches but could not move into or out of one.

It also settled two questions rather than finding faults. The Observations **timeline** is
not conveyed by ear at all: its lanes and bars are hidden from readers by design, and the
clip list beside it carries the same clips — but the timeline's grouping of clips by code
category has no spoken equivalent, and the explanation behind its "About the timeline"
button describes what the lanes *mean* rather than what they currently *contain*. And the
category picker announces its position correctly, so its remaining cost is one keyboard
stop per category rather than one for the list.

**A third pass ran on 2026-08-18.** It confirmed the two fixes above by ear, and closed the
last surface this document had listed as unheard: **the table captions do announce** under
cell navigation. Nothing was wrong with the markup — reaching a table by clicking into it
leaves the reader outside any cell, which is what the earlier attempts had measured. Read
by browse-mode navigation, the caption speaks and the cells then navigate normally.

It found three further problems, all fixed here, and two of them are the same kind of fault
as the "announced twice" one above: **a name that says something untrue**. A clip claimed
to be playing whenever the playhead merely rested inside it, so any clip starting at 0:00
said so the moment it was selected, on a recording that had never been played. Every
dataset column header announced itself as "sortable" — a word inherited from the
drag-and-drop library, in a grid that has no sort. And the previous pass's tab-order fix
turned out to have moved one control of four, so tabbing still walked into the code chips
of clips you had not selected.

**Still unheard:** nothing on the list this document has been keeping. New surfaces will
need new passes.

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

**1.4.0**

From the pre-release review of the new Variables view:

- The list of variables costs one tab stop instead of one per variable, and moves with the
  arrow keys, Home and End. On a dataset with 48 variables it previously cost 48 stops to
  pass.
- A saved rule's card header is a button that reports whether it is expanded, and all five
  of a rule's actions are reachable from the keyboard.
- Three dropdowns in the rule editor announced themselves only as "combobox". A dropdown's
  visible text is the value chosen, which names the choice and never the control, so each
  now carries its own name.
- Text in the Variables view meets contrast in both themes, and its tables associate every
  cell with a header.
- The top rail no longer scrolls sideways at 200% zoom: the coder label collapses to make
  room, rather than pushing the row past the window.

From a second and third screen-reader pass, on the surfaces the first one could not reach.

- Each clip in the Observations list is announced once. It was announced twice, because
  the row's name briefly gained "now playing" as you arrived on it and lost it again a
  moment later — and a name that changes while you are on it gets re-read.
- An observation with no recording attached no longer describes its selected clip as
  playing.
- Moving through the clip list with Tab reaches the controls of the clip you are on,
  rather than a Delete button on every row. Clicking any row's controls is unchanged.
- On a frozen observation, a clip's Delete now says that the clip set is frozen instead of
  disappearing from the keyboard — completing a change that reached the toolbar in 1.3.1
  but not the rows.
- Cells in the dataset grid name their record as well as their column, so moving across a
  row tells you whose values you are reading.
- The codebook tree's left and right arrows move into and out of a branch, not only open
  and close it.

From a fourth pass:

- Space works on buttons again throughout the Observations and conversation workbenches.
  Pressing it on a toolbar button did nothing — and on an observation it started the video
  instead, because the workbench claimed the key whenever its clip list was the active
  panel, whether or not your focus was actually there.
- Arrow keys act on the list only when you are in it. Moving through the toolbar and
  pressing an arrow used to change which clip was selected behind you, silently; on an
  observation the left and right arrows went further and moved a clip's boundary — an edit
  to your data from a key aimed at a button.
- Keys pressed inside an open menu no longer also act on the page behind it. One press of
  Down moved both the menu and the clip selection underneath it.
- A transcript row costs no tab stops until you select it. Every segment carried a quote
  button, and every note on it another, all named the same way with nothing to say which
  segment they belonged to. The document workbench had the same problem. They now name
  their segment, and the quote button reports whether pressing it will add or remove a
  quote — it previously said a segment was quoted when only a phrase inside it was, so
  pressing it added a quote rather than removing one.
- The chart no longer announces a change of chart type when nothing is selected and no
  chart is on screen. When adding a second variable replaces a histogram, the reason is
  now stated where the chart is, rather than only on the chart-type picker.
- Value labels on a dumbbell chart are hidden when they would overlap, and only the ones
  that overlap — a label with room to itself keeps its number. Three values used to render
  on top of each other as one unreadable run.
- The colour picker costs one tab stop instead of sixteen, and each swatch says its colour
  by name. Every swatch previously announced its hex code, which cannot be told from the
  next one by ear. This is the same picker used for codes, categories, canvas themes,
  participants, datasets and settings.

From the third pass:

- Tabbing the clip list no longer walks into the code chips of clips you have not
  selected. The first version of this change moved only the Delete button; a coded row
  still spent a stop on every chip, every remove button, its Add-code control and every
  note badge. The same rule now applies in the conversation and document workbenches,
  which had never had it — a long transcript could cost several hundred tab stops.
- The remove button on a code chip is visible when you tab to it. It was reachable while
  fully transparent, so the focus ring landed on something that could not be seen.
- A clip says "now playing" only while something is playing, and "paused here" when the
  playhead is simply parked in it. Any clip starting at 0:00 previously claimed to be
  playing the moment it was selected, on a recording that had never been played.
- Dataset column headers no longer announce as "sortable". The word came from the
  drag-and-drop library, where it means drag-to-reorder, and this grid has no sort — so it
  named a capability that does not exist, once per column. The drag handle now says which
  column it moves.

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
