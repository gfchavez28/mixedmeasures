# Changelog

All notable changes to Mixed Measures are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.2] - 2026-08-15

A security and packaging patch. There is no new capability here and nothing in
your projects changes. **Linux users should update**: the AppImage published up
to and including 1.3.1 could load code from the folder it was launched from.

### Upgrade notes

- **Linux (AppImage): please update, and prefer launching from a folder only you
  can write to.** Every Mixed Measures AppImage up to 1.3.1 was built with a
  packaging tool that wrote a startup script placing the *current working
  directory* on the system library search path. Anyone able to write a file into
  the folder you launch the AppImage from could therefore have had their code
  loaded into the app. This was a defect in the build tool, not in Mixed Measures'
  own code, and it is fixed by rebuilding with the corrected tool — so it is fixed
  simply by installing 1.3.2. There is no sign it was exploited, and it did not
  affect the Windows or macOS builds.
- **Windows: this release changes how updates verify their signature.** The
  publisher name the updater checks a download against moved as part of the
  packaging upgrade. Updating to 1.3.2 works normally; the change matters for
  updates *after* it.
- **Everyone else: nothing to do.** No database migration, no format change, and
  `.mmproject` / `.mmbackup` files are unaffected in both directions.

### Fixed

- **Linux AppImage: arbitrary code could be loaded from the launch directory**
  (CVE-2026-54672, high). The generated startup script set `LD_LIBRARY_PATH`,
  `PATH`, `XDG_DATA_DIRS` and `GSETTINGS_SCHEMA_DIR` with a trailing empty entry,
  which the dynamic linker resolves to the current directory. Fixed by upgrading
  the packaging toolchain; the corrected script guards every one of those
  variables.
- **The "could not start" dialog mangled non-English folder names.** When the
  backend failed to start, the recovery message names the folder it could not
  open — and any character outside the Windows default encoding was replaced or
  dropped, so the dialog could point at a path that does not exist. It now
  carries its own text encoding end to end. A folder name containing a
  non-breaking space was corrupted by a separate bug in the same message and is
  fixed too.
- **Merging a colleague's copy of a project no longer accepts edited transcripts.**
  If two people held the same project and one corrected the wording of a segment,
  a merge would keep one side's text while re-anchoring the other side's
  highlights onto it — silently attaching quotes to words nobody had quoted. The
  merge now refuses, names the affected segments, and asks which text is correct.

### Changed

- The desktop packaging toolchain (electron-builder) was upgraded a major
  version, and the Python bundler is now pinned exactly so a given release is
  always built by the same toolchain.

## [1.3.1] - 2026-08-14

A correctness and accessibility release. No new capability to speak of — this
fixes numbers that were wrong or wrongly labelled, finishes the qualitative
Canvas that 1.3.0 shipped with a stated limitation, and makes a large part of the
app reachable without a mouse.

### Upgrade notes

Please read these before updating. Several of them change numbers you may
already have written down or reported.

- **If you reported an effect size from a group comparison, check which
  statistic it was.** The comparison table chose its effect-size heading from the
  **number of groups** while the number itself came from the **test that ran**.
  Where those disagreed — a Welch's t-test across three groups is the common
  case — the table showed Cohen's *d* under an ω² heading, and the tooltip
  described it as a negative η². The heading, the tooltip and the value now all
  come from the test. Nothing about your data changed, but a figure copied from
  that table may be labelled with the wrong statistic.
- **The group-comparison CSV and the screen now report the same effect size.**
  The export wrote η² while the screen showed ω². If you have both a file and a
  screenshot from the same analysis, they will have disagreed; the file now
  matches the screen.
- **Significance stars in exports now follow the thresholds you chose.** The CSV
  always marked significance at the conventional .05/.01/.001 levels regardless
  of the levels set for the analysis. If you changed those levels, the stars in
  files exported before this release do not reflect them.
