Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

This release moves the desktop app onto a supported engine before the old one
stops receiving security fixes on October 20, and fixes what three checks made
before the release found — most of it in backups and restores, the Participants
page and coding import.

- 🔴 **Macs need macOS 14 (Sonoma) or later.** Version 1.5.5 said macOS 12, but it most likely did not start on macOS 12 or 13. A Mac on an older version is not offered this update and stays on 1.5.5; every Apple Silicon Mac can be updated to macOS 14.
- 🔴 **Opening Mixed Measures while it is already open no longer starts a second engine on your data.** Clicking the shortcut a second time started a hidden copy that nothing ever stopped. It could keep writing to your database, take its own automatic backups, and on Windows make every later restore fail. This was in every release so far. A second launch now just brings the open window to the front.
- 🔴 **Saved charts and tests now notice when a participant-table refresh or a withdrawal changes their data.** Both changed numbers without marking the results built on them out of date, so the analysis view could go on showing the old figure — after a withdrawal, one that still counted the withdrawn person's responses. Results saved before this update are not re-checked.
- **A withdrawal accounts for documents about the person.** The Participants page could say "Nothing else in this project is linked to this participant" about someone a document is about. The report and the confirmation now list those documents, which stay in the project, unlinked, for you to read.
- **Backups and restores are sturdier.** A restore now swaps your database in with one step on every system, a large backup that carries recordings can be restored from *Backup history*, a backup stopped by quitting no longer leaves files behind, and a restore that stops before changing anything says so.
- **The Participants page works in a small window and from the keyboard**, counts documents as links, and no longer offers *Unlink* on the participant table — where the next refresh deleted that row, with anything typed into the variables you had added.
- **Coding import says more and guesses less.** A file it cannot read names the line and the likely cause, the *Import* button counts only what you chose to import, two names in the file that are one coder are settled together, and the page says when it has already chosen an existing coder for a name.
- **A newer, supported desktop engine** (Electron 44), which goes on receiving security fixes after Electron 42's end on October 20. The installed app also can no longer be run as a plain script engine, have code injected through an environment variable or have a debugger attached, and on macOS and Windows it refuses to start if the code of its desktop shell has been altered.
- **And a round of smaller fixes.** Archiving a coder updates the saved consensus. The exported R script prints Cohen's kappa on an installation with more than two coders. *Group by* in Quantitative Analysis is now cleared when a selection makes it unavailable. The Content tab shows every kind of source again and keeps your place when you load more. A jotted note records the page it was written on. Screen readers now hear the whole withdrawal confirmation.

<!-- Update the next paragraph at every cut: the cut-off is the last release that used the PREVIOUS .mmproject format, not a fixed number. 1.5.4 introduced format 7; 1.5.5 and 1.5.6 write the same format. -->
- 🔴 **Read this before you share a project file.** **Project files saved by __VERSION__ do not open in 1.5.3 or earlier** — 1.5.4 changed how a project file stores your data, and an older version refuses such a file and says so rather than importing a project that appears to be empty. **Files from older versions still open here as normal.** If you are working with a colleague, you both need **1.5.4 or later** before exchanging `.mmproject` files — 1.5.4 and __VERSION__ write the same format. **Backups (`.mmbackup`) are not affected.**
- **Coming from 1.5.4 or 1.5.5, this update adds nothing to your database's structure**, so there is no upgrade step on first launch. (Coming from 1.5.4, the first start also makes 1.5.5's correction of stored numbers for answers it reads as non-answers — see the 1.5.5 notes.) **Coming from 1.5.3 or earlier**, your database is upgraded on first launch, and a copy of it is made before that happens. **If your project matters to you, copy your data folder somewhere of your own before upgrading anyway:** a copy you control is the only one the app's own rotation can never reach. Full details in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

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
