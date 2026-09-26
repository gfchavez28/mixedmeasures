Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

This release is about three things: bringing coding in from elsewhere — a
colleague's spreadsheet, or labels a model produced — without losing track of
whose it is; coding a variable, not only tags; and backups and restores you can
rely on.

- **Import codings from a file — including labels a model produced elsewhere.** *Analysis → Import codings…* takes an ordinary CSV — one row per coding, `unit_id, coder, code`, optionally a rating — and applies it to passages you already have: transcript turns, document paragraphs, observation clips or open-text survey responses. It will not guess whose coding it is, will not guess what your ids mean, and will not half-apply a file: anything it cannot apply comes back with its line number and a sentence saying why.
- **A model's labels are their own layer, and the layer records which model.** Mixed Measures runs no model itself. Codings imported from one sit on the roster as a machine coder — attributed, filterable and permanently outside every agreement figure — with the model, how it was reached, its settings and its prompt kept with them and exported with the project. A model comparison on the Reliability tab describes how each model's labels line up with each person's, and says in so many words that it is not inter-rater reliability.
- **Code sets: a group of codes a passage takes exactly one of.** A stance that is positive, negative or neutral is one variable, not three tags. Create a set from *Codebook → Sets* and every coding screen shows its values as a single choice; the Reliability tab gives one Krippendorff's α per set, with a grid showing which two values coders confuse.
- **Restore from a backup Mixed Measures made, without finding the file first.** *Settings → Backup & Data → Backup history* lists every backup — what kind, when, how big — and each one can be restored, downloaded or deleted. Restoring from the list has no upload limit, because nothing is copied or uploaded.
- 🔴 **Backups and restores you can rely on.** A backup taken while an export, import or merge was running could quietly leave out your most recent work and still look like a good backup; backups now capture everything saved, without waiting for other work or slowing it down. A restore could lose work done around it; it now holds everything else off until it is done, and the screen stays with you until it says how it ended. A backup made by an earlier version is brought up to date as it is restored, and one made by a newer version is refused before anything changes.
- 🔴 **Importing a colleague's project no longer changes who your coding is attributed to.** A project file could make Mixed Measures open as the colleague it came from, so everything coded afterwards was credited to them. **If you imported a project from someone else since June, check the coder name in the top bar.**
- 🔴 **Quotes are no longer shifted onto the wrong words when a project is imported.** On a passage containing an emoji or certain other characters, a highlighted quote could move one position earlier for each such character before it, on every import.
- 🔴 **Agreement figures for coded survey responses no longer count answers your project treats as empty.** They were counted as passages every coder agreed to leave uncoded, which flattered agreement and moved per-code figures most — on one test project, a code's α went from just above zero to below it. If you have reported reliability on open-text responses, look at those figures again.
- **Large projects are much faster to import, duplicate and merge**, and building the participant table for a large coded survey takes seconds rather than hours.
- **And a round of smaller fixes.** The import pages state their size limit before you choose a file and refuse a wrong one straight away. The four source lists share one search and sort, and the sort can finally be reversed. Adding rows to a large dataset is quick, and its preview now counts what is actually added. Text on coloured buttons is readable in light and dark mode. The colour and Options buttons in the Codes panel work from the keyboard.

- 🔴 **Read this before you share a project file — this has CHANGED, and the cut-off moved.** **Project files saved by __VERSION__ do not open in 1.5.3 or earlier.** The way a project file stores your data was reorganised so that a large one can be read a piece at a time instead of all at once, and an older version opening it would find the file's records where it does not know to look. It refuses the file and says so, rather than importing a project that appears to have no data in it. **Files from older versions still open here as normal** — nothing you already have becomes unreadable. If you are working with a colleague, **you both need __VERSION__ or later** before exchanging `.mmproject` files. **Backups (`.mmbackup`) are not affected**, and neither is opening your own projects. ⚠️ **Update this paragraph at every cut** — the cut-off is the last release that used the PREVIOUS format, not a fixed number.
- **This update does change your database, and takes a backup first.** Unlike 1.5.3, this release adds the fields code sets and a model's details need, so your project is upgraded on first launch whichever version you are coming from. A copy of your database is made before that happens. To add one of those fields, the table that holds your codes is rebuilt; every code, and every coding on it, is carried across unchanged — the upgrade was rehearsed on a copy before release to check exactly that. **If your project matters to you, copy your data folder somewhere of your own before upgrading anyway:** a copy you control is the only one the app's own rotation can never reach. Full details in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

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
