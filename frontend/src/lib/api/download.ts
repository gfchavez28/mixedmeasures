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

/**
 * Fetch an export endpoint as a blob (via the credentialed api client) and
 * trigger a browser download, using the server's Content-Disposition filename.
 *
 * Self-contained: it surfaces failures with a toast and never rejects, so
 * fire-and-forget call sites (`onClick={() => exportApi.x(...)}`) need no
 * error handling. `path` is the api-relative path (the client prepends `/api`)
 * and may already carry a `?query` string.
 */
export async function downloadFromApi(
  path: string,
  fallbackName: string,
  config?: { timeout?: number },
): Promise<void> {
  try {
    const res = await api.get(path, { responseType: 'blob', timeout: config?.timeout ?? 120_000 })
    downloadBlob(res.data as Blob, extractFilename(res.headers, fallbackName))
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : 'Export failed. Please try again.')
  }
}
