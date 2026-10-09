/**
 * #971 — how a backup is described to the researcher.
 *
 * A `.mmbackup` is a snapshot of the whole install: the database, the documents
 * and the recordings. Five of them sit in a list that differ only by when they
 * were taken and why, and restoring one replaces everything — so these are the
 * words that list, its delete confirmation and its accessible names share, and
 * they live beside `lib/safety-copies.ts`, which does the same job for the other
 * list on that screen.
 */
import type { BackupInfo, BackupStatus } from '@/lib/api'

/**
 * #1043 — the automatic schedule in the words the Backup & Data section uses.
 *
 * The section said "a separate 4-hourly safety snapshot … every 4 hours, keeping the
 * 5 most recent" whatever `MM_AUTO_BACKUP_INTERVAL_HOURS` / `…_MAX_COUNT` held — and
 * `0` hours now turns automatic backups OFF, where those sentences would promise a
 * snapshot that never comes. The server states the install's values; until it
 * answers (or from a server that predates the fields) the sentences carry NO number
 * rather than the default stated as this install's fact (#961's rule).
 */
export function scheduleSentences(
  status: Pick<BackupStatus, 'auto_backup_interval_hours' | 'auto_backup_max_count'> | undefined,
): { off: boolean; intro: string; detail: string } {
  const hours = status?.auto_backup_interval_hours ?? null
  const keep = status?.auto_backup_max_count ?? null
  if (hours === 0) {
    return {
      off: true,
      intro:
        'Your edits save to disk instantly. Automatic backups are turned off on this ' +
        'installation, so a backup is taken when you ask for one.',
      detail:
        'Backups are a separate safety net from saving. Automatic snapshots are turned off ' +
        'on this installation, so take one with Backup now, or download one, before a big change.',
    }
  }
  const cadence = hours === null ? '' : hours === 1 ? 'hourly ' : `${hours}-hourly `
  const every = hours === null ? 'on a schedule' : hours === 1 ? 'every hour' : `every ${hours} hours`
  const keeping = keep === null ? 'keeping the most recent ones' : `keeping the ${keep} most recent`
  return {
    off: false,
    intro: `Your edits save to disk instantly; backups are a separate ${cadence}safety snapshot.`,
    detail:
      'Every edit is saved to disk the moment you make it — your work isn’t waiting in ' +
      'memory anywhere. Backups are a separate safety net: Mixed Measures takes a snapshot of ' +
      `the database, documents, and audio ${every}, ${keeping} so you can recover from disk ` +
      'corruption or accidental deletion.',
  }
}

/**
 * What each kind of backup IS, in words a researcher can choose between.
 *
 * 🔴 **These labels became load-bearing when the rows gained a Restore button.**
 * Until then a wrong one was cosmetic. Two could never match: the server derived
 * the type with `split("_", 1)[0]`, so `pre_restore` and `pre_withdrawal` both
 * arrived as `"pre"` — and the map's old `pre_migration` key describes a raw
 * `.db` copy that is not in this list at all. The server half is fixed; this is
 * the reader's.
 *
 * ⚠️ The description carries as much as the name. "Automatic" and "On quit" are
 * both automatic; which to roll back to depends on knowing that one spans the
 * working day and the other is where you left off.
 */
export const BACKUP_TYPE_LABELS: Record<string, { label: string; description: string }> = {
  manual: { label: 'Downloaded', description: 'you downloaded a copy' },
  // #1043: no number — the schedule is the install's (`MM_AUTO_BACKUP_INTERVAL_HOURS`),
  // and Backup & Data states it from the server.
  // #1132: *Backup now* writes this type too (it is the rotation key, ISSUES
  // archive's "REFUTED as a naming bug"), so "on the automatic schedule" alone
  // was false of every backup taken by hand — and of all of them with the
  // schedule turned off.
  auto: { label: 'Automatic', description: 'taken on the automatic schedule or with Backup now' },
  shutdown: { label: 'On quit', description: 'taken when Mixed Measures last closed' },
  pre_restore: { label: 'Before a restore', description: 'your data as it was before a restore' },
  pre_withdrawal: {
    label: 'Before a withdrawal',
    description: 'your data as it was before a participant was removed',
  },
}

/**
 * A backup's words.
 *
 * ⚠️ A type the server sends that this map does not know is a FUTURE type, not a
 * broken one — "Backup" is true of it, where a raw `pre_withdrawal` on screen is
 * not a sentence. Deliberately NOT a `satisfies Record<…>` over a union: the wire
 * field is a plain string, and the failure mode worth designing for is a newer
 * server, not a typo.
 */
export function describeBackup(backup: Pick<BackupInfo, 'backup_type'>) {
  return BACKUP_TYPE_LABELS[backup.backup_type] ?? { label: 'Backup', description: 'a saved snapshot' }
}

/**
 * Is this the only backup of its kind left?
 *
 * The kinds are not interchangeable: `pre_restore` is the state before a restore
 * and `pre_withdrawal` the state before a person's data was removed, and neither
 * is replaced by tomorrow's 4-hourly snapshot. "You still have four others" is
 * the wrong reassurance when those four are a different kind.
 *
 * ⚠️ **False when the list is not in hand.** An absent list is not evidence that
 * there is exactly one, and a warning shown on that basis is a claim made from an
 * unanswered query (#961). The direction matters: under-warning costs a sentence,
 * over-warning trains the researcher to ignore the one that is true.
 */
export function isLastOfItsKind(
  backup: Pick<BackupInfo, 'backup_type'>,
  backups: BackupInfo[] | undefined,
): boolean {
  if (!backups) return false
  return backups.filter(b => b.backup_type === backup.backup_type).length === 1
}

/** The name every control in a row carries, so two backups are never confused.
 *
 * 🔴 To the SECOND, for the reason `formatTakenAt` records: at minute precision
 * the sixth a11y-name-sweep run measured 159 Delete buttons in the sibling list
 * sharing a name with another. Here the act is a restore, which replaces
 * everything — a column of buttons all announcing "Restore" is both unusable and
 * dangerous.
 */
export function backupRowName(backup: BackupInfo, takenAt: string): string {
  return `the ${backupTitle(backup, takenAt)}`
}

/**
 * #1132 — a backup's name inside a sentence: `“Before a restore” backup from …`.
 *
 * The ONE builder for it: the row controls, the delete confirmation and the
 * restore dialog (Settings' `RestoreSource.name`) each composed their own, and
 * lower-cased or bare it read "Restore from the before a restore backup from …",
 * "the contents of Before a restore backup from …" — three of the five labels
 * are phrases, not adjectives. Quoted, it is the restored view's own wording
 * (*as the “Before a restore” backup from …*).
 */
export function backupTitle(backup: Pick<BackupInfo, 'backup_type'>, takenAt: string): string {
  return `“${describeBackup(backup).label}” backup from ${takenAt}`
}