- **A statistic that cannot be computed now says so instead of showing `0.00`.**
  A correlation with too few values, a comparison with an empty group, a test on
  data with no variance — all previously displayed `0.00`, which reads as *no
  relationship* when the truth is *not computable*. These now show `—` with the
  reason. **Re-check any table where you recorded a zero:** some of those zeros
  were real measured zeros and some were this.
- **A scale score now states what it averaged and over how many people.** A
  crosswalk scale score is the unweighted mean of its items' means. It previously
  showed a single pooled *n* that summed each item's respondents — so a score
  built from a 1,000-response item and a 10-response item quoted *n* = 1,010,
  when no single estimate rests on 1,010 people. It now reads `3 items · n
  210–260`, with the pooled total named as a total in the tooltip. The figure
  labelled "95% CI" is computed **across items**, not across respondents, and is
  now labelled as such — any confidence interval reported from a scale score
  should be re-described. The score also now warns when its items are measured on
  different scales (a 1–5 item averaged with a 1–7 one), at the point where the
  score is created and again where it is read.
- **Note numbers in the Excel export are real numbers now.** Notes on documents,
  observation clips and dataset cells were all stored as `0`, so the export wrote
  `N-0` for every one of them while the workbench showed a sensible number. They
  are numbered per source now — and **gaps are correct**: deleting note 2 leaves
  1 and 3.
- **Quote positions in text containing emoji or rare CJK characters are repaired
  on first launch.** Where a quote sat in a segment containing such a character,
  the stored position drifted and the quote could resolve to the wrong words in
  exports and on the Canvas. This is corrected automatically the first time you
  open this version. Ordinary text was never affected, and nothing needs to be
  re-quoted by hand.
- **Some things look different.** Text boxes, dropdowns and outlined buttons now
  have a clearly visible border — they were nearly invisible against the page.
  Dimmed text on selected and now-playing rows is darker, several status and
  source colours were adjusted to meet contrast minimums, and a few error
  messages that were almost unreadable now aren't. Nothing moved; only contrast
  changed.

### Added

- **Text size control.** Settings → Appearance now has a text-size setting with
  **Ctrl/Cmd +**, **−** and **0** shortcuts, and the choice persists across
  restarts. The packaged desktop app previously had no way to enlarge text at
  all.
- **A split says what it left behind.** Splitting a segment carries its quotes
  onto the halves; where a quote had a note attached, the split now tells you how
  many notes stayed with the original rather than moving them silently.

### Changed

- **Qualitative charts can be embedded in a Canvas.** 1.3.0 shipped with this as
  a stated known limitation — code frequency, co-occurrence, saturation,
  comparisons, the summary table and the timeline could be saved as materials and
  then rendered as an empty "No data configured" box. All of them draw now, they
  export as images alongside the quantitative charts, and a material whose source
  has since been deleted says so instead of rendering blank. **That limitation is
  retired.**
- **The qualitative Sort control now moves the codes.** Choosing Alphabetical or
  Count with codes on the row axis left them in import order, and the Custom
  order — which you could author by dragging — never reached a chart at all. All
  four orders now apply to the code axis of the heatmap, bar and stacked bar, and
  a custom order travels with a chart saved to a Canvas.
- **Codes come before Notes** on every coding surface, consistently.
- **Declaring a missing value tells you what it did** to the column, rather than
  reporting only when it failed.

### Fixed

**Analysis and exports**

- The Descriptives summary table now takes every number from one source, so its
  counts, percentages and per-source columns follow your selection instead of
  mixing a selection-scoped count with a project-wide percentage.
- Its per-kind columns follow the selection too: an observations-only selection
  no longer reports "Conv. 1, Participants 11" for a selection containing
  neither.
- The comparison table explains a blank cell (too few usable values in a group)
  instead of leaving it empty.
- Every group-comparison export gets its own filename, so a second export no
  longer silently overwrites the first.
- Chart exports keep non-Latin characters in the filename — a wholly non-Latin
  chart name previously produced a file called `.png`.
- The Code-Conversation Matrix and the study CSV cover documents and observations
  as well as conversations.

**Coding, quotes and notes**

- A bulk code that partially fails is reported as a failure. Rows could
  previously be left painted as coded, with attribution, when nothing had been
  applied.
