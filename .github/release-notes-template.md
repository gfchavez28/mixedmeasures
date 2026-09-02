Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

The reliability release. Two features that belong together: every reliability
coefficient now says how precise it is, and a code can carry a rating scale so
coders record not just *whether* something is present but *how much*.

- **Confidence intervals on the reliability coefficients.** Cohen's kappa and Krippendorff's alpha now report a 95% interval alongside the figure, so you can see whether a coefficient is precise enough to lean on — and the app tells you when an interval spans an interpretation cutoff, rather than letting a single number read as more settled than it is. Two coefficients deliberately report no interval and say why, instead of leaving a blank you would have to interpret.
- **Rating scales on codes.** A code can declare a scale — minimum, maximum, step, and labels for the ends — and a coder rates each application on it: *how much does this segment have this characteristic?* **Unrated is a real state and is never treated as zero**, which matters on a scale that runs from negative to positive, where zero is a genuine middle. Ratings flow through the whole tool: agreement on the ratings is measured per code, the consensus layer carries the coders' median and flags them when they differ by more than one step, reconciliation gains *Ratings differ* and *Merge difference* review states, and the ratings export to both the coded-segments CSV and a new `Ratings` sheet in the study workbook. *(In this release the rating control is offered on conversation and document transcripts; observation clips and text coding show ratings but cannot yet record them.)*
- **Group a continuous variable into bands.** A recode rule can now say `18–24 → 1`, `25–34 → 2`, and so on, with open-ended ends where you need them — instead of one row per distinct value, which on a real age variable meant 72 rows.
- **A refused action now tells you why.** When the app declines something with a reason — a rating on a retired code, a scale change that would strand existing ratings, changing the type of a variable that has a recode rule on it — you get that reason instead of a generic "Action failed".

- 🔴 **Read this before you share a project file.** **Project files saved by __VERSION__ do not open in 1.4.0 or earlier** — ratings and band rules are part of the file, and an older version would silently drop them rather than warn you. Files from older versions still open here as normal. If you are working with a colleague, you both need __VERSION__ before exchanging `.mmproject` files. **Backups (`.mmbackup`) are not affected.**
- Your database is upgraded on first launch and a backup is taken first; the upgrade only adds empty fields for the new rating and banding features and does not change any of your data. Full details, and the upgrade notes, in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

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
