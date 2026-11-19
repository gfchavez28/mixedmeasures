Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

This release adds **joint displays**, the table at the centre of mixed-methods
integration, and closes the places where blind coding and a withdrawal fell short. Two
figures can differ from what an earlier version showed on the same data — marked 🔴 below,
and listed with every other change in the changelog's *Upgrade notes*.

- **Joint displays put the strands of a study side by side.** Type `/` in a Canvas section and choose *Joint display*: choose the variable that forms the groups and the constructs you are integrating, and each construct shows, group by group, how many participants have coded material in your interviews, documents or survey comments, what your survey variables say and, beside the groups, what your observations show — live, as coding and data change. Record how the strands fit, write a meta-inference that keeps the numbers it was written against, pin each group's own quotes, and list the cases that don't fit with a reason for each. The Report view is the table the Word, Markdown, HTML and PDF exports print; in blind mode it shows only your coding, and a withdrawal removes the person's words from it.
- 🔴 **The code-by-group comparison takes its exact test at ordinary group sizes.** 1.6.0 said three or more groups take an exact test, but with five groups of about 18 participants it fell back to a simulated p-value, which cannot go below 0.0001 and gave the correction across codes nothing to work with. Those tables are now counted exactly, so p-values, adjusted p-values and stars can differ from 1.6.0's (adjusted p-values usually fall). Only a comparison with very many possible tables still uses the seeded simulation, and says so.
- 🔴 **The saturation curve counts only the sources you selected.** With interviews selected, 1.6.0's curve still counted every document and observation clip in the project. It now counts exactly what you selected; a saturation chart already on a Canvas says it changed until you mark it reviewed.
- **Blind mode now covers participant rating scores.** A participant's rating score averages every coder's ratings, so in 1.6.0 a blind coder could read a colleague's rating off the participant table, a chart or test over a score, a group made from a score band, or the datasets workbook and R export. While your colleagues' coding is hidden, those scores and everything worked out from them are left out, and each place says how many it left out or why. A colleague's code is no longer marked as yours either: only your own chips offer *Remove code*, and the **+ Add code** list and Text Coding's code panel mark only the codes you applied.
- **A withdrawal reaches further, and names more of what it cannot reach.** A transcript can no longer bring a withdrawn person back by writing their name in other capitals or with its accents encoded differently, and withdrawals made before 1.5.8 are now remembered too. Deleting a conversation or a dataset removes the edit wording it left in the audit trail. The confirmation now also names projects duplicated before the withdrawal and the database copies taken before each update, and counts the canvas quotes it cannot place.
- **A deleted item's number is never given to the next one made.** A memo on a deleted conversation could appear on the next conversation imported, and a chart saved over a deleted variable group could draw the next group under its name.
- **Canvas write-ups export as you wrote them.** A quote keeps its paragraphs, @mentions and line breaks no longer vanish, and the Word file keeps lists, block quotes, numbering and working links. An exported comparison table has the screen table's columns. Undo brings a deleted section back whole, and inserting two materials in a row keeps both.
- **And smaller fixes.** Seven in-app links that asked for a new tab now open in the desktop app, the R script matches the app for undeclared codes and grouped saved means, the comparison's effect column reads true, and the desktop app moves to Electron 44.11.2, which fixes a Chromium bug attackers were exploiting (CVE-2026-125350).

