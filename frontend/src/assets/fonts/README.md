# Self-hosted fonts

Vendored to remove the Google Fonts CDN dependency (privacy + offline/Electron
packaging — CLAUDE.md Known Issues #3). Referenced by `@font-face` in
`src/index.css`; Vite hashes and bundles them into the build.

| Family | License | Source |
|---|---|---|
| Plus Jakarta Sans (sans, `--font-sans`) | SIL OFL 1.1 — `OFL-PlusJakartaSans.txt` | https://github.com/tokotype/PlusJakartaSans |
| JetBrains Mono (mono, `--font-mono`) | SIL OFL 1.1 — `OFL-JetBrainsMono.txt` | https://github.com/JetBrains/JetBrainsMono |

**Files:** variable `woff2`, **latin + latin-ext** subsets only. Each `*.woff2`
is the variable font for its subset; the `@font-face` `font-weight` ranges pin the
weights previously requested from the CDN (Jakarta `300 700`, JetBrains `400 500`).
Other scripts (cyrillic / greek / vietnamese) fall back to the system font stack.

**To re-fetch / widen subsets:** request the same families from the Google Fonts
`css2` endpoint with a modern-browser User-Agent (returns `woff2` URLs), download
the `/* latin */` and `/* latin-ext */` `src` files, dedup (the per-weight URLs are
identical — it's one variable file per subset), and update the `@font-face`
`unicode-range` blocks in `src/index.css` to match.
