import { Link } from 'react-router-dom'
import { CircleArrowUp } from 'lucide-react'
import { useDesktopUpdates } from '@/hooks/useDesktopUpdates'

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--mm-green)/0.5)] focus-visible:ring-offset-1'

/**
 * TopRail auto-update indicator (#29 S3, D3 "notify, never force").
 *
 * Passive by design: it appears only while an update is downloading or staged,
 * never interrupts, and clicking it just goes to Settings → Software update
 * where the actual controls live. Renders nothing in the browser / on servers /
 * on pre-updater desktop builds (no bridge) and in every quiet state — idle,
 * checking, error, unsupported all stay invisible here (Settings is where those
 * are explained).
 *
 * Dual-encoded like its BackupStatusBadge sibling: the title/aria-label text
 * carries the state; the icon color (muted while downloading, green when ready)
 * is a redundant cue only.
 */
export default function UpdateStatusBadge() {
  const { state } = useDesktopUpdates()
  if (!state) return null
  if (state.status !== 'downloading' && state.status !== 'downloaded') return null

  const ready = state.status === 'downloaded'
  const versionPart = state.version ? ` ${state.version}` : ''
  const label = ready
    ? `Update${versionPart} ready — open Settings to restart and install`
    : `Downloading update${versionPart}… ${state.percent}%`

  return (
    <Link
      to="/settings"
      className={`p-2 rounded transition-colors ${FOCUS_RING}`}
      title={label}
      aria-label={label}
    >
      <CircleArrowUp
        className={`w-3.5 h-3.5 ${
          ready ? 'text-emerald-400' : 'text-[hsl(var(--mm-chrome-text-muted))]'
        }`}
        aria-hidden
      />
    </Link>
  )
}