- A quote taken from a document carries its source on the Canvas and in every
  export; it previously had none.
- Dragging a quote onto a Canvas theme now produces the same embed as inserting
  it — the dragged version lost its text, its attribution and its clip link.
- Observation notes appear on the project-wide Memos & Notes page, and memos on
  documents and observations show a proper label and filter instead of a raw type
  name.
- Merging a colleague's project no longer disturbs quote positions that were
  already correct.

**Desktop app**

- A startup failure the app cannot recover from now shows what happened and what
  to do about it, instead of "the local engine exited unexpectedly" — including
  when the message contains a non-English path.
- Only one dialog appears when startup fails, and it is the one that names the
  cause.
- Canvas snapshot rotation no longer depends on which of two snapshots taken in
  the same second is judged older.

**Accessibility**

- The codebook tree, the source picker and the code picker are reachable and
  navigable by keyboard, and announce their structure and position instead of a
  flat list.
- The variable-group grid costs one tab stop with arrow-key movement inside it,
  rather than one tab stop per cell.
- A clip list tells a screen reader how many clips it has, rather than how many
  happen to be on screen.
- Colour swatches and menus on a code row no longer announce as unavailable while
  being fully operable.
- On a frozen observation, splitting and merging explain that the clip set is
  frozen instead of vanishing from the keyboard entirely.
- A code chip announces who applied it instead of reading out the badge initials.
- The app is usable at 200% zoom and at narrow window widths without the page
  scrolling sideways.
- Charts, tables, popovers and dialogs carry names; the skip link works; and the
  focus indicator and text colours meet contrast minimums across both themes.

## [1.3.0] - 2026-08-02

### Upgrade notes

Please read these before updating. Several of them change numbers you may
already have written down or reported.

- **SPSS `.sav` data imported before this release should be re-imported.**
  v1.2.0 correctly kept values SPSS had flagged as user-missing (for example
  "99 = Refused") out of your statistics — but it did so by discarding them
  outright rather than storing them as missing, so a refusal and a genuinely
  unanswered question became indistinguishable, and you could no longer count how
  many people declined to answer. This release stores them, marked as missing.
  **Data already imported cannot be repaired in place** — those cells were never
  written, so there is nothing to recover from. Re-import the `.sav` file to get
  the full record. Datasets imported from CSV or Excel are unaffected.
- **Coverage percentages will drop for recordings whose length was previously
  unknown.** `.mov` and `.webm` recordings never had their duration read, so
  coverage was measured against the end of your last clip rather than the end of
  the recording — which the coding itself defines, so it always read close to
  100%. The app now reads the true length on startup and coverage is measured
  against it. On one test project this moved a recording from 50.0% to 26.4%.
  Nothing about your coding changed; the denominator was wrong and now isn't.
- **Project-wide intercoder reliability changes if you have a frozen, coded
  observation.** Frozen clips now count toward the project's kappa and
  Krippendorff's alpha alongside conversations and documents. Reliability figures
  from v1.2.0 are not directly comparable — recompute before quoting them.
- **The study CSV export replaces one column with two.** `conversation_name`
  becomes `source_type` + `source_name`, because that file now includes document
  segments (silently missing since documents shipped) and observation clips
  alongside conversation turns. Every other column keeps its name, so a script
  reading `segment_id`, `text` or `code_3` still works — only the source column
  moves.
- **Dragging a code or a note onto a segment has been removed.** It worked, but
  it was mouse-only with no keyboard equivalent, screen readers announced it as
  meaningless ids, and in three of the four coding surfaces codes advertised
  themselves as draggable with nowhere to drop. Dragging a note also could not be
  undone. Every gesture it offered has a better equivalent, all unchanged: click
  a code in the rail, use its number/chord shortcut, or attach a note from the
  Notes panel (which is undoable, and has a keyboard path).
- **Code text is now pure black on light-coloured codes.** Three of the sixteen
  code colours previously rendered their label below the WCAG AA contrast
  minimum. Every code chip, node and clip bar is affected, so your codebook will
  look slightly different.

