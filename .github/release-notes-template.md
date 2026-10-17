Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

This release fixes what the checks made before it found — most of it in importing
and merging projects, backups, saved statistics and large surveys — and it now
refuses a CSV file whose quotation marks don't pair up instead of reading it wrongly.

- 🔴 **A project import that fails no longer damages the project you kept.** If replacing your copy of a project, or merging a colleague's copy into it, failed partway — a damaged file, a full disk — a recording or document of the project you kept could be left empty or cut short while the project looked intact, and a merge replaced your recordings with your colleague's even when it succeeded. Now nothing on disk changes until the import has succeeded.
- 🔴 **A computer clock set back no longer deletes each new backup.** After a clock was moved back, every new automatic backup — and *Backup now*, and the backup taken before installing an update — was deleted the moment it was written, while the app said it was saved. The backup just taken is now always kept.
- 🔴 **Automatic backups are taken on short sessions too.** The first one used to wait until the app had been open for four hours, and on Windows quitting takes no backup, so someone who worked in short sittings on Windows could have none at all. Now one is taken a couple of minutes after the app opens whenever the last is more than four hours old.
- 🔴 **Saved statistics follow the data.** Several actions changed the data behind a saved chart, test or scale score without marking it out of date, and a variable group with more than one group aggregate could feed the wrong one into correlations, scatter plots and comparisons. Both are fixed, and those pages now say when a scale score is out of date.
- 🔴 **A CSV file whose quotation marks don't pair up is now refused, with the line to fix.** One stray quotation mark could merge the rows after it into one answer, without a word. A file that imported before can now be refused; the message says which line holds the problem. The rule changes nothing in a file whose quotation marks are correct.
- **Importing a colleague's codings no longer assumes that a coder with the same name is the same person.** Every copy of Mixed Measures starts with a coder called "Researcher"; a name that matches one of yours now waits for you to choose.
- **Large projects are workable.** Deleting one takes seconds instead of minutes, linking a large survey's records to participants no longer freezes the app, and choosing a record for a participant works on large surveys.
- **A deleted project's history no longer appears in another project's Excel export**, where it could list participants' identifiers.
- **Clearer words when something goes wrong.** A restore that stops before changing anything says so; a refused merge or project file says why; and when the app cannot start — a missing encryption key, a database that will not open, security software blocking its engine, a setting of the wrong kind — it says what happened and what to do.
- **A security update** to the library that reads a recording's length: the old version could get stuck on a deliberately malformed M4A file.
- **And a round of smaller fixes.** Every import's step bar fits a small window, and a wrong file chosen as a recording is named. Saved tests and the *Add Statistical Test* dialog name their controls for screen readers. The Variable Groups page shows a group's items in the order you set. The Mac app now carries the licence notices of Electron and Chromium. The Software update setting now says what an update check sends: no project data, and a random identifier for this installation.

<!-- Update the next paragraph at every cut: the cut-off is the last release that used the PREVIOUS .mmproject format, not a fixed number. 1.5.4 introduced format 7; 1.5.5, 1.5.6 and 1.5.7 write the same format. -->
- 🔴 **Read this before you share a project file.** **Project files saved by __VERSION__ do not open in 1.5.3 or earlier** — 1.5.4 changed how a project file stores your data, and an older version refuses such a file and says so rather than importing a project that appears to be empty. **Files from older versions still open here as normal.** If you are working with a colleague, you both need **1.5.4 or later** before exchanging `.mmproject` files — 1.5.4 and __VERSION__ write the same format. **Backups (`.mmbackup`) are not affected.**
- **Coming from 1.5.4, 1.5.5 or 1.5.6, this update adds nothing to your database's structure**, so there is no upgrade step on first launch; the first start only removes the history entries an earlier version kept for projects you had deleted. (Coming from 1.5.4, the first start also makes 1.5.5's correction of stored numbers for answers it reads as non-answers — see the 1.5.5 notes.) **Coming from 1.5.3 or earlier**, your database is upgraded on first launch, and a copy of it is made before that happens. **If your project matters to you, copy your data folder somewhere of your own before upgrading anyway:** a copy you control is the only one the app's own rotation can never reach. Full details in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

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

The installers are signed (and notarized on macOS), so the verified publisher is **George Chavez**. Because the app is new and independent, your system may show a one-time prompt the first time you open it. This is normal and fades as more people install it — it is not a sign that anything is wrong.

- **macOS:** drag Mixed Measures to your Applications folder. If it doesn't open on a double-click, right-click it → **Open**.
- **Windows:** if you see "Windows protected your PC," click **More info → Run anyway** (you'll see *George Chavez* listed as the publisher).

See the [README](https://github.com/__REPO__#readme) to get started.
