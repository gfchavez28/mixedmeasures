import { toast } from 'sonner'
import api, { ApiError } from './client'

// ── Browser download helpers ──────────────────────────────────────────
// Canonical blob+anchor download. This is the same-origin-safe replacement
// for `window.open('/api/.../export')`, which broke in the packaged Electron
// renderer (a top-level navigation to a same-origin http URL tried to open a
// child window; the hardened shell denies new windows). A blob URL + a
// programmatic `<a download>` click works in both the browser and Electron
// with no main-process IPC.

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  URL.revokeObjectURL(url)
  document.body.removeChild(a)
}

/** Pull the server-supplied filename out of a Content-Disposition header. */
export function extractFilename(headers: Record<string, unknown>, fallback: string): string {
  const cd = String(headers['content-disposition'] ?? '')
  return cd.match(/filename="?([^"]+)"?/)?.[1] ?? fallback
}

/** A downloadable blob together with the name the SERVER asked it to have. */
export interface NamedBlob {
  blob: Blob
  filename: string
}

/**
 * Wrap a blob response so the server's `Content-Disposition` name survives to
 * the download (#743).
 *
 * An api wrapper that resolves to `res.data` alone throws the headers away, so
 * the call site cannot use the server's filename even if it wants to — it is
 * forced to invent one, and inventing one is how every group-comparison export
 * came to be called `group_comparison.csv` regardless of which grouping
 * produced it, silently overwriting the previous file. Prefer this over a
 * hand-written literal whenever the endpoint sets the header.
 */
export function namedBlob(
  res: { data: unknown; headers: Record<string, unknown> },
  fallback: string,
): NamedBlob {
  return { blob: res.data as Blob, filename: extractFilename(res.headers, fallback) }
}

/**
 * How long an export may take before the CLIENT gives up (#820).
 *
 * 🔴 **Measured, on the real 75,699 x 41 GSS survey: `/export/datasets-excel`
 * answered HTTP 200 after 212.7 s and `/export/r-data` after 85.6 s.** The
 * previous budget here was 120 s and the API client's bare default — which
 * `exportApi.rData` inherited — is 30 s, so both exports were unreachable from
 * the UI at real scale: successful server work, thrown away, reported to the
 * researcher as a failure that had not happened.
 *
 * ⚠️ **Flat, not size-derived, and that is deliberate** — the opposite of
 * `datasetUploadTimeoutMs`. An upload knows its file's size before it starts; an
 * export's cost is a property of the whole project (row count x column count x
 * how many datasets), and the client does not know any of it before asking. The
 * honest options were a generous fixed budget or a progress/streaming response;
 * this is the first.
 *
 * The value: cost is roughly linear in cells (23-24 s per million, measured at
 * three sizes), `MAX_DATASET_CELLS` caps ONE dataset at 4,000,000, and a project
 * may hold several. 15 minutes covers the measured worst case about four times
 * over. The counter-risk of a large flat value — a genuinely stalled request
 * held open — is small here: an export is a background fetch, nothing in the UI
 * is blocked behind it, and the researcher can leave the page.
 */
export const EXPORT_TIMEOUT_MS = 15 * 60 * 1000

/** True for the AbortSignal-driven client timeout, which is not an `ApiError`. */
function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

/**
 * Fetch an export endpoint as a blob (via the credentialed api client) and
 * trigger a browser download, using the server's Content-Disposition filename.
 *
 * Self-contained: it surfaces failures with a toast and never rejects, so
 * fire-and-forget call sites (`onClick={() => exportApi.x(...)}`) need no
 * error handling. `path` is the api-relative path (the client prepends `/api`)
 * and may already carry a `?query` string.
 *
 * ⚠️ **A timeout is not a server error and must not be reported as one.** The
 * generic "Export failed. Please try again." was wrong twice over on the GSS
 * run: the export had not failed, and retrying would have taken exactly as long
 * and stopped in exactly the same place.
 */
export async function downloadFromApi(
  path: string,
  fallbackName: string,
  config?: { timeout?: number; label?: string },
): Promise<void> {
  const what = config?.label ?? 'The export'
  try {
    const res = await api.get(path, {
      responseType: 'blob',
      timeout: config?.timeout ?? EXPORT_TIMEOUT_MS,
    })
    downloadBlob(res.data as Blob, extractFilename(res.headers, fallbackName))
  } catch (err) {
    if (isTimeout(err)) {
      toast.error(
        `${what} is taking longer than ${Math.round(EXPORT_TIMEOUT_MS / 60_000)} minutes.`,
        {
          description:
            'It may still be running on the server. Try exporting fewer sections, ' +
            'or a smaller set of datasets.',
        },
      )
      return
    }
    toast.error(err instanceof ApiError ? err.message : `${what} failed. Please try again.`)
  }
}