**Known limitation:** qualitative charts (code frequency, co-occurrence, and the
other qualitative material types) still cannot be embedded in a Canvas. They are
correctly labelled as such rather than silently rendering as something else, and
the full set is planned for a following release.

### Added

- **Observations — code a recording with no transcript.** A recording of an
  *event* rather than a conversation — a classroom, a clinic visit, a home visit,
  a usability session — is now a source in its own right, coded directly on its
  own timeline. Import a recording on its own and start from an empty timeline,
  cut it into fixed intervals for interval-style coding, or seed labelled clips
  from a `.vtt`/`.srt` cue file; the wizard shows the clip count, the first clips
  and any warnings before writing anything. Mark and adjust clips from the
  keyboard (**I/O** for in/out points, **J-K-L** transport with frame stepping,
  0.1 s boundary nudges, typed timecodes, split and merge by time), with a follow
  mode that keeps the view on the playhead. Clips carry codes, notes and
  time-range quotes, and reach search, the Canvas and the qualitative analysis
  surfaces like any other source.
- **Coverage for observations** — what share of the timeline you have marked,
  with a jump to the next unmarked gap.
- **Reliability for observations, both ways of cutting.** Leave the clip set
  **open** and each coder marks their own boundaries — agreement is then a
  unitizing problem, reported as Krippendorff's alpha at 100 ms resolution plus
  time-binned kappa, with the bin size shown as part of the result and per-code
  prevalence beside every kappa. **Freeze** the clip set once the team agrees the
  cuts and every coder codes the same clips, which brings the ordinary kappa,
  side-by-side reconciliation and the consensus layer to video unchanged.
- **Timed analytics per code** — duration, frequency, rate per minute, share of
  session airtime, bout length, and a stacked codeline of the whole session.
  Because clips can overlap, per-code airtimes don't sum to covered time, and the
  table says so.
- **Re-use a recording across source types.** "Also code this as an observation"
  (and the reverse) copies the file rather than re-uploading it, leaving the
  original source and all of its coding untouched.
- **Declared value labels for numbers-only columns.** A CSV whose cells are bare
  codes (`1`–`5`) can now be given a code-to-label dictionary — during import or
  afterwards — and the column behaves exactly as if it had arrived from SPSS with
  labels attached. Appending a code-format file to a labelled column maps it
  correctly.
- **Declared missing values.** Any column can declare which of its values mean
  "missing" — individual codes, or a numeric range such as `-99 THRU -1` —
  through a three-way choice in the column dictionary: use the built-in defaults,
  declare that nothing is missing, or list your own values. Every analysis,
  grouping, chart, data-quality check and R export honours the declaration
  consistently, so a "Prefer not to say" no longer counts as a real response
  anywhere. SPSS files bring their own declaration with them.
- **Observations appear across the app** — a card and stat on the project
  Overview, a fourth import path, a search filter, and inclusion in the
  qualitative analysis surfaces.

### Changed

- Code and note drag-and-drop was removed from the coding workbenches; see the
  upgrade notes above.
- Code label text now uses pure black or white for contrast, whichever the code's
  colour requires; see the upgrade notes above.
- The Excel study export spans all three source types and gains a **Quotes**
  sheet. On one real project this added 68 document rows that had never reached
  the workbook.
- REFI-QDA codebook exchange (`.qdc`) now uses the namespace the standard
  actually specifies. Files exported by earlier versions used a malformed
  namespace and would not open in other QDA software; import accepts both, so
  existing files still work.

### Fixed

- **Value labels could invert a reverse-scored column**, rewriting every response
  to its opposite. This is now refused rather than applied.
- **Reverse-scored recodes reflected around the wrong midpoint** when a column
  contained a missing code — a mapping like `{Never: 1, Always: 5, Prefer not to
  say: 99}` was reflected around 100, silently scoring "Never" as 99. Missing
  values no longer define the scale, and affected recodes repair themselves on
  startup.
- `.mov` and `.webm` recordings now have their duration read correctly; existing
  recordings are filled in on startup.
