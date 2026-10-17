import { useState, useRef } from 'react'
import { Link } from 'react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Sun, Moon, Monitor, Download, FileInput, ChevronDown, LoaderCircle, ArrowLeft, Clock, Info, Lock, Unlock, Archive, ArchiveRestore, UserPlus, Copy, Quote, Plus, Minus, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context'
import { useTheme, type ThemeMode } from '@/lib/theme-context'
import { useZoom } from '@/lib/zoom-context'
import { formatZoom, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM } from '@/lib/zoom'
import {
  authApi,
  backupApi,
  MAX_BACKUP_UPLOAD_BYTES,
  type BackupInfo,
  type Coder,
  type RestorePreview,
} from '@/lib/api'
import { serverDetailMessage } from '@/lib/api/error-utils'
import { formatRelativeTime, formatBytes } from '@/lib/format'
import { formatTakenAt } from '@/lib/safety-copies'
import MMLogo from '@/components/MMLogo'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { ColorDotButton } from '@/components/ColorDotButton'
import { ColorSwatchPicker } from '@/components/ColorSwatchPicker'
import SoftwareUpdateSection from '@/components/SoftwareUpdateSection'
import SafetyCopiesSection from '@/components/SafetyCopiesSection'
import BackupHistorySection from '@/components/BackupHistorySection'
import RestoreBackupDialog, { type RestoreSource } from '@/components/RestoreBackupDialog'
import {
  backupFileRefusal, backupFreshness, backupsAheadSentence, backupTitle, nextBackupPhrase, scheduleSentences,
} from '@/lib/backup-history'
import { fileLimitLabel } from '@/lib/upload-limits'
import { useCoders } from '@/hooks/useCoders'
import { useCoderSwitch } from '@/hooks/useCoderSwitch'
import { useCreateCoder } from '@/hooks/useCreateCoder'
import { coderColor, coderInitials } from '@/lib/coder-color'
import { getContrastColor } from '@/lib/utils'
import { apaCitation, bibtexCitation, CITATION_LICENSE } from '@/lib/citation'
import { MMBACKUP_ACCEPT } from '@/lib/mm-formats'
import { isMachineCoder } from '@/lib/coding-layers'
import { describeProvenance, editMachineCoderHint } from '@/lib/machine-coder'
import MachineCoderDialog from '@/components/MachineCoderDialog'

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/**
 * Text size (#697) — the discoverable half of the zoom fix.
 *
 * Renders nothing in the browser, matching `SoftwareUpdateSection`: outside the
 * packaged app there is no bridge to apply a factor, and the browser's own Ctrl+=
 * already works, so a control here would be a broken duplicate of a working one.
 *
 * A visible control rather than keyboard-only on purpose. The audience is applied
 * researchers, evaluators and faculty reading a 12–13px type scale; a shortcut they
 * have to already know about is worth much less than a row they can find. The
 * accelerators are restored too (`zoom-context`), so both paths exist.
 */
