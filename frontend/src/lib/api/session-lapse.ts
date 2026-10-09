/**
 * What the client does when the server says the session has lapsed (a 401):
 * reload, so `AuthProvider` re-asks `/auth/status`, which provisions a fresh
 * session. Its own module so a test can observe it — jsdom will not let a test
 * replace `window.location.reload`.
 */
export function reloadForLapsedSession(): void {
  window.location.reload()
}
