Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

A corrective release, and a large one. Most of it is work that makes existing features
hold up on real research data — a survey with tens of thousands of records, a fully
coded transcript, a project with hundreds of variables.

- 🔴 **If statistical comparisons have been failing for you, this release fixes them.** In 1.3.1 and 1.3.2 every group comparison — t-test, ANOVA, Mann-Whitney, Kruskal-Wallis — returned a server error in the installed app, because the statistics library was not fully included when the app was bundled. Descriptives, frequencies and charts were unaffected. Nothing in your projects needs changing.
- **A dataset now has two views: Data and Variables.** *Data* is the grid of records. *Variables* is where a variable is described — name and label, type, value labels, which values count as missing, and its recode rules — with the rules on screen while you edit the dictionary. The old recoding link redirects automatically.
- **A recode rule can produce a new variable, leaving the original untouched**, and it records which variable and which rule produced it.
- **Applying a rule to the variable it sits on is now something you ask for.** Three paths used to apply a rule without asking, including saving your first rule. A rule in effect rewrites every stored number in that variable and there is no undo, so it is now a deliberate choice.
- **Large surveys work end to end.** A 75,699-record survey could not previously be previewed, imported, opened, or deleted. All four are fixed, and a long export no longer freezes the rest of the app.
- **Histograms, box plots and Q–Q plots**, a margin of error on frequency distributions, per-item reliability diagnostics, and guidance on when you need the non-parametric test.
- **Declare one missing-value vocabulary across many variables at once**, instead of one column at a time.
- **A withdrawal report** — for a given participant, what data traces back to them and where it lives, and a way to honour a withdrawal by redacting rather than deleting.
- **Several numbers are now correct**, including qualitative coverage on fully coded text (which read 90%), the cells counted by R and Excel exports, and a relabel that could rewrite responses to their opposite.

**Very large projects can now be shared.** Exporting, duplicating and merging a `.mmproject` file used to be refused above **500,000 dataset values**; the limit is now **4,000,000**, and both halves of the round trip were rebuilt to get there. Measured on a real 75,699-record survey with 41 questions: exporting went from about two minutes to **80 seconds** and now uses a small fraction of the memory it did, and re-importing that file went from **26 minutes to under three**. Datasets themselves import and analyse well past that point, as before. **Your backups were never affected** — `.mmbackup` has always worked at full size.

- Your database is upgraded on first launch and a backup is taken first; project files are unchanged and still open in both directions with 1.3.2. Full details, and the upgrade notes, in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

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
