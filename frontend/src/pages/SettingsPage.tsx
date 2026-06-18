import { useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Sun, Moon, Monitor, Download, FileInput, ChevronDown, ChevronUp, LoaderCircle, ArrowLeft, Clock, Info, Lock, Unlock } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context'
import { useTheme, type ThemeMode } from '@/lib/theme-context'
import { authApi, backupApi, type RestorePreview } from '@/lib/api'
import { formatRelativeTime, formatBytes } from '@/lib/format'
import MMLogo from '@/components/MMLogo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

const BACKUP_TYPE_LABELS: Record<string, string> = {
  manual: 'Manual',
  auto: 'Auto',
  pre_restore: 'Pre-restore',
  pre_migration: 'Pre-migration',
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
        </section>

        {/* Backup & Data */}
        <BackupSection />

        {/* Data protection (at-rest encryption status) */}
        <SecuritySection />

        {/* Coder identity */}
        <CoderIdentitySection />
      </main>
    </div>
  )
}


function SecuritySection() {
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
          <p className="text-xs text-mm-text-muted mt-2">
            Save this once and keep it private. It is the only way to recover your data
            if this computer's keychain is lost or you move to a new machine.
          </p>
        </div>
      )}
    </section>
  )
}

function BackupSection() {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [restoreFile, setRestoreFile] = useState<File | null>(null)
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const { data: status } = useQuery({
    queryKey: ['backup-status'],
    queryFn: backupApi.status,
    staleTime: 60_000,
  })

  const { data: backups } = useQuery({
    queryKey: ['backup-list'],
    queryFn: backupApi.list,
    staleTime: 60_000,
    enabled: showHistory,
  })

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
    onError: () => {
      toast.error('Failed to create backup')
    },
  })

  // #357: "Backup now" — creates an auto-prefix snapshot without download.
  // Resets the displayed `next_backup_at` because the new file's mtime is
  // the most recent. Counts toward the same 5-backup auto rotation.
  const backupNowMutation = useMutation({
    mutationFn: backupApi.now,
    onSuccess: () => {
      toast.success('Snapshot saved')
      queryClient.invalidateQueries({ queryKey: ['backup-status'] })
      queryClient.invalidateQueries({ queryKey: ['backup-list'] })
    },
    onError: (err: Error) => {
      const detail = (err as unknown as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(detail || 'Snapshot failed')
    },
  })

  const validateMutation = useMutation({
    mutationFn: backupApi.validate,
    onSuccess: (preview) => {
      setRestorePreview(preview)
    },
    onError: (err: Error) => {
      const detail = (err as unknown as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(detail || 'Invalid backup file')
      setRestoreFile(null)
    },
  })

  const restoreMutation = useMutation({
    mutationFn: backupApi.restore,
    onSuccess: () => {
      toast.success('Restored successfully. Reloading...')
      setTimeout(() => {
        window.location.href = '/'
      }, 1000)
    },
    onError: (err: Error) => {
      const detail = (err as unknown as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      toast.error(detail || 'Restore failed')
    },
  })

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // reset so same file can be re-selected
    setRestoreFile(file)
    validateMutation.mutate(file)
  }

  const handleConfirmRestore = () => {
    if (restoreFile) {
      restoreMutation.mutate(restoreFile)
    }
  }

  const handleCancelRestore = () => {
    setRestorePreview(null)
    setRestoreFile(null)
  }

  // #357: format `next_backup_at` ISO → locale-aware short time (e.g.
  // "4:30 PM" or "16:30" depending on locale). Uses Intl.DateTimeFormat
  // so non-US researchers see appropriate 24h format.
  const formatNextTime = (iso: string | null): string | null => {
    if (!iso) return null
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso))
    } catch {
      return null
    }
  }

  return (
    <section className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4">
      <h2 className="text-base font-semibold text-mm-text mb-3">Backup & Data</h2>

      {/* #357/#378: one-line reassurance up front; the full "Saved vs. backed up"
        * explanation (researchers conflate continuous DB commit with the 4h
        * snapshot) lives behind the info popover so it isn't a wall of text. */}
      <p className="text-sm text-mm-text-secondary leading-relaxed mb-4 flex items-start gap-1.5">
        <span>
          Your edits save to disk instantly; backups are a separate 4-hourly safety snapshot.
        </span>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="mt-0.5 flex-none text-mm-text-faint hover:text-mm-text rounded focus:outline-none focus:ring-2 focus:ring-mm-accent/40"
              aria-label="What's the difference between saved and backed up?"
            >
              <Info className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="text-sm text-mm-text-secondary leading-relaxed max-w-xs">
            <p className="font-medium text-mm-text mb-1">Saved vs. backed up</p>
            Every edit is saved to disk the moment you make it — your work isn't waiting in
            memory anywhere. Backups are a separate safety net: Mixed Measures takes a full
            snapshot of the project's database, documents, and media every 4 hours, keeping
            the 5 most recent so you can recover from disk corruption or accidental deletion.
            Use <span className="font-medium text-mm-text">Backup now</span> before a big change
            for an extra fresh snapshot.
          </PopoverContent>
        </Popover>
      </p>

      {/* Status line — freshness + next-auto */}
      <div className="mb-4" aria-live="polite">
        {status?.last_backup_at ? (
          <p className="text-sm text-mm-text-muted">
            Last backup: <span className="text-mm-text">{formatRelativeTime(status.last_backup_at)}</span>
            {status.next_backup_at && (
              <>
                {' · '}
                Next automatic backup at{' '}
                <span className="text-mm-text">{formatNextTime(status.next_backup_at)}</span>
              </>
            )}
            {status.backup_count > 0 && (
              <span className="ml-2 text-mm-text-faint">
                ({status.backup_count} backup{status.backup_count !== 1 ? 's' : ''}, {formatBytes(status.total_size_bytes)})
              </span>
            )}
          </p>
        ) : (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            No backups yet. Use Backup now to create your first snapshot.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 mb-4">
        {/* #357: primary action — fresh snapshot without download. Resets
          * the displayed `next_backup_at` because the new file's mtime is
          * the most recent. */}
        <Button
          variant="default"
          size="sm"
          onClick={() => backupNowMutation.mutate()}
          disabled={backupNowMutation.isPending}
          aria-busy={backupNowMutation.isPending}
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
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? (
            <LoaderCircle className="w-3.5 h-3.5 mr-1.5 animate-spin" />
          ) : (
            <Download className="w-3.5 h-3.5 mr-1.5" />
          )}
          {createMutation.isPending ? 'Creating...' : 'Download Backup'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={validateMutation.isPending || restoreMutation.isPending}
        >
          {validateMutation.isPending ? (
            <LoaderCircle className="w-3.5 h-3.5 mr-1.5 animate-spin" />
          ) : (
            <FileInput className="w-3.5 h-3.5 mr-1.5" />
          )}
          {validateMutation.isPending ? 'Validating...' : 'Restore from Backup'}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".mmbackup"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {/* Backup history */}
      <button
        onClick={() => setShowHistory(v => !v)}
        className="flex items-center gap-1 text-xs text-mm-text-muted hover:text-mm-text transition-colors"
      >
        {showHistory ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        Backup history
      </button>

      {showHistory && backups && (
        <div className="mt-2 space-y-1">
          {backups.length === 0 ? (
            <p className="text-xs text-mm-text-faint py-1">No backups found</p>
          ) : (
            backups.map(b => (
              <div key={b.filename} className="flex items-center gap-2 text-xs text-mm-text-muted py-0.5">
                <span className="inline-block px-1.5 py-0.5 rounded bg-mm-bg text-mm-text-faint text-[10px] font-medium min-w-[70px] text-center">
                  {BACKUP_TYPE_LABELS[b.backup_type] || b.backup_type}
                </span>
                <span className="flex-1 truncate">{b.filename}</span>
                <span className="tabular-nums shrink-0">{formatBytes(b.size_bytes)}</span>
                <span className="tabular-nums shrink-0">{formatRelativeTime(b.created_at)}</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Restore confirmation dialog */}
      <AlertDialog open={restorePreview !== null} onOpenChange={(open) => { if (!open) handleCancelRestore() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore from Backup</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This will replace all current data with the contents of this backup.
                  A safety backup will be created automatically before restoring.
                </p>

                {restorePreview && (
                  <div className="rounded-md border border-mm-border-subtle bg-mm-bg p-3 text-sm space-y-2">
                    <div className="flex justify-between">
                      <span className="text-mm-text-muted">Created</span>
                      <span className="text-mm-text">
                        {new Date(restorePreview.manifest.created_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-mm-text-muted">App version</span>
                      <span className="text-mm-text">{restorePreview.manifest.app_version}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-mm-text-muted">Database size</span>
                      <span className="text-mm-text">{formatBytes(restorePreview.manifest.db_size_bytes)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-mm-text-muted">Documents</span>
                      <span className="text-mm-text">{restorePreview.manifest.document_count}</span>
                    </div>
                    {restorePreview.manifest.project_summaries.length > 0 && (
                      <div>
                        <span className="text-mm-text-muted text-xs">Projects:</span>
                        <ul className="mt-1 space-y-0.5">
                          {restorePreview.manifest.project_summaries.map((p, i) => (
                            <li key={i} className="text-mm-text text-xs">
                              {p.name}
                              <span className="text-mm-text-faint ml-1">
                                ({p.conversation_count} conv, {p.dataset_count} ds, {p.document_count} doc)
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {restorePreview.warnings.length > 0 && (
                      <div className="rounded border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-2 space-y-1">
                        {restorePreview.warnings.map((w, i) => (
                          <p key={i} className="text-xs text-amber-800 dark:text-amber-300">{w}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoreMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmRestore}
              disabled={restoreMutation.isPending}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {restoreMutation.isPending ? (
                <>
                  <LoaderCircle className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  Restoring...
                </>
              ) : (
                'Restore'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}


function CoderIdentitySection() {
  const { user, refreshAuth } = useAuth()
  const [name, setName] = useState(user?.username ?? '')
  const [error, setError] = useState('')

  const mutation = useMutation({
    mutationFn: (newName: string) => authApi.updateProfile(newName),
    onSuccess: async () => {
      setError('')
      await refreshAuth()
      toast.success('Coder name updated')
    },
    onError: (err: Error & { response?: { data?: { detail?: string } } }) => {
      setError(err.response?.data?.detail || 'Could not update coder name')
    },
  })

  const trimmed = name.trim()
  const dirty = trimmed.length > 0 && trimmed !== user?.username

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty) return
    mutation.mutate(trimmed)
  }

  return (
    <section className="rounded-lg border border-mm-surface-border bg-mm-surface shadow-mm-card p-4">
      <h2 className="text-base font-semibold text-mm-text mb-1">Coder identity</h2>
      <p className="text-xs text-mm-text-muted mb-4">
        Your coding is attributed to this name. Mixed Measures is a local, single-user
        tool — there is no account or password.
      </p>
      <form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
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
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
        <Button type="submit" size="sm" disabled={!dirty || mutation.isPending}>
          {mutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </form>
    </section>
  )
}