function TextSizeControl() {
  const { zoom, isSupported, zoomIn, zoomOut, resetZoom } = useZoom()
  if (!isSupported) return null

  const atMin = zoom <= MIN_ZOOM
  const atMax = zoom >= MAX_ZOOM

  return (
    <div className="mt-4 pt-4 border-t border-mm-border-subtle">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-mm-text">Text size</h3>
          <p className="text-xs text-mm-text-muted mt-0.5">
            Scales the whole app. Also available as {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}
            {' '}+ plus, minus and 0.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={zoomOut}
            disabled={atMin}
            aria-label="Decrease text size"
          >
            <Minus className="w-4 h-4" aria-hidden="true" />
          </Button>
          {/* aria-live so the new size is announced on press — the visible number is
              the only feedback, and a screen-reader user pressing +/− would
              otherwise get silence. `atomic` because "110%" only means something whole. */}
          <span
            className="min-w-[3.5rem] text-center text-sm tabular-nums text-mm-text"
            aria-live="polite"
            aria-atomic="true"
          >
            {formatZoom(zoom)}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={zoomIn}
            disabled={atMax}
            aria-label="Increase text size"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={resetZoom}
            disabled={zoom === DEFAULT_ZOOM}
            className="ml-1"
          >
            Reset
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const { isDark, mode, setTheme, toggleTheme } = useTheme()

  return (
    <div className="min-h-screen bg-mm-bg">
      <header className="bg-mm-surface border-b border-mm-border-subtle px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Link to="/">
              <MMLogo size={28} />
            </Link>
            <span className="text-white/20 mx-0.5">/</span>
            <h1 className="text-[17px] font-semibold text-mm-text">Settings</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-md text-mm-text-muted hover:text-mm-text hover:bg-mm-surface-hover transition-colors"
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <Link
              to="/"
              className="inline-flex items-center gap-1 text-sm text-mm-text-muted hover:text-mm-text transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Appearance */}
        <section className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4">
          <h2 className="text-base font-semibold text-mm-text mb-4">Appearance</h2>
          <div className="flex items-center gap-2">
            {THEME_OPTIONS.map(opt => {
              const Icon = opt.icon
              const isActive = opt.value === mode
              return (
                <button
                  key={opt.value}
                  onClick={() => setTheme(opt.value)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                    isActive
                      ? 'border-[hsl(var(--mm-green)/0.5)] bg-[hsl(var(--mm-green)/0.08)] text-mm-text'
                      : 'border-mm-border-subtle text-mm-text-muted hover:text-mm-text hover:border-mm-border-medium'
                  }`}
                  aria-pressed={isActive}
                >
                  <Icon className="w-4 h-4" />
                  {opt.label}
                </button>
              )
            })}
          </div>
          <TextSizeControl />
        </section>

        {/* Backup & Data */}
        <BackupSection />

        {/* Data protection (at-rest encryption status) */}
        <SecuritySection />

        {/* Coder identity */}
        <CoderIdentitySection />

        {/* Software update (#29) — desktop-only; renders nothing in the browser */}
        <SoftwareUpdateSection />

        {/* About & citation */}
        <AboutSection />
      </main>
    </div>
  )
}

function AboutSection() {
  // The citability trust move: researchers who use the tool in published work need a
  // reference, and the version they used is part of it. Both formats are copyable —
  // APA for a manuscript, BibTeX for a reference manager. Strings come from
  // `lib/citation.ts`; the version/date are build-time defines, never hardcoded here.
  const version = __APP_VERSION__
  const releaseDate = __APP_RELEASE_DATE__
  const apa = apaCitation(version, releaseDate)
  const bibtex = bibtexCitation(version, releaseDate)

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label} citation copied`)
    } catch {
      toast.error(`Could not copy the ${label} citation.`)
    }
  }

  return (
    <section className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4">
      <h2 className="text-base font-semibold text-mm-text mb-1">About & citation</h2>
      <p className="text-sm text-mm-text-muted">
        Mixed Measures {version} · {CITATION_LICENSE} · released{' '}
        {new Date(`${releaseDate}T00:00:00`).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}
      </p>

      <div className="mt-3 pt-3 border-t border-mm-border-subtle">
        <div className="flex items-start gap-3">
          <Quote className="w-4 h-4 mt-0.5 shrink-0 text-mm-text-muted" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-mm-text">Cite Mixed Measures</p>
            <p className="text-sm text-mm-text-muted mt-0.5">
              If you use Mixed Measures in published work, please cite the version you
              analyzed with — it is part of what makes your analysis reproducible.
            </p>
          </div>
        </div>

        <p className="mt-3 rounded-md border border-mm-border-subtle bg-mm-bg px-3 py-2 text-xs leading-relaxed text-mm-text break-words">
          {apa}
        </p>

        {/* #546: BibTeX renders on screen too — in a non-secure context (plain-http
            LAN deploy) navigator.clipboard is undefined, and a copy-only BibTeX
            would be unreachable. Rendered text keeps manual select-and-copy as the
            fallback; the buttons are the convenience. */}
        <pre className="mt-2 rounded-md border border-mm-border-subtle bg-mm-bg px-3 py-2 text-xs leading-relaxed text-mm-text overflow-x-auto">
          {bibtex}
        </pre>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void copy(apa, 'APA')}>
            <Copy className="w-4 h-4" />
            Copy APA
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copy(bibtex, 'BibTeX')}
          >
            <Copy className="w-4 h-4" />
            Copy BibTeX
          </Button>
        </div>
      </div>
    </section>
  )
}


/** Exported for its test (`SecuritySection.test.tsx`); the page is its only mount. */
export function SecuritySection() {
  // D2: on/off only, fed by the backend (auth/status → encryption_enabled). The
  // keychain-vs-plaintext-fallback distinction lives in Electron and is surfaced
  // by its startup dialog, so it is intentionally not duplicated here. a11y: the
  // state is conveyed as text inside an aria-live region — the icon/color is a
  // redundant cue (aria-hidden), never the sole signal.
  const { encryptionEnabled } = useAuth()
  const Icon = encryptionEnabled ? Lock : Unlock
  // The recovery-key export is a desktop-only, trigger-only flow (decision C): the
  // button only appears in the packaged app (window.mmDesktop) AND when encryption
  // is on. The key is written by Electron main — it never enters this renderer.
  const canExportRecoveryKey = encryptionEnabled && !!window.mmDesktop?.saveRecoveryKey
  const [savingKey, setSavingKey] = useState(false)

  const handleSaveRecoveryKey = async () => {
    if (!window.mmDesktop?.saveRecoveryKey) return
    setSavingKey(true)
    try {
      const res = await window.mmDesktop.saveRecoveryKey()
      if (res.ok) {
        toast.success('Recovery key saved. Store it somewhere safe and private.')
      } else if (res.reason === 'canceled') {
        // user dismissed the dialog — no toast
      } else {
        toast.error(res.message || 'Could not save the recovery key.')
      }
    } catch {
      toast.error('Could not save the recovery key.')
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <section className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4">
      <h2 className="text-base font-semibold text-mm-text mb-3">Data protection</h2>
      <div className="flex items-start gap-3">
        <Icon
          className={`w-4 h-4 mt-0.5 shrink-0 ${
            encryptionEnabled ? 'text-[hsl(var(--mm-green))]' : 'text-mm-text-muted'
          }`}
          aria-hidden="true"
        />
        <div aria-live="polite">
          <p className="text-sm font-medium text-mm-text">
            {encryptionEnabled
              ? 'At-rest encryption is on'
              : 'At-rest encryption is off'}
          </p>
          <p className="text-sm text-mm-text-muted mt-0.5">
            {encryptionEnabled
              ? 'Your database is encrypted on this device, with the key held in your operating-system keychain.'
              : 'Your database is stored unencrypted on this device. Encryption turns on automatically in the installed desktop app when a system keychain is available.'}
          </p>
        </div>
      </div>
      {canExportRecoveryKey && (
        <div className="mt-3 pt-3 border-t border-mm-border-subtle">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSaveRecoveryKey}
            disabled={savingKey}
          >
            {savingKey ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Save recovery key…
          </Button>
          {/* #1120: not "or you move to a new machine" — a project file is the way
            * between computers (SECURITY.md), and nothing in the app uses this key
            * to open a backup on another one. Keep it in step with the recovery
            * file's own text (`electron/key-manager.js::recoveryKeyFileContents`). */}
          <p className="text-xs text-mm-text-muted mt-2">
            Save this once and keep it private. It is the only way to recover your data
            if this computer's keychain is lost or reset. To move projects to another
            computer you do not need it: use Export Project (.mmproject) instead.
          </p>
        </div>
      )}
    </section>
  )
}

/** The busy look for a button that stays focusable while it works (#1025): the
 * `disabled:` styles cannot fire on a button that is only `aria-disabled`. The
 * same look `CodeSetPicker` uses for its saving state. */
const BUSY_BUTTON_CLASS = 'aria-busy:cursor-wait aria-busy:opacity-50'

/** Exported for its test (`BackupSection.test.tsx`); the page is its only mount. */
export function BackupSection() {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 🔴 What is being restored FROM is two different things, and the dialog, the
  // confirm handler and the audit trail all need to know which. A single
  // a `File | null` would make "no file chosen" and "restoring one of ours" the
  // same value — the #772 shape, one variable standing for two facts. It
  // REPLACED such a field rather than sitting beside it.
  const [restoreSource, setRestoreSource] = useState<RestoreSource | null>(null)
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null)
  const [includeVideo, setIncludeVideo] = useState(true)
  // #1163 — why the last picked file was refused, said under the buttons. `key`
  // remounts the alert, so the same refusal twice is announced twice.
  const [fileRefusal, setFileRefusal] = useState<{ text: string; key: number } | null>(null)

  const { data: status } = useQuery({
    queryKey: ['backup-status'],
    queryFn: backupApi.status,
    staleTime: 60_000,
  })
  const schedule = scheduleSentences(status)

  const createMutation = useMutation({
    mutationFn: backupApi.create,
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Backup downloaded')
      queryClient.invalidateQueries({ queryKey: ['backup-status'] })
      queryClient.invalidateQueries({ queryKey: ['backup-list'] })
    },
    onError: (err: Error) => {
      // The server's sentence says what to do next — since #1025 a busy database
      // is refused with "try again when that task has finished", and a full disk
      // says to free space. The bare "Failed to create backup" said neither.
      toast.error(serverDetailMessage(err) || 'The backup could not be created.', { duration: 10_000 })
    },
  })

  // #357: "Backup now" — creates an auto-prefix snapshot without download.
  // Moves the displayed `next_backup_at` an interval past it, because it is now the
  // newest automatic backup (#1186). Counts toward the same automatic rotation (5 by default).
  const backupNowMutation = useMutation({
    mutationFn: backupApi.now,
    onSuccess: () => {
      toast.success('Snapshot saved')
      queryClient.invalidateQueries({ queryKey: ['backup-status'] })
      queryClient.invalidateQueries({ queryKey: ['backup-list'] })
    },
    onError: (err: Error) => {
      // Held longer than the default: it is a sentence to act on (#1025).
      toast.error(serverDetailMessage(err) || 'The snapshot could not be taken.', { duration: 10_000 })
    },
  })

  const validateMutation = useMutation({
    mutationFn: (source: RestoreSource) =>
      source.kind === 'upload'
        ? backupApi.validate(source.file)
        : backupApi.validateLocal(source.filename),
    onSuccess: (preview) => {
      setRestorePreview(preview)
    },
    onError: (err: Error) => {
      // Held longer than the default: since #1026 this is also where "made by a
      // newer version — restore it with X or later" arrives, a sentence to act on.
      toast.error(serverDetailMessage(err) || 'This backup could not be read.', { duration: 10_000 })
      setRestoreSource(null)
    },
  })

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // reset so same file can be re-selected
    // 🔴 Refused HERE, before the upload starts (#971, #1163): the wrong KIND of
    // file first — a 3 MB `interview.mp4` was POSTed whole and staged, and a
    // `.mmproject` was told "Invalid backup: missing database.db" — then the size,
    // which the server only met while STREAMING. Said under the buttons, not in a
    // toast: at 640×360 the toast covered the history rows the size sentence points
    // to. The server still enforces both; this is what makes the refusal immediate.
    const refusal = backupFileRefusal(file)
    setFileRefusal(refusal ? { text: refusal, key: Date.now() } : null)
    if (refusal) return
    const source: RestoreSource = { kind: 'upload', file, name: file.name }
    setRestoreSource(source)
    validateMutation.mutate(source)
  }

  const handleRestoreFromHistory = (backup: BackupInfo) => {
    // The refusal was about a picked FILE; it says nothing about this backup.
    setFileRefusal(null)
    const source: RestoreSource = {
      kind: 'local',
      filename: backup.filename,
      // #1132 — the shared builder: unquoted it read "the contents of Before a
      // restore backup from …".
      name: backupTitle(backup, formatTakenAt(backup.created_at)),
    }
    setRestoreSource(source)
    validateMutation.mutate(source)
  }

  const handleCancelRestore = () => {
    setRestorePreview(null)
    setRestoreSource(null)
  }

  // #357/#1186: `next_backup_at` as `at 4:30 PM`, or `on Oct 16 at 4:30 PM` when it
  // is not today — a bare time read a days-old projection as a time today.
  const next = status?.next_backup_at ? nextBackupPhrase(status.next_backup_at) : null
  const freshness = status ? backupFreshness(status) : null

  // #1162 — which door started the preview now being read. Both doors refuse while
  // either runs, but the WAIT shows on the control that was pressed: a row's
  // Restore made "Restore from a file" say Validating..., and the row said nothing.
  const checking = validateMutation.isPending ? validateMutation.variables : undefined
  const checkingUpload = checking?.kind === 'upload'

  return (
    <section className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4">
      <h2 className="text-base font-semibold text-mm-text mb-3">Backup & Data</h2>

      {/* #357/#378: one-line reassurance up front; the full "Saved vs. backed up"
        * explanation (researchers conflate continuous DB commit with the
        * scheduled snapshot) lives behind the info popover so it isn't a wall of
        * text. #1043: both state THIS install's schedule, from the server. */}
      <p className="text-sm text-mm-text-secondary leading-relaxed mb-4 flex items-start gap-1.5">
        <span>{schedule.intro}</span>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="mt-0.5 flex-none text-mm-text-faint hover:text-mm-text rounded focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="What's the difference between saved and backed up?"
            >
              <Info className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          {/* Capped at the room Radix measures and scrolling inside (#929's remedy):
              at 640×360 the explanation ran 503 px tall, 334 px past the window's
              bottom edge, with nothing to scroll (measured 2026-10-14). */}
          <PopoverContent
            align="start"
            collisionPadding={8}
            className="text-sm text-mm-text-secondary leading-relaxed max-w-xs max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain"
            aria-label="Saved vs. backed up"
          >
            <p className="font-medium text-mm-text mb-1">Saved vs. backed up</p>
            {/* ONE string (#1067 c): sibling sentence fragments are joined by a
                whitespace-only text node, which Chrome can drop from the tree.
                #1164 (b): what Backup now does comes from the server's numbers. */}
            {[
              schedule.detail,
              schedule.off
                ? null
                : 'Video recordings are excluded from these automatic snapshots to keep them ' +
                  'small — restoring never deletes video already on disk, and a downloaded ' +
                  'backup can include video.',
              schedule.backupNow,
            ].filter(Boolean).join(' ')}
          </PopoverContent>
        </Popover>
      </p>

      {/* Status line — freshness + next-auto */}
      <div className="mb-4" aria-live="polite">
        {/* #1199: three answers, through `backupFreshness` — "No backups yet" keys on
            the COUNT, because a null time now also means "every backup is dated
            later than this computer's clock", which the list below contradicts. */}
        {status?.last_backup_at ? (
          <p className="text-sm text-mm-text-muted">
            Last backup: <span className="text-mm-text">{formatRelativeTime(status.last_backup_at)}</span>
            {next && (
              <>
                {' · '}
                Next automatic backup{' '}
                <span className="text-mm-text">{next}</span>
              </>
            )}
            {schedule.off && ' · Automatic backups are off'}
            {/* A text-node space: `ml-2` is a gap on screen and nothing in the
                accessible text, which read "…just now(1 backup" (#908's rule). */}
            {status.backup_count > 0 && ' '}
            {status.backup_count > 0 && (
              <span className="ml-1 text-mm-text-faint">
                ({status.backup_count} backup{status.backup_count !== 1 ? 's' : ''}, {formatBytes(status.total_size_bytes)})
              </span>
            )}
          </p>
        ) : status ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {/* #1186: the server now says when the first one is due (it is null
                only when automatic backups are off). One string, #1067 (c). */}
            {freshness === 'ahead'
              ? backupsAheadSentence(status.backup_count, next)
              : next
                ? `No backups yet. The first automatic backup is due ${next}, or use Backup now to take one straight away.`
                : 'No backups yet. Use Backup now to create your first snapshot.'}
          </p>
        ) : null /* #961: "No backups yet" is an ANSWER — said before the status
                    answered (or after it failed) it was a claim from nothing (10-14). */}
      </div>

      {/* Actions.
        * 🔴 Busy is `aria-disabled` + a refusal in the handler, never `disabled`
        * (#965/#959 §4): Chrome BLURS a focused button that becomes disabled, so a
        * keyboard user pressing one of these landed on <body> for the whole wait —
        * tens of seconds on a large project (Download Backup measured 42 s on a
        * 546 MB database, #1025). */}
      <div className="flex items-center gap-3 mb-4">
        {/* #357: primary action — fresh snapshot without download. Moves the
          * displayed `next_backup_at` an interval past it (#1186). */}
        <Button
          variant="default"
          size="sm"
          onClick={() => {
            if (!backupNowMutation.isPending) backupNowMutation.mutate()
          }}
          aria-disabled={backupNowMutation.isPending || undefined}
          aria-busy={backupNowMutation.isPending || undefined}
          className={BUSY_BUTTON_CLASS}
        >
          {backupNowMutation.isPending ? (
            <LoaderCircle className="w-3.5 h-3.5 mr-1.5 animate-spin" />
          ) : (
            <Clock className="w-3.5 h-3.5 mr-1.5" />
          )}
          {backupNowMutation.isPending ? 'Snapshotting...' : 'Backup now'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (!createMutation.isPending) createMutation.mutate(includeVideo)
          }}
          aria-disabled={createMutation.isPending || undefined}
          aria-busy={createMutation.isPending || undefined}
          className={BUSY_BUTTON_CLASS}
        >
          {createMutation.isPending ? (
            <LoaderCircle className="w-3.5 h-3.5 mr-1.5 animate-spin" />
          ) : (
            <Download className="w-3.5 h-3.5 mr-1.5" />
          )}
          {createMutation.isPending ? 'Creating...' : 'Download Backup'}
        </Button>

        {/* Slab 5: downloads default to FULL (video included); the auto
          * rotation above is always video-less. */}
        <label className="flex items-center gap-1.5 text-xs text-mm-text-secondary cursor-pointer select-none">
          <Checkbox
            checked={includeVideo}
            onCheckedChange={(v) => setIncludeVideo(v === true)}
            aria-label="Include video recordings in the downloaded backup"
          />
          Include video
        </label>

        {/* #1162: refuses while EITHER door's check runs (one preview at a time),
          * so it is `aria-disabled` — and dimmed — for both; it is busy, with the
          * spinner and "Validating...", only for its own upload. */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (!validateMutation.isPending) fileInputRef.current?.click()
          }}
          aria-disabled={validateMutation.isPending || undefined}
          aria-busy={checkingUpload || undefined}
          className={`${BUSY_BUTTON_CLASS} aria-disabled:opacity-50`}
        >
          {checkingUpload ? (
            <LoaderCircle className="w-3.5 h-3.5 mr-1.5 animate-spin" />
          ) : (
            <FileInput className="w-3.5 h-3.5 mr-1.5" />
          )}
          {checkingUpload ? 'Validating...' : 'Restore from a file'}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept={MMBACKUP_ACCEPT}
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {/* #1163 — the refusal of a picked file, beside the button that picked it.
        * Focus stays on that button; the alert announces. Cleared on the next pick. */}
      {fileRefusal && (
        <p key={fileRefusal.key} role="alert" className="text-xs text-red-600 dark:text-red-400 leading-relaxed mb-4 -mt-2">
          {fileRefusal.text}
        </p>
      )}

      {/* 🔴 The limit is STATED (#971). It was named nowhere on this screen, and
        * enforced while streaming, so a researcher learned it from an error after
        * the whole file had transferred. The sentence also has to point at the
        * door that has no limit, because the backup folder is not reachable from
        * a file picker on the desktop build. #1164 (g): "500 MB", the server's own
        * spelling — `formatBytes` said "500.0 MB". */}
      <p className="text-xs text-mm-text-muted leading-relaxed mb-4 -mt-2">
        A backup from another computer can be up to {fileLimitLabel(MAX_BACKUP_UPLOAD_BYTES)}.
        Backups this copy of Mixed Measures made are listed below and can be restored
        whatever their size.
      </p>

      {/* Backup history — the recovery surface (#971). Until this it listed
        * filenames and nothing more: the only way to restore was to upload a
        * file, capped at 500 MB, while creating one had no cap at all. Its own
        * component, beside `SafetyCopiesSection`: the two lists are siblings, and
        * this page was already 1,100 lines. Restore stays HERE because its
        * preview and confirmation are shared with the upload door above. */}
      <BackupHistorySection
        onRestore={handleRestoreFromHistory}
        restoreBusy={validateMutation.isPending}
        checkingFilename={checking?.kind === 'local' ? checking.filename : null}
      />

      {/* #919: the copies taken before a merge or an overwrite. They are
        * `.mmproject` files, restored through Import rather than Restore, so
        * they are a separate list rather than rows of the history above. */}
      <SafetyCopiesSection />

      {/* One dialog for both doors: confirm, the wait, and how it ended (#1037). */}
      <RestoreBackupDialog
        source={restoreSource}
        preview={restorePreview}
        onClose={handleCancelRestore}
      />
    </section>
  )
}


