/**
 * How long a merge usually takes, from the size of the file (#1015).
 *
 * A merge is one request: the server writes a safety copy of the whole project,
 * then matches the file against it. Neither step reports progress, so the page
 * paces its fill by this estimate (`lib/elapsed-progress.ts`) and says so.
 *
 * CALIBRATED on the MERGE ENDPOINT, never borrowed from another operation or
 * from the service alone (the #796b lesson — the first dataset estimate was sized
 * from the preview and shipped too small for the import). No-op merges of a
 * project's own export, after the #1015 speed-up:
 *
 *   · `pd_audit` + a 40,000 × 30 survey, 9.09 MB — **27.1 s at the endpoint**
 *     (twice, `curl` straight to the backend), 22.9 s inside `import_project`,
 *     31.5 s in the browser through the dev server's proxy → **2.98 s/MB**
 *   · synthetic 40,000 × 30, 10.1 MB — 16.2 s at the service (1.60 s/MB)
 *   · synthetic 75,699 × 41, 25.6 MB — 41.6 s at the service (1.62 s/MB)
 *
 * 🔴 **The first version used 1.6 s/MB and was wrong on its first real project —
 * found by driving the page (2026-09-24): "usually about 15s", then 31.6 s.** Two
 * reasons, both measured: file size is the COMPRESSED archive, and real survey
 * text ("Strongly agree") compresses far better than synthetic cells, so the same
 * number of values arrives in fewer MB; and the synthetic figures were taken at
 * the service, missing ~4 s of endpoint work (receiving the upload, the audit
 * write, the commit). The rate is set from the realistic corpus at the endpoint.
 * A synthetic-shaped file finishes early, which the page handles gracefully; an
 * estimate that runs short opens on "longer than usual".
 *
 * ⚠️ **A coding-heavy project runs LONGER per MB** — a merge also rebuilds the
 * consensus layer, and the BES corpus's import (1.2M codings, 23.9 MB) is ~4.2 s
 * per MB at the service (99.4 s, 2026-09-24, after the rebuild began streaming;
 * it was ~5.6). The estimate is not raised for it: the page's note says plainly
 * when a merge has run past the usual time, which is the honest answer for a
 * file this estimate does not describe.
 */
export const MERGE_SECONDS_PER_MB = 3

/** The shortest estimate stated: even a tiny file writes a whole safety copy first. */
export const MIN_MERGE_ESTIMATE_SECONDS = 5

export function estimatedMergeSeconds(fileSizeBytes: number): number {
  return Math.max(
    MIN_MERGE_ESTIMATE_SECONDS,
    Math.round((fileSizeBytes / 1_000_000) * MERGE_SECONDS_PER_MB),
  )
}
