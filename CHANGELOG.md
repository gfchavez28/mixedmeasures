# Changelog

All notable changes to Mixed Measures are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/gfchavez28/mixedmeasures/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/gfchavez28/mixedmeasures/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/gfchavez28/mixedmeasures/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/gfchavez28/mixedmeasures/releases/tag/v1.0.0