function badgeDot(c: { id: number; username: string; display_color?: string | null }) {
  const bg = coderColor(c)
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold text-[9px] w-5 h-5 flex-none"
      style={{ backgroundColor: bg, color: getContrastColor(bg) }}
      aria-hidden="true"
    >
      {coderInitials(c.username)}
    </span>
  )
}

/**
 * #461/#459 — roster manager. One pick-list of every coder (incl. archived). Picking
 * a coder SWITCHES your active identity to them (with the #460 confirm) so the editor
 * below edits them — only a coder can change their own name/color, so there's no
 * edit-others endpoint. Archive/Unarchive sit per-row (you can't archive the coder
 * you're being, so Archive only shows on others). Shown only when ≥2 coders exist.
 */
function CoderRosterManager({
  activeId,
  onRequestSwitch,
  switching,
}: {
  activeId: number | undefined
  onRequestSwitch: (t: { id: number; username: string }) => void
  switching: boolean
}) {
  const queryClient = useQueryClient()
  const [showArchived, setShowArchived] = useState(false)
  // Row 49 — the machine coder whose name and configuration are being edited
  // (#999). Null = the dialog is closed; the dialog itself renders nothing
  // without one, so there is no second `open` flag to keep in step.
  const [editingMachine, setEditingMachine] = useState<Coder | null>(null)
  // Full roster incl. archived (the editor/switcher elsewhere use the non-archived
  // ['coders']). Archive/unarchive/switch invalidate ['coders'], which prefix-matches
  // this key too, so the list stays fresh.
  const { data: allCoders = [] } = useQuery({
    queryKey: ['coders', 'all'],
    queryFn: () => authApi.listCoders(true),
    staleTime: 60_000,
  })
  const activeCoders = allCoders.filter(c => !c.archived)
  const archivedCoders = allCoders.filter(c => c.archived)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['coders'] })
  const archiveMut = useMutation({
    mutationFn: (id: number) => authApi.archiveCoder(id),
    onSuccess: () => { invalidate(); toast.success('Coder archived') },
    onError: (e: Error & { response?: { data?: { detail?: string } } }) =>
      toast.error(e.response?.data?.detail || 'Could not archive coder'),
  })
  const unarchiveMut = useMutation({
    mutationFn: (id: number) => authApi.unarchiveCoder(id),
    onSuccess: () => { invalidate(); toast.success('Coder unarchived') },
    onError: () => toast.error('Could not unarchive coder'),
  })

  return (
    <div className="mb-5 space-y-2">
      {/* ⚠️ KEYED on the coder — the dialog seeds its fields in the state
          initialisers, so the mount IS the re-seed and opening it for a
          second machine cannot show the first one's configuration. */}
      <MachineCoderDialog
        key={editingMachine?.id ?? 'none'}
        coder={editingMachine}
        open={!!editingMachine}
        onOpenChange={(next) => { if (!next) setEditingMachine(null) }}
      />
      <Label className="text-xs">Coders on this install</Label>
      <div className="rounded-md border border-mm-surface-border divide-y divide-mm-surface-border overflow-hidden">
        {activeCoders.map(c => {
          const isActive = c.id === activeId
          // #989 — a MACHINE coder is LISTED here (this is the roster manager: you
          // must be able to see it and archive it) but is not switchable, because
          // `switch-coder` refuses it. The name is a plain span rather than a dead
          // button: a permanently disabled control in a row teaches nothing and
          // still costs a tab stop (#771/#785). The *(machine)* suffix is what
          // says why there is no "Code as" here, matching the coder filter.
          const machine = isMachineCoder(c)
          return (
            <div key={c.id} className="flex items-center gap-2 px-2.5 py-1.5">
              {badgeDot(c)}
              {machine ? (
                <span className="flex-1 text-left text-sm truncate text-mm-text">
                  {c.username}
                  <span className="text-mm-text-muted"> (machine)</span>
                  {/* Row 49 — the configuration, or the fact that there is none.
                      An undocumented model must not look like a documented one:
                      that is the whole gap this row closes. */}
                  <span className="block text-[11px] text-mm-text-muted truncate">
                    {describeProvenance(c.machine_provenance)}
                  </span>
                </span>
              ) : (
              <button
                type="button"
                disabled={isActive || switching}
                onClick={() => onRequestSwitch({ id: c.id, username: c.username })}
                className={`flex-1 text-left text-sm truncate ${isActive ? 'text-mm-text cursor-default' : 'text-mm-text hover:text-mm-green-text'}`}
                title={isActive ? 'You are coding as this coder' : `Code as ${c.username}`}
              >
                {c.username}
                {isActive && <span className="text-mm-text-muted"> (you)</span>}
              </button>
              )}
              {/* 🔴 #999 — the ONLY door to a machine coder's name. `PATCH
                  /auth/me` renames the ACTIVE coder and you cannot become a
                  machine, so before `PATCH /auth/coders/{id}` one imported under
                  a bad name was stuck with it. People keep the J1 rule: a rename
                  is self-service, through the editor below. */}
              {machine && (
                <button
                  type="button"
                  onClick={() => setEditingMachine(c)}
                  aria-label={`Edit ${c.username}`}
                  title={editMachineCoderHint(c)}
                  className="p-1 rounded text-mm-text-muted hover:text-mm-text"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
              {isActive ? (
                <span className="text-[10px] text-mm-text-faint">editing below</span>
              ) : (
                <button
                  type="button"
                  onClick={() => archiveMut.mutate(c.id)}
                  disabled={archiveMut.isPending}
                  aria-label={`Archive ${c.username}`}
                  title="Archive — keeps their codings, removes from the roster"
                  className="p-1 rounded text-mm-text-muted hover:text-mm-text"
                >
                  <Archive className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {archivedCoders.length > 0 && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setShowArchived(s => !s)}
            aria-expanded={showArchived}
            className="flex items-center gap-1 text-xs text-mm-text-muted hover:text-mm-text"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showArchived ? 'rotate-180' : ''}`} />
            Show archived ({archivedCoders.length})
          </button>
          {showArchived && (
            <div className="rounded-md border border-mm-surface-border divide-y divide-mm-surface-border overflow-hidden">
              {archivedCoders.map(c => (
                <div key={c.id} className="flex items-center gap-2 px-2.5 py-1.5 opacity-75">
                  {badgeDot(c)}
                  <span className="flex-1 text-sm text-mm-text truncate">
                    {c.username}<span className="text-mm-text-faint"> (archived)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => unarchiveMut.mutate(c.id)}
                    disabled={unarchiveMut.isPending}
                    aria-label={`Unarchive ${c.username}`}
                    className="inline-flex items-center gap-1 text-xs text-mm-green-text hover:underline"
                  >
                    <ArchiveRestore className="w-3.5 h-3.5" />
                    Unarchive
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * #530 — the "become multi-coder" entry point. Rendered unconditionally in the
 * Coder identity section: the roster and switcher UIs are ≥2-coder-gated for
 * noise reduction, which used to leave a fresh install with no discoverable way
 * to add coder #2 (the only create affordance was the TopRail menu, which exists
 * only inside a project). Creating switches straight to the new coder (#460's
 * skipConfirm case) so their coding is attributed correctly from the first click.
 */
function AddCoderControl({
  onCreated,
  disabled,
}: {
  onCreated: (coder: { id: number; username: string }) => void
  disabled?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const create = useCreateCoder({
    onCreated: coder => {
      setAdding(false)
      setName('')
      onCreated(coder)
    },
  })
  if (!adding) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)} disabled={disabled}>
        <UserPlus className="w-3.5 h-3.5 mr-1.5" />
        Add coder
      </Button>
    )
  }
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        const n = name.trim()
        if (n) create.mutate(n)
      }}
      className="flex items-center gap-2"
    >
      <Input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="New coder name…"
        maxLength={50}
        aria-label="New coder name"
        className="h-8 max-w-[220px]"
      />
      <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
        Add
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => { setAdding(false); setName('') }}>
        Cancel
      </Button>
    </form>
  )
}

function CoderIdentitySection() {
  const { user, refreshAuth } = useAuth()
  const { coders, multiCoder } = useCoders()
  const queryClient = useQueryClient()
  const { requestSwitch, dialog: switchDialog, switching } = useCoderSwitch()
  const me = coders.find(c => c.id === user?.id)
  const [name, setName] = useState(user?.username ?? '')
  // `undefined` = unedited → fall back to the saved color from the ['coders'] roster
  // (the canonical store; the /auth/status user also carries display_color now, #452).
  // Deriving avoids a state-syncing effect: the preview reacts when the roster
  // loads, and a post-save refetch can't clobber an in-flight edit.
  const [color, setColor] = useState<string | null | undefined>(undefined)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState('')

  // Switching coders via the roster keeps this section mounted, so the useState
  // initializers won't re-run — re-seed the editor when the active coder changes
  // (the React-blessed "reset state on identity change" via a key ref).
  const lastUserId = useRef(user?.id)
  if (lastUserId.current !== user?.id) {
    lastUserId.current = user?.id
    setName(user?.username ?? '')
    setColor(undefined)
    setError('')
  }

  const mutation = useMutation({
    mutationFn: (vars: { username: string; display_color: string | null }) =>
      authApi.updateProfile(vars.username, vars.display_color),
    onSuccess: async () => {
      setError('')
      await refreshAuth()
      // Refresh the roster so attribution badges / switcher / analysis lenses
      // pick up the new color immediately.
      queryClient.invalidateQueries({ queryKey: ['coders'] })
      toast.success('Coder identity updated')
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      setError(err.response?.data?.detail || 'Could not update coder identity')
    },
  })

  const trimmed = name.trim()
  const currentColor = me?.display_color ?? null
  const effectiveColor = color === undefined ? currentColor : color
  const nameDirty = trimmed.length > 0 && trimmed !== user?.username
  const colorDirty = color !== undefined && color !== currentColor
  const dirty = nameDirty || colorDirty

  // Live badge preview: chosen color (or the stable palette fallback) + initials
  // derived from the name being typed — exactly how the attribution badge renders.
  const previewColor = effectiveColor ?? coderColor({ id: user?.id ?? 0, display_color: null })
  const previewInitials = coderInitials(trimmed || user?.username || '?')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty) return
    mutation.mutate({ username: trimmed.length ? trimmed : (user?.username ?? ''), display_color: effectiveColor })
  }

  return (
    <section className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4">
      <h2 className="text-base font-semibold text-mm-text mb-1">Coder identity</h2>
      <p className="text-xs text-mm-text-muted mb-4">
        Your coding is attributed to this name and color.{' '}
        {multiCoder
          ? 'Pick a coder below to code as them — only the coder you’re currently coding as can edit their own name and color.'
          : 'Mixed Measures is local-first — there is no account or password.'}
      </p>
      {multiCoder && (
        <CoderRosterManager activeId={user?.id} onRequestSwitch={requestSwitch} switching={switching} />
      )}
      <div className="mb-4 space-y-1.5">
        <AddCoderControl
          disabled={switching}
          onCreated={c => requestSwitch({ id: c.id, username: c.username }, { skipConfirm: true })}
        />
        {!multiCoder && (
          <p className="text-xs text-mm-text-muted">
            Add a second coder to code the same projects independently — attribution,
            blind coding, agreement statistics, and reconciliation switch on automatically.
          </p>
        )}
      </div>
      <form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
        {multiCoder && (
          <p className="text-xs text-mm-text-muted">
            Editing <span className="font-medium text-mm-text">{user?.username}</span>.
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="coder-name" className="text-xs">Coder name</Label>
          <Input
            id="coder-name"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={50}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Badge color</Label>
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center justify-center rounded-full font-semibold text-[10px] w-6 h-6 flex-none"
              style={{ backgroundColor: previewColor, color: getContrastColor(previewColor) }}
              aria-label={`Badge preview: ${previewInitials}`}
            >
              {previewInitials}
            </span>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <ColorDotButton color={previewColor} aria-label="Change badge color" title="Change badge color" />
              </PopoverTrigger>
              <PopoverContent className="w-auto p-3" align="start" aria-label="Badge color">
                <div className="space-y-2">
                  <p className="text-xs font-medium text-mm-text-secondary">Badge color</p>
                  <ColorSwatchPicker value={effectiveColor ?? ''} onChange={c => { setColor(c); setPickerOpen(false) }} />
                  {effectiveColor && (
                    <button
                      type="button"
                      className="text-xs text-mm-text-muted hover:text-mm-text mt-1"
                      onClick={() => { setColor(null); setPickerOpen(false) }}
                    >
                      Use default color
                    </button>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            <span className="text-xs text-mm-text-muted">Shown on attribution badges when coding with others.</span>
          </div>
        </div>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
        <Button type="submit" size="sm" disabled={!dirty || mutation.isPending}>
          {mutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </form>
      {switchDialog}
    </section>
  )
}