- Descriptives were unreachable in projects that contained only observations.
- The project Overview no longer describes an observation-only project as empty.
- A clip quote is no longer lost when its clip is split or merged.
- The Canvas Materials drawer no longer renders a clip quote as a blank, nameless
  row.
- Diagnostic logging was silently disabled in the packaged app, so failures that
  were caught and logged — a failed automatic backup, for instance — left no
  trace. Logging works again.
- `/analysis/integrated` reaches the Canvas again instead of redirecting to the
  project list.
- Merging a colleague's copy of a project now respects a frozen clip set from
  both directions: their clips can no longer be silently added to an observation
  you have frozen, and you are no longer told to "re-segment to match" when your
  own cuts are legitimately still open.
- Dependency updates clearing four advisories, including one in the shipped
  desktop tree.

## [1.2.0] - 2026-07-11

### Added

- **Video coding.** Conversations can now carry a video recording (`.mp4`,
  `.mov`, `.webm` — up to 4 GB) alongside or instead of audio. The video plays in
  a pane beside the transcript with the same timestamp synchronization as audio,
  so focus-group and observation footage can be coded without leaving the
  workbench. A recording — audio or video — can also be attached directly in the
  conversation-import wizard rather than afterwards. Automatic backup snapshots
  deliberately exclude video to stay small; downloaded backups include it by
  default, with an "Include video" option in Settings.
- **SPSS `.sav` dataset import.** Import and append `.sav` files anywhere you can
  import a CSV or Excel file. SPSS's own value labels, scale order, and
  user-missing codes come across, so an ordinal variable arrives with the order and
  the codes it was recorded with — a 0–3 scale stays 0–3 — instead of being guessed
  from the text. Values flagged as user-missing in SPSS (for example "Refused") are
  treated as missing rather than as an extra scale point.
- **Participant-ID columns now link your data automatically.** Columns like
  "Participant ID" or "Respondent" are recognized as identifier columns
  (previously they were discarded as import noise) and can link dataset rows to
  the project's participants — during import, when appending, or retroactively
  from the dataset view — so a person's survey record and their interview turns
  connect without hand-matching. Existing manual links are never overwritten, and
  ambiguous (duplicated) identifier values are left unlinked rather than guessed.
  The dataset view's per-row Link popover can also create a new participant from
  the row's ID in one step, and R exports carry identifier columns as plain
  character ID columns for joining external data (leading zeros preserved, no
  statistics computed on IDs).
- **Automatic updates.** The desktop app now keeps itself current: it checks
  quietly on launch and every few hours, downloads new versions in the
  background, and installs only when you choose "Restart to update" (or on your
  next quit) — never mid-work. Choosing "Restart to update" takes a fresh backup
  first. The check sends only the app's version and platform to github.com,
  nothing else, and can be switched off in Settings → Software update. This makes
  v1.2.0 the last release that has to be downloaded by hand.
- **Citation support.** A `CITATION.cff` file makes GitHub render a "Cite this
  repository" entry, and **Settings → About & citation** shows the running version
  with copyable APA and BibTeX references. Cite the version you analyzed with —
  it is part of what makes an analysis reproducible.
- The README now states support expectations (solo maintainer; Issues for bugs,
  Discussions for questions) and links the citation formats.

### Fixed

- Conversation import matches speaker names to participants after trimming
  stray spaces, so a trailing space in a CSV speaker label no longer silently
  creates a duplicate participant.
- Reverse-scored recodes now reflect a scale about its own midpoint. Scales
  numbered from 1 are unaffected; a scale numbered from 0 no longer reversed into
  values outside its own range.
- **SPSS import: partially-labelled scales import at full width.** SPSS files
  routinely label only a scale's endpoints (1 = "Not at all" … 7 = "Extremely");
  those scales previously imported as two-point scales and quietly dropped every
  mid-scale answer. Unlabelled in-range codes now become scale points, codes
  outside the scale surface as a warning instead of vanishing silently, and a
  label span too wide to be a scale (1 = "Low" / 100 = "High") imports as plain
  numbers.
