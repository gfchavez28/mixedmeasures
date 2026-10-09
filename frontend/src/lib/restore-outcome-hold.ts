/**
 * #1084 (a) — keep a restore's outcome on screen until the researcher has read it.
 *
 * After a restore (or a failure partway through its swap) this browser's session is
 * one the restored database has never seen, so any request answers 401 and
 * `lib/api/client.ts` reloads the page, taking "Restore complete" — or the sentence
 * naming the backup to recover from — with it. #1024's fix held React Query offline
 * while the outcome showed. That hold had two holes:
 *
 * - **TanStack's own `window` `online` listener undoes it.** `setOnline(false)` is a
 *   value, not a lock: the next `online` event — a Wi-Fi reconnect, a laptop woken
 *   on the outcome screen — set it back to true, the paused fetches ran, and the
 *   page reloaded. CONFIRMED at library level by the 2026-09-27f audit. So the
 *   listener itself is replaced for the hold, and re-created afterwards.
 * - **A request made outside React Query never asked it.** The 401 reload is held
 *   too (`holdSessionReload`), which is what makes the hold complete rather than a
 *   list of the doors we know.
 *
 * Returns the release. The dialog's Reload button reloads anyway; a failure's Close
 * releases, and the next request meets whatever database is there.
 */
import { onlineManager } from '@tanstack/react-query'
import { holdSessionReload } from '@/lib/api/client'

type SetOnline = (online: boolean) => void

/**
 * TanStack's default listener, re-created: `setEventListener` REPLACES the one it
 * had, and the library keeps no way back to its own. Same events, same answers
 * (`@tanstack/query-core` 5.100.5, `onlineManager.js`).
 */
export function browserOnlineListener(setOnline: SetOnline) {
  if (typeof window === 'undefined' || !window.addEventListener) return undefined
  const online = () => setOnline(true)
  const offline = () => setOnline(false)
  window.addEventListener('online', online, false)
  window.addEventListener('offline', offline, false)
  return () => {
    window.removeEventListener('online', online)
    window.removeEventListener('offline', offline)
  }
}

let holds = 0

export function holdPageForRestoreOutcome(): () => void {
  if (holds === 0) {
    // The library calls the previous listener's cleanup, so the window listeners go.
    onlineManager.setEventListener(() => undefined)
    onlineManager.setOnline(false)
  }
  holds += 1
  const releaseReload = holdSessionReload()
  let released = false
  return () => {
    if (released) return
    released = true
    releaseReload()
    holds -= 1
    // Counted, so one holder cannot hand the page back while another still holds it.
    if (holds > 0) return
    onlineManager.setEventListener(browserOnlineListener)
    onlineManager.setOnline(true)
  }
}
