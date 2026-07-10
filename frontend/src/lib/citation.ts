/**
 * Citation strings for the in-app "Cite Mixed Measures" panel (Settings → About).
 *
 * Kept pure and version-parameterized so the strings can be unit-tested and so the
 * running version/release year flow in from the build-time defines rather than being
 * hardcoded here. The repo's `CITATION.cff` is the machine-readable twin of these
 * strings — GitHub renders it as "Cite this repository". If you change the author,
 * title, URL, or license here, change it there too.
 */

export const CITATION_REPO_URL = 'https://github.com/gfchavez28/mixedmeasures'
export const CITATION_TITLE = 'Mixed Measures'
export const CITATION_LICENSE = 'Apache-2.0'

/** `2026-07-03` → `2026`. A citation quotes the year the version was released. */
export function releaseYear(releaseDate: string): string {
  return releaseDate.slice(0, 4)
}

/** APA 7 software reference. Publisher is omitted because author === publisher. */
export function apaCitation(version: string, releaseDate: string): string {
  return `Chavez, G. (${releaseYear(releaseDate)}). ${CITATION_TITLE} (Version ${version}) [Computer software]. ${CITATION_REPO_URL}`
}

/** BibTeX `@software` entry (biblatex; `@misc` consumers accept the same fields). */
export function bibtexCitation(version: string, releaseDate: string): string {
  const year = releaseYear(releaseDate)
  return [
    `@software{chavez_mixed_measures_${year},`,
    `  author  = {Chavez, George},`,
    `  title   = {${CITATION_TITLE}},`,
    `  version = {${version}},`,
    `  year    = {${year}},`,
    `  license = {${CITATION_LICENSE}},`,
    `  url     = {${CITATION_REPO_URL}}`,
    `}`,
  ].join('\n')
}