- **R export converts ordinal and binary factors back to their real codes.**
  Exported scripts previously used R's positional factor coding, which shifted
  means for 0-based scales, diverged correlations for gapped code sets, and could
  error outright on statistical tests over ordinal columns.
- Appending rows to a reverse-scored column re-applies the reverse scoring to the
  new rows (they previously landed forward-coded next to reversed neighbors).
- The SPSS row-count cap now binds while reading the file, so a file whose header
  under-reports its size can no longer exhaust memory.
- Dropping an `.xlsx` or `.sav` file onto the Datasets page now opens the import
  wizard (previously only `.csv` was accepted there).
- The BibTeX citation renders on screen in Settings, so it remains reachable when
  the browser clipboard is unavailable (plain-http deployments).
- **Leaving the import wizard while a recording is still attaching is now safe.**
  A recording that finishes attaching after you navigate elsewhere announces
  itself with a notification instead of yanking you into the workbench — and a
  failed attach shows a notification instead of failing silently (previously the
  conversation simply had no recording, with no message at all). Import warnings
  also now survive the recording-failed path: they appear on the failure card and
  after a successful retry.
- The conversations list shows a just-attached recording immediately, instead of
  serving a cached "no recording" state for up to a minute.
- Uploads that fill the disk now report "not enough disk space" reliably — the
  earlier phase of the upload pipeline previously reported a generic server error.
- Very large recording uploads on a slow connection no longer time out just short
  of completion (the timeout ceiling now covers a maximum-size file at the
  slowest assumed transfer rate).
- **SPSS import: two codes sharing one value label stay distinguishable.** Each
  duplicated label is suffixed with its code ("Agree (1)" / "Agree (2)") instead
  of the two answers silently collapsing onto one number.
- SPSS import: values declared missing on *text* variables (for example "XX" or
  "SKIP") now import as missing instead of as answers.
- Reverse-scored recodes with a non-numeric entry in the mapping (for example a
  "not scored" label) now reverse the numeric values consistently everywhere —
  previously a single such entry could leave individually edited cells
  un-reversed while bulk-applied cells were reversed.
- Editing a scale's recode mapping now also updates the column's stored scale
  metadata, so exports and appends that fall back to it can't see pre-edit codes.
- Creating a category-grouping recode as a column's first recode now clears the
  column's numeric encoding, matching what editing one already did.

## [1.1.1] - 2026-07-03

### Fixed

- The "Add coder" entry point now appears in Settings (Coder identity) and in
  the projects-screen coder menu, including on single-coder installs.
  Previously the only place to add a coder was a menu that exists only inside
  an open project, which left the team-coding features hard to discover.

## [1.1.0] - 2026-07-03

### Added

**Team coding.** A project can now be coded independently by several
researchers and brought back together.

- Coder identities: a coder roster with quick switching, per-coder attribution
  badges on every coding, a per-coder visibility filter, and coder archiving.
- Blind coding: on multi-coder projects, colleagues' codings are hidden by
  default while you code; revealing them is a deliberate, logged action.
- A derived consensus layer (majority agreement across coders) that recomputes
  automatically as coding changes, with a coding-layer selector (your coding
  vs. consensus) on the analysis and codebook surfaces.
- A reconciliation view showing each coder's codes side by side per segment,
  with disagreements flagged — reconcile by editing your own layer inline.
- Inter-rater reliability: Cohen's kappa (two coders), Krippendorff's alpha
  (more), and percent agreement — validated to match R's `irr` package
  exactly, and emitted into the R script export.
- Project merge for distributed coding: share a copy of a project with
  co-coders ("copy for coding"), then merge their coded copies back. Merging
  matches shared sources by stable identity, asks you to confirm how coders in
  the file map to coders on your machine, and walks you through reconciling
  codebooks that diverged while apart.
- A codebook freeze (soft lock) for distributing a stable codebook to
  co-coders.

**New import formats.**

- Excel workbooks (`.xlsx`) import directly as datasets, with a sheet picker
  and append support. Formula cells import their last-calculated values;
  legacy `.xls` and SPSS `.sav` files are not supported.
