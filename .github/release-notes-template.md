Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

1.5.0 and 1.5.1 let you rate coded passages. This release makes those ratings
something you can actually analyse, and puts documents on the participant spine
so a person's whole record hangs together.

- **Your code ratings become variables you can analyse.** Where a code carries a rating scale, the Datasets page can now maintain a table whose rows are your participants and whose columns are each person's average rating for a rated code — beside the number of passages it rests on, because an average over one passage and over eight are the same number and not the same evidence. Those columns behave like any survey variable: compare them by group, chart them, cross-tabulate them, export them to R. Refreshing says who was coded but not yet rated, and the table records when it was last computed.
- **A document can say who it is about.** Right-click a document and choose *Set subject…* to link it to a person, an organisation, a department — whatever your cases are. Coding on that document can then be compared by that subject's attributes, which was impossible before because a document has no speaker to reach a participant through. One participant can have any number of documents, and withdrawal reports now count them.
- **A table you can build by hand.** *Blank table* creates a dataset with no file behind it, and you can add records and type into them — for the case attributes, coding matrices and small grids that never existed as a spreadsheet.
- **A long round of fixes.** Dark mode now covers the parts of the window the browser draws, rather than leaving bright scrollbars and dropdowns. Two more screens work at 200% zoom. The variable editor can be reached from the keyboard. Cells you typed into a hand-built table can be edited again. A dataset or variable can no longer be saved with a blank name. The merge wizard tells you which step you are on. Opening the app no longer overwrites the recovery point taken before a database upgrade, and the safety copy taken before a merge or an overwrite now tells you what it is called. Plus a further round of controls that announced nothing, or the wrong thing, to a screen reader.
- **A security update** to the YAML parser inside the update checker.

- 🔴 **Read this before you share a project file.** **Project files saved by __VERSION__ do not open in 1.4.0 or earlier** — ratings and band rules are part of the file, and an older version would silently drop them rather than warn you. Files from older versions still open here as normal. If you are working with a colleague, you both need **1.5.0 or later** before exchanging `.mmproject` files — 1.5.0, 1.5.1 and __VERSION__ all write the same format. **Backups (`.mmbackup`) are not affected.**
- **This update does change your database, and takes a backup first.** Unlike 1.5.1, this release adds the fields the participant table and the document link need, so your project is upgraded on first launch whichever version you are coming from. A copy of your database is made before that happens. Nothing in your data is rewritten — the upgrade only adds new, empty fields. **If your project matters to you, copy your data folder somewhere of your own before upgrading anyway:** a copy you control is the only one the app's own rotation can never reach. Full details, and the upgrade notes, in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

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
