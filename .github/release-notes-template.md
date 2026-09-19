Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

1.5.0 and 1.5.1 let you rate coded passages; 1.5.2 turned those ratings into
variables you can analyse. This release is about catching up on the ratings you
have not given yet — and about screens telling you the truth while they are
still loading.

- **Rate coded passages in a second pass.** *Analysis → Ratings* walks through the passages you have coded with a code that carries a rating scale but have not yet rated, one at a time, with that code's scale and its anchor labels on screen. Type the number, or arrow to it and press Enter; **Esc** leaves the passage unrated and moves on. It covers everything you can code — interview turns, document paragraphs, observation clips and survey responses — and you can work through one code at a time, which is what makes a run of ratings comparable: the same instrument, the same anchors, many passages in a row. It shows only your own coding and never a colleague's rating, because seeing someone else's judgement before giving yours is exactly what makes an agreement figure meaningless. Until now a rating could only be given at the moment of coding, so a scale declared after the coding was done left every earlier passage unrated with no practical way to catch up.
- **Screens no longer tell you your work does not exist while they are still loading it — or after the loading failed.** A list that had not arrived yet looked exactly like a list with nothing in it, so a dozen screens said *"No clips yet"*, *"No conversations yet"* or *"Create your first canvas"* about work that was there — briefly on a fast project, and permanently when the request failed. Each of those screens now says that it is loading, or that the loading failed and nothing in your project has changed, with a Retry. The same mistake also switched off checks that only run in the app, so you could save a rule that maps nothing, or import a dataset under a name already in use, without being warned.
- **Blind coding no longer shows a colleague's work while the coder list is loading.** Blind mode decides what to hide from the list of coders on the project — and while that list was still arriving, or after importing a file that added coders, it read as a one-person project and hid nothing. Anyone coding blind could see colleagues' coding without being told. It now withholds until it knows, which is the safe direction for the one setting whose whole purpose is that you cannot see someone else's judgement before giving yours.
- **See, download and delete the copies taken before a merge or an overwrite.** Merging a colleague's coding into a project has always saved a full copy of it first, but those copies were never listed anywhere and the advice to "import that file" pointed at a folder the app does not show. *Settings → Backup & Data* now lists them — which project, which act, when, and how big — with Download to bring one back and Delete for the ones you no longer need. The confirmation warns you when a copy belongs to a project that is no longer in Mixed Measures, because it may be the only copy of it.
- **The data grid can be worked from the keyboard.** In a dataset's Data view the cells are reachable by Tab and navigable with the arrow keys, with Home/End and Ctrl+Home/Ctrl+End for the ends of a row and of the table. F2 or Enter opens the editor on the cell you are on. Until now the only way to select a cell was to click it, so the editing shortcuts added in the last release worked only after a mouse had started the job.
- **Two codes can no longer be given the same name.** Once created, two identically named codes were impossible to tell apart on a coded passage, and every count, co-occurrence and agreement figure was split between them, silently. Creating and renaming both check now, whichever route you came by. Importing a codebook is unaffected.
- **And a round of smaller fixes.** Closing a dialog returns keyboard focus where you came from rather than to the top of the page. Selecting many open-ended questions for text coding no longer fails on a large project. The reliability panel no longer reports "unavailable" when it is merely slow.

- 🔴 **Read this before you share a project file.** **Project files saved by __VERSION__ do not open in 1.4.0 or earlier** — ratings and band rules are part of the file, and an older version would silently drop them rather than warn you. Files from older versions still open here as normal. If you are working with a colleague, you both need **1.5.0 or later** before exchanging `.mmproject` files — 1.5.0, 1.5.1, 1.5.2 and __VERSION__ all write the same format. **Backups (`.mmbackup`) are not affected.**
- **This update does not change your database.** Unlike 1.5.2, this release adds no new fields, so there is no upgrade step on first launch and nothing in your data is rewritten or moved. **Copy your data folder somewhere of your own before upgrading anyway if your project matters to you:** a copy you control is the only one the app's own rotation can never reach. Full details in the [changelog](https://github.com/__REPO__/blob/main/CHANGELOG.md).

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
