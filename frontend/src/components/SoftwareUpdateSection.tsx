import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CircleArrowUp, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { backupApi } from '@/lib/api'
import { CITATION_REPO_URL } from '@/lib/citation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useDesktopUpdates } from '@/hooks/useDesktopUpdates'

const RELEASES_URL = `${CITATION_REPO_URL}/releases`

/**
 * Settings → "Software update" (#29 S3). Desktop-only: renders nothing without
 * the updater bridge (browser, server deploys, pre-1.2 desktop builds).
 *
 * Encodes the locked decisions:
 * - D3  notify-never-force — this section and the TopRail badge are the whole
 *   surface; downloads happen in the background and install on request or quit.
 * - D4  "Restart to update" takes a FRESH backup before asking main to install:
 *   a Windows quit hard-kills the backend (no shutdown backup), so the backup
 *   must land first — and it fails CLOSED (backup error ⇒ no install; the
 *   natural-quit install path remains as the fallback).
 * - D9  unsupported installs (read-only AppImage, dev run) get a link to the
 *   releases page instead of dead controls.
 * - D10 auto-check is a visible toggle, default ON, with the honest privacy
 *   sentence; "Check now" works even when the toggle is off.
 */
export default function SoftwareUpdateSection() {
  const { state, check, setAutoCheck, install } = useDesktopUpdates()
  const queryClient = useQueryClient()
  const [installing, setInstalling] = useState(false)

  if (!state) return null

  const handleInstall = async () => {
    setInstalling(true)
    try {
      await backupApi.now()
      queryClient.invalidateQueries({ queryKey: ['backup-status'] })
      queryClient.invalidateQueries({ queryKey: ['backup-list'] })
    } catch {
      toast.error(
        'Could not take a pre-update backup, so the update was not installed. Try again, or use Backup now above.',
      )
      setInstalling(false)
      return
    }
    const ok = await install()
    if (!ok) {
      // Nothing staged anymore (or main went away) — never restart into nothing.
      toast.error('The update is no longer ready to install. Check for updates again.')
      setInstalling(false)
    }
    // On success the app quits and installs — no state to reset.
  }

  const checking = state.status === 'checking'
  const downloading = state.status === 'downloading'
  const downloaded = state.status === 'downloaded'

  return (
    <section className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4">
      <h2 className="text-base font-semibold text-mm-text mb-1">Software update</h2>
      <p className="text-sm text-mm-text-muted">
        You're on version {__APP_VERSION__}.
      </p>

      {!state.supported ? (
        <p className="text-sm text-mm-text-muted mt-2">
          This installation can't update itself
          {' '}(for example, an AppImage in a folder you can't write to).
          Download new versions from the{' '}
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-mm-green-text underline underline-offset-2 hover:opacity-80"
          >
            releases page
            <ExternalLink className="inline w-3 h-3 ml-0.5 align-baseline" aria-hidden="true" />
          </a>
          .
        </p>
      ) : (
        <>
          {/* Status line — one message per state; idle needs none (the version
              line above is the message). Errors stay muted: offline is a normal
              state for this audience, never an alarm (D7). */}
          <div aria-live="polite">
            {checking && (
              <p className="text-sm text-mm-text-muted mt-2 flex items-center gap-1.5">
                <LoaderCircle className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                Checking for updates…
              </p>
            )}
            {downloading && (
              <p className="text-sm text-mm-text mt-2">
                Downloading version {state.version ?? '…'} in the background — {state.percent}%.
                You can keep working.
              </p>
            )}
            {downloaded && (
              <p className="text-sm text-mm-text mt-2 flex items-start gap-1.5">
                <CircleArrowUp
                  className="w-4 h-4 mt-0.5 shrink-0 text-[hsl(var(--mm-green))]"
                  aria-hidden="true"
                />
                <span>
                  Version {state.version ?? ''} is ready to install. It will install when
                  you restart now or the next time you quit.
                </span>
              </p>
            )}
            {/* #554c: the full sentence comes from main, which is the only side that
                knows WHICH phase failed. This used to staple "If you're offline,
                that's fine" onto every message — so a download that died at 80% on a
                full disk gave the user advice for a network problem. Don't re-add a
                hardcoded tail here. */}
            {state.status === 'error' && (
              <p className="text-sm text-mm-text-muted mt-2">
                {state.message ||
                  "Could not check for updates. If you're offline, that's fine — it will try again later."}
              </p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {downloaded && (
              <Button size="sm" onClick={() => void handleInstall()} disabled={installing}>
                {installing ? (
                  <LoaderCircle className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <CircleArrowUp className="w-3.5 h-3.5 mr-1.5" />
                )}
                {installing ? 'Backing up…' : 'Restart to update'}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void check()}
              disabled={checking || downloading || installing}
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Check now
            </Button>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-mm-text-muted hover:text-mm-text transition-colors"
            >
              Release notes
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
          </div>
          {downloaded && (
            <p className="text-xs text-mm-text-muted mt-2">
              A fresh backup is taken before the update installs.
            </p>
          )}

          <div className="mt-3 pt-3 border-t border-mm-border-subtle">
            <label className="flex items-center gap-2 text-sm text-mm-text cursor-pointer select-none">
              <Checkbox
                checked={state.autoCheck}
                onCheckedChange={v => void setAutoCheck(v === true)}
              />
              Check for updates automatically
            </label>
            <p className="text-xs text-mm-text-muted mt-1.5">
              Checking sends this app's version and platform to github.com — nothing
              else ever leaves this machine.
            </p>
          </div>
        </>
      )}
    </section>
  )
}
