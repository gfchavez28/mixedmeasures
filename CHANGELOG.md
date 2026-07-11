# Changelog

All notable changes to Mixed Measures are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-10

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

[Unreleased]: https://github.com/gfchavez28/mixedmeasures/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/gfchavez28/mixedmeasures/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/gfchavez28/mixedmeasures/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/gfchavez28/mixedmeasures/releases/tag/v1.0.0
