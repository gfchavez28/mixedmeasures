Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

A follow-up to 1.5.0 that finishes what it started and fixes what it shipped.
Ratings now work everywhere you code, and two ways of losing work are gone.

- **Ratings on every coding surface.** 1.5.0 offered the rating control on conversation and document transcripts only — observation clips and open-text responses could *show* a rating but not record one. Both can now, with the same **`r`** shortcut and the same right-click *Rate…* item, and text-response ratings reach the study workbook alongside the rest.
- **Ratings survive a merge, or say why they can't.** Merging one code into another now refuses — naming how many ratings would not fit — instead of moving them onto a scale that cannot hold them. Merging a colleague's project keeps an out-of-range rating as a flagged difference rather than importing it as a number. Both merge screens tell you when two codes' rating scales differ *before* you commit. Codebook files (`.mmcodebook`) now carry a code's rating scale in both directions.
- **Undo could jam, and could swallow fast keystrokes.** A single step the app refused to reverse would park the undo history for the rest of the session, leaving every earlier step unreachable until you reloaded. Separately, coding quickly — applying two codes in rapid succession — could discard one of them silently. Both are fixed, and undoing a removal now brings the code back *with* its rating.
- **A security update** to the rich-text editor behind the Canvas.
- **Controls that told a screen reader nothing.** Buttons that announced no name, and actions that named what they do without saying what they act on — including thirty rows of identical actions on the Participants page, one of which is the irreversible withdrawal request — now identify themselves.
- **Two screens had no room for content at 200% zoom.** Text Coding and the observation workbench now show their content at that zoom level; more of that work is still to come.

- 🔴 **Read this before you share a project file.** **Project files saved by __VERSION__ do not open in 1.4.0 or earlier** — ratings and band rules are part of the file, and an older version would silently drop them rather than warn you. Files from older versions still open here as normal. If you are working with a colleague, you both need **1.5.0 or later** before exchanging `.mmproject` files — 1.5.0 and __VERSION__ write the same format. **Backups (`.mmbackup`) are not affected.**
- **Coming from 1.5.0, this update changes nothing about your database.** Coming from 1.4.0 or earlier, it is upgraded on first launch and a backup is taken first; that upgrade only adds empty fields for the rating and banding features and does not change any of your data. Full details, and the upgrade notes, in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

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