<!-- Update the next paragraph at every cut: the cut-off is the last release that used the PREVIOUS .mmproject format, not a fixed number. 1.5.4 introduced format 7; 1.5.5 to 1.6.0 wrote it. 1.7.0 introduced format 8 (the joint display), so files it saves open only in 1.7.0 or later. -->
- 🔴 **Read this before you share a project file.** **Project files saved by __VERSION__ do not open in 1.6.0 or earlier** — __VERSION__ stores joint displays in the project file, and an older version refuses such a file and says so rather than importing it without them. **Files from older versions still open here as normal.** If you are working with a colleague, update together before you exchange `.mmproject` files. **A backup (`.mmbackup`) made by __VERSION__ is refused by 1.6.0**, which says so and changes nothing.
- **A withdrawal made before 1.5.8 is now remembered, so a project may ask you to repeat one.** The first launch rebuilds each earlier withdrawal's record from the audit trail, and a withdrawal made before 1.5.8, which kept none, gains one. If a project still holds someone under such an ID — the person came back, or someone else was given the ID — a merge, a *Duplicate* or a copy for coding of it stops and asks you to withdraw them: do so if it is the same person, or give the other person another ID.
- **If your team shared a project before 1.5.8, the first merge after updating may ask about people you already work with.** Each computer gave its coders an identity of its own when it updated, so Merge's *Confirm coders* step can know a colleague here only by name, and waits for your answer. Choose *Map to* their name only for the same person, and *Add as new coder* for anyone else: a wrong answer makes two people one coder, or one person two. This version does not yet remember a *Map to* answer, so the question comes back at each merge of that colleague's copy.
- 🔴 **This update changes your database, and takes a copy first.** The first launch rebuilds ten tables so that a deleted item's number is never given to a new one, adds one index to your codings, removes the edit wording deleted sources left in the audit trail and upgrades the record of earlier withdrawals — and, coming from a version before 1.6.0, also makes the earlier versions' changes. The copy needs free disk space about the size of your database. The startup screen says it is updating your data; keep Mixed Measures open until it finishes — a large project can take several minutes. If the update fails, it is undone completely and your previous version can still open the data. **Once __VERSION__ has updated your data, do not go back to an earlier version:** 1.6.0 and 1.5.8 refuse to open it and change nothing, and 1.5.7 and earlier cannot open it either and replace one of the copies taken before the update at each attempt, until none from before it is left. If something goes wrong, install __VERSION__ again. **If your project matters to you, copy your data folder somewhere of your own before upgrading:** a copy you control is the only one the app's own rotation can never reach. Full details in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

## Which file should I download?

Pick the one for your computer and click it:

- **macOS** (Apple Silicon — M1 or later) → **[MixedMeasures-__VERSION__-mac-arm64.dmg](https://github.com/__REPO__/releases/download/v__VERSION__/MixedMeasures-__VERSION__-mac-arm64.dmg)**
- **Windows** → **[MixedMeasures-__VERSION__-win-x64.exe](https://github.com/__REPO__/releases/download/v__VERSION__/MixedMeasures-__VERSION__-win-x64.exe)**
- **Linux** → **[MixedMeasures-__VERSION__-linux-x86_64.AppImage](https://github.com/__REPO__/releases/download/v__VERSION__/MixedMeasures-__VERSION__-linux-x86_64.AppImage)**

> **Not sure if your Mac is Apple Silicon?** Click the Apple menu (top-left) → **About This Mac**. If the **Chip** line says "Apple M1" (or any later Apple chip), this is the right file. Older Intel Macs aren't supported in this release.

<!-- Requirements: re-check at every cut. macOS from electron/package.json build.mac.minimumSystemVersion (the release's "macOS floor" step proves it against every binary); Windows from Electron's own README "Platform support"; Linux from the AppImage's highest GLIBC_ symbol version (2.38 measured on v1.5.5 — the frozen backend's libraries, collected on the ubuntu-24.04 runner). -->
**What it runs on**

- **macOS 14 (Sonoma) or later**, on Apple Silicon. A Mac on an older version is not offered this update; every Apple Silicon Mac can be updated to macOS 14.
- **Windows 10 or 11**, 64-bit.
- **Linux**, 64-bit, with glibc 2.38 or newer — Ubuntu 24.04 or later, for example.

You can **ignore the other files** in the Assets list below (the `.blockmap` and `.yml` files) — the app uses those for updates; you don't need to download them.

## First launch

The Windows and macOS installers are signed (and notarized on macOS), so the verified publisher is **George Chavez**; the Linux AppImage is not signed. Because the app is new and independent, your system may show a one-time prompt the first time you open it. This is normal and fades as more people install it — it is not a sign that anything is wrong.

- **macOS:** drag Mixed Measures to your Applications folder. If it doesn't open on a double-click, right-click it → **Open**.
- **Windows:** if you see "Windows protected your PC," click **More info → Run anyway** (you'll see *George Chavez* listed as the publisher).

See the [README](https://github.com/__REPO__#readme) to get started.