- Zoom and Microsoft Teams transcripts (`.vtt`/`.srt`) import directly as
  conversations — consecutive captions from the same speaker merge into turns,
  and cue timestamps carry over for audio sync.

**Analysis and navigation.**

- A codebook Overview treemap showing each code's share of coding at a glance
  (replaces the force-directed Network view).
- Duplicate project from the dashboard, and the projects list now orders by
  real last activity.
- In-vivo coding: creating a code while text is selected prefills the code
  name with the selected text.
- Text-coding "randomize order" now actually shuffles and takes an optional
  seed for reproducible review passes.
- Dataset import discloses which values (N/A, "Don't know", refusals) will be
  treated as missing.
- R export gained additional ggplot2 chart types alongside the new
  inter-rater reliability block.

### Changed

- The coding workbenches are fully keyboard- and screen-reader-navigable (the
  virtualized transcript, document, and text lists expose proper listbox/grid
  semantics with focus management).
- Consistent terminology: open-ended dataset responses are called "text"
  throughout (previously a mix of "comment" and "text"), and analysis surfaces
  scoped by blind mode now label that scope explicitly.
- Visual consistency pass: one shared style for selected/active states across
  the app, larger click targets for color swatches, and workbench toolbars
  that wrap instead of clipping controls on small windows.

### Fixed

- A full numbers audit of displayed statistics, charts, and exports against an
  independent oracle (and real R): corrected bar-chart label alignment when
  zero-count groups are hidden, group counts shown next to comparisons,
  text-analysis denominators that could disagree with the coding-progress
  gauge, code-usage counts on multi-coder projects, and a negative chi-square
  edge case in the missing-data (MCAR) test. Exported `.mmproject` files and
  R scripts reproduce the app's numbers faithfully.
- Merging codes or categories no longer risks losing codings that were being
  reassigned in the same operation.
- Document notes now appear on the Memos & Notes page.
- Assorted smaller fixes: clearer error messages, recode tooltips, source
  filter labels, and copy corrections.

## [1.0.1] - 2026-06-20

### Fixed
- Windows installer is now re-signed with an RFC-3161 timestamp so the
  Authenticode signature stays valid after the short-lived signing certificate
  rotates. The v1.0.0 Windows installer began showing "Unknown publisher" once
  its certificate expired; this release restores the verified-publisher
  signature. macOS (Apple Silicon) and Linux downloads are unchanged.

## [1.0.0] - 2026-06-19

First public release. Signed installers for Windows and macOS (Apple Silicon),
plus a Linux AppImage, are attached to the release on the
[Releases page](https://github.com/gfchavez28/mixedmeasures/releases).

### Added
- Local-first desktop workspace for mixed-methods research: import datasets (CSV),
  documents (`.docx`, `.pdf`, `.txt`), and conversation transcripts (CSV, with
  optional synchronized audio).
- Three keyboard-driven qualitative coding surfaces (conversations, documents,
  open-ended text columns) over a shared codebook, excerpts, memos, and notes.
- Quantitative analysis: descriptives, group comparisons (t-test, ANOVA,
  Kruskal–Wallis, Mann–Whitney), correlation, cross-tabulation, reliability, and
  scale/domain aggregation.
- A shared participant/speaker identity spine linking survey records to interview
  speakers across sources.
- An integration **Canvas** for writing findings with live excerpts, memos, and
  analysis results embedded inline.
- Project portability (`.mmproject`), codebook exchange, R script export, and
  multi-format data export.
- At-rest database encryption (SQLCipher) and a layered backup system in packaged
  desktop builds.

[Unreleased]: https://github.com/gfchavez28/mixedmeasures/compare/v1.3.2...HEAD
[1.3.2]: https://github.com/gfchavez28/mixedmeasures/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/gfchavez28/mixedmeasures/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/gfchavez28/mixedmeasures/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/gfchavez28/mixedmeasures/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/gfchavez28/mixedmeasures/releases/tag/v1.0.0
