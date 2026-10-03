Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

This release is about numbers you can trust and large projects that keep up.
Two long-standing problems could give wrong numbers without any warning — a
common survey scale imported one point short, and a labels edit that could
change people's answers — and both are fixed. A model's labels no longer count
as people's coding progress, and large linked surveys no longer stall the app.

- 🔴 **A five-point agree/disagree question imports as five points.** Since version 1.0, a column holding all five standard answers was read as a four-point scale: "Neither agree nor disagree" got no number, so averages and every other statistic left it out, and "Agree" and "Strongly agree" scored a point low. Eight other built-in scales did the same, among them five-point frequency and seven-point agreement. **Datasets you have already imported keep their numbers** — an affected column shows its unnumbered answers as missing on the Data Quality tab. To number them, open the column's recode rule in the dataset's Variables view, add the answer, set each answer's number and save; or import the file again.
- 🔴 **Changing a number in *Value labels* can no longer change people's answers.** On a column imported as words, renumbering its value labels — say from 1–5 to 0–4 — moved every respondent's answer to another category, with no warning. That edit is now refused, and the message points to the variable's recode rule, which renumbers answers and keeps each one as written. **If you renumbered a text column this way before, check its answers against your original file** — nothing in the data shows it happened.
- 🔴 **Saved charts in an imported or duplicated project show that project's data.** A chart or canvas brought in from another project could keep pointing at the original project's coders, codes and sources, so a "Bob only" chart could show someone else's coding. Charts and canvases now point at their own project's records when a project is imported or duplicated; one imported or duplicated before this version keeps the old references.
- 🔴 **Free-text answers are counted as answers unless the whole answer is a stock phrase.** An open-text answer that merely began with a phrase like "Not enough" or "Unable to" was treated as a non-answer — in one British Election Study file, 142 of the 172 answers treated this way were real answers. Only answers such as "N/A" or "Don't know" are non-answers now, and every screen and both exports agree on which ones they are. This applies to projects you have already imported, so counts on such a column can change. The first time the app starts after the update, it brings stored numbers into line and marks the results that used them for a recompute.
- **Large linked surveys no longer stall the app.** Opening a dataset linked to tens of thousands of participants could turn the window white; it now opens in under a second. The Participants page shows 200 at a time with a search box, coding no longer fails while the participant table updates, and building that table for 122,000 participants takes about 30 seconds instead of nearly 3 minutes. If a window does stop working, the desktop app now says your saved work is safe and offers a way back.
- **A model's labels no longer count as people's coding.** Coding progress, the "N coded" figures and *Jump to uncoded* now count people only, so a model that labelled a whole column no longer makes it read as fully coded. The comparison between people and a model has its own *Model comparison* tab, which a researcher working alone can now reach. Merging a project file no longer files a model's codings under a person with the same name.
- **Coding goes out and comes back exactly.** The *Coded Segments* export now includes codings on interviewer turns, with an *Is Facilitator* column, and imports back as it is, ratings included. Imported codings treat grouped passages as one unit, as coding does, and a coding file with thousands of problems no longer freezes the page.
- **A code set keeps one value per passage, however you apply it.** A value applied by shortcut, from the code list or from the right-click menu used to sit beside the old one, and the passage then dropped out of the set's agreement figure without a word.
- 🔴 **Editing a code's rating scale no longer changes your coding.** With a passage selected, clicks inside the rating-scale dialog also counted as clicks on the code: one removed it from the passage, rating and all, and the next put it back unrated across the passage's group. **If you have edited a rating scale while a passage was selected, check that passage's codes and ratings.** The rating bar now also shows a scale change straight away, shows every anchor label rather than only the two ends, and no longer offers a point past the maximum when the step does not divide the range.
- **The desktop app's built-in browser engine is updated** (Electron 42.11.8), with the published security fixes that brings. On Windows, pages also draw and start up faster again: every release since 1.3.1 shipped the version that slowed them.
- **And a round of smaller fixes.** Undo no longer changes another coder's work after you switch coder, and undo on grouped turns gives each turn back what it had. A survey row with more values than the file has headings — usually an unquoted comma — is pointed out before you import. Changing a variable's type works out its numbers again. With blind coding on, the coder-count badge no longer names your colleagues. Screen readers are told five more things the screen already showed.

<!-- Update the next paragraph at every cut: the cut-off is the last release that used the PREVIOUS .mmproject format, not a fixed number. 1.5.4 introduced format 7; 1.5.5 writes the same format. -->
- 🔴 **Read this before you share a project file.** **Project files saved by __VERSION__ do not open in 1.5.3 or earlier** — 1.5.4 changed how a project file stores your data, and an older version refuses such a file and says so rather than importing a project that appears to be empty. **Files from older versions still open here as normal.** If you are working with a colleague, you both need **1.5.4 or later** before exchanging `.mmproject` files — 1.5.4 and __VERSION__ write the same format. **Backups (`.mmbackup`) are not affected.**
- **Coming from 1.5.4, this update adds nothing to your database's structure**, so there is no upgrade step on first launch. On its first start it does correct stored numbers for answers it now reads as non-answers, as described above. **Coming from 1.5.3 or earlier**, your database is upgraded on first launch, and a copy of it is made before that happens. **If your project matters to you, copy your data folder somewhere of your own before upgrading anyway:** a copy you control is the only one the app's own rotation can never reach. Full details in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

## Which file should I download?

Pick the one for your computer and click it:

- **macOS** (Apple Silicon — M1, M2, M3, or M4) → **[MixedMeasures-__VERSION__-mac-arm64.dmg](https://github.com/__REPO__/releases/download/v__VERSION__/MixedMeasures-__VERSION__-mac-arm64.dmg)**
- **Windows** → **[MixedMeasures-__VERSION__-win-x64.exe](https://github.com/__REPO__/releases/download/v__VERSION__/MixedMeasures-__VERSION__-win-x64.exe)**
- **Linux** → **[MixedMeasures-__VERSION__-linux-x86_64.AppImage](https://github.com/__REPO__/releases/download/v__VERSION__/MixedMeasures-__VERSION__-linux-x86_64.AppImage)**

> **Not sure if your Mac is Apple Silicon?** Click the Apple menu (top-left) → **About This Mac**. If the **Chip** line says "Apple M1" (or M2/M3/M4), this is the right file. Older Intel Macs aren't supported in this release.

You can **ignore the other files** in the Assets list below (the `.blockmap` and `.yml` files) — the app uses those for updates; you don't need to download them.

## First launch

The installers are signed (and notarized on macOS), so the verified publisher is **George Chavez**. Because the app is new and independent, your system may show a one-time prompt the first time you open it. This is normal and fades as more people install it — it is not a sign that anything is wrong.

- **macOS:** drag Mixed Measures to your Applications folder. If it doesn't open on a double-click, right-click it → **Open**.
- **Windows:** if you see "Windows protected your PC," click **More info → Run anyway** (you'll see *George Chavez* listed as the publisher).

See the [README](https://github.com/__REPO__#readme) to get started.
