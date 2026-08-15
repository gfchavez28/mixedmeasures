Mixed Measures **__VERSION__** — a local-first desktop workspace for mixed-methods research: qualitative and quantitative data in one project, with shared participants, codes, and memos. Everything stays on your own computer — no account, no uploads, no telemetry.

**What's new in this release**

A security and packaging patch. There is no new capability here and nothing in your
projects changes.

- 🔴 **Linux: please update.** Every Mixed Measures AppImage up to 1.3.1 was built with a packaging tool that put the *folder you launch the app from* on the system library search path — so anyone able to write a file into that folder could have had their code loaded into the app (CVE-2026-54672). This was a defect in the build tool rather than in Mixed Measures itself, and installing 1.3.2 fixes it. There is no sign it was exploited. **Windows and macOS builds were not affected.**
- **The "could not start" message now reads correctly in every language.** If the app failed to launch, the recovery message names the folder it could not open — and accented, non-Latin or unusually-spaced folder names were being garbled, so it could point at a path that does not exist.
- **Merging a colleague's copy no longer accepts edited transcripts.** If two people held the same project and one corrected the wording of a segment, a merge could attach the other person's highlights to words nobody had quoted. It now stops, names the segments, and asks which text is correct.
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
