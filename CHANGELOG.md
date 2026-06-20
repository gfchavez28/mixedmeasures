# Changelog

All notable changes to Mixed Measures are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/gfchavez28/mixedmeasures/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/gfchavez28/mixedmeasures/releases/tag/v1.0.0
