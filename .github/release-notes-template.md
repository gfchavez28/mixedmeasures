Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

A correctness and accessibility release. Nothing new to learn — this fixes numbers that
were wrong or wrongly labelled, and makes a large part of the app usable without a mouse.

- ⚠️ **If you have reported an effect size from a group comparison, please check which statistic it was.** The comparison table took its effect-size *heading* from the number of groups while the *number* came from the test that ran, so the two could disagree — Cohen's *d* shown under an ω² heading is the common case. Fixed, but a figure already copied out may carry the wrong label.
- ⚠️ **A statistic that could not be computed used to show `0.00`**, which reads as "no relationship" when the truth is "not computable". It now shows `—` with the reason. Worth re-checking any table where you recorded a zero.
- **Scale scores say what they averaged**, over how many people (`3 items · n 210–260` rather than a pooled total), and warn when their items sit on different scales.
- **Qualitative charts can now be embedded in a Canvas** — code frequency, co-occurrence, saturation, comparisons, the summary table and the timeline all draw, and export as images. This was a stated limitation in 1.3.0.
- **Accessibility** was the bulk of the work: the codebook and picker trees are keyboard-reachable and announce their structure, the variable-group grid costs one tab stop instead of one per cell, text inputs have a visible border, and a screen-reader pass ran against the Observations workbench for the first time — its six findings are all fixed here.
- Full details, and the upgrade notes, in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

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
